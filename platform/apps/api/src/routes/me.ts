import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  contactEndpointRepo,
  graphRepo,
  householdRepo,
  identityRepo,
  messagingEventRepo,
  type Db,
} from "@atelier/db";
import type { ActorType, HouseholdId } from "@atelier/domain";

// /me — whoami, plus token management for the current actor.
//
// GET  /me                     resolved actor
// GET  /me/tokens              tokens owned by this actor (metadata)
// POST /me/tokens/rotate       revoke the current token, mint a new one
// POST /me/tokens/:tokenId/revoke   explicit revoke

const RotateBody = z
  .object({
    ttlSeconds: z.number().int().positive().max(365 * 24 * 60 * 60).optional(),
  })
  .default({});

export const meRoutes = (db: Db): FastifyPluginAsync => async (app) => {
  const identity = identityRepo(db);

  app.get("/me", async (req) => ({ actor: req.actor }));

  app.get("/me/tokens", async (req) => ({
    tokens: identity.listTokens(req.actor.type as ActorType, req.actor.id),
  }));

  app.post("/me/tokens/rotate", async (req, reply) => {
    if (!req.tokenId) {
      return reply.code(400).send({
        error: "no_token_context",
        message: "Rotate requires an authenticated bearer token.",
      });
    }
    const parsed = RotateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const rotated = identity.rotateToken(
      req.tokenId,
      parsed.data.ttlSeconds !== undefined
        ? { ttlSeconds: parsed.data.ttlSeconds }
        : {},
    );
    if (!rotated) return reply.code(404).send({ error: "not_found" });
    return reply.code(201).send({
      token: rotated.token,
      tokenId: rotated.tokenId,
      expiresAt: rotated.expiresAt,
      note: "Copy this token — it is shown once and never again.",
    });
  });

  app.post<{ Params: { tokenId: string } }>(
    "/me/tokens/:tokenId/revoke",
    async (req, reply) => {
      // A caller may only revoke their own tokens. Enforced by
      // checking the target token belongs to the same actor.
      const tokens = identity.listTokens(
        req.actor.type as ActorType,
        req.actor.id,
      );
      const owned = tokens.find((t) => t.id === req.params.tokenId);
      if (!owned) return reply.code(404).send({ error: "not_found" });
      identity.revokeToken(req.params.tokenId);
      return reply.code(204).send();
    },
  );

  // /me/attention — cross-household attention feed for a
  // manager running 3-10 households in parallel. Aggregates
  // across every household the calling manager has a live
  // grant on. Approvals stay on their own /me/approvals
  // endpoint — the dashboard fetches both and stacks them.
  //
  // Four attention kinds today:
  //   delivery_failure — an outbound we sent that Twilio marked
  //     failed or undelivered in the last 24h. Something we did
  //     didn't reach the customer; needs manager triage.
  //   unread_thread — an inbound in the last 24h with no
  //     subsequent outbound to that endpoint since. Customer
  //     said something and nobody's replied.
  //   upcoming_obligation — an obligation.deadline node whose
  //     dueAt lands in the next 14 days. Proactive nudge.
  //   frozen_household — the household is frozen; every agent
  //     action is shelved until unblocked.
  //
  // Ranked delivery-failure first, then unread threads, then
  // upcoming obligations. Each entry carries the household id +
  // name so the dashboard can render the drill-down link.
  const attentionEndpoint = async (req: {
    actor: { type: string; householdIds: readonly string[] };
  }): Promise<{
    generatedAt: string;
    items: readonly {
      kind:
        | "delivery_failure"
        | "unread_thread"
        | "upcoming_obligation"
        | "frozen_household";
      householdId: string;
      householdName: string;
      sortAt: string;
      summary: string;
      detail: Record<string, unknown>;
    }[];
    counts: {
      deliveryFailures: number;
      unreadThreads: number;
      upcomingObligations: number;
      frozenHouseholds: number;
    };
  }> => {
    if (req.actor.type !== "manager") {
      return {
        generatedAt: new Date().toISOString(),
        items: [],
        counts: {
          deliveryFailures: 0,
          unreadThreads: 0,
          upcomingObligations: 0,
          frozenHouseholds: 0,
        },
      };
    }
    const households = householdRepo(db);
    const events = messagingEventRepo(db);
    const endpoints = contactEndpointRepo(db);
    const graph = graphRepo(db);

    const nowIso = new Date().toISOString();
    const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const fortnightMs = 14 * 24 * 60 * 60 * 1000;

    const items: {
      kind: "delivery_failure" | "unread_thread" | "upcoming_obligation" | "frozen_household";
      householdId: string;
      householdName: string;
      sortAt: string;
      summary: string;
      detail: Record<string, unknown>;
    }[] = [];
    const counts = {
      deliveryFailures: 0,
      unreadThreads: 0,
      upcomingObligations: 0,
      frozenHouseholds: 0,
    };

    for (const rawHh of req.actor.householdIds) {
      const hh = households.get(rawHh as HouseholdId);
      if (!hh) continue;
      const hhName = hh.name;

      // Frozen households: a single top-of-list item per frozen
      // household. Everything else about a frozen household is
      // already suppressed at the agent layer; the manager needs
      // to know they need to unfreeze (or that the freeze is
      // still legitimate).
      if (hh.frozenAt) {
        counts.frozenHouseholds++;
        items.push({
          kind: "frozen_household",
          householdId: hh.id,
          householdName: hhName,
          sortAt: hh.frozenAt,
          summary: `${hhName} is frozen${hh.frozenReason ? ` — ${hh.frozenReason}` : ""}`,
          detail: {
            frozenAt: hh.frozenAt,
            frozenReason: hh.frozenReason ?? null,
          },
        });
      }

      // Recent outbound + inbound to compute both delivery
      // failures and unread threads in one pass.
      const recent = events.list(hh.id as HouseholdId, 200);
      const lastOutboundByEndpoint = new Map<string, string>();
      for (const e of recent) {
        if (e.direction === "outbound" && e.endpointId) {
          const prev = lastOutboundByEndpoint.get(e.endpointId);
          if (!prev || e.receivedAt > prev) {
            lastOutboundByEndpoint.set(e.endpointId, e.receivedAt);
          }
        }
      }

      const epIndex = new Map(
        endpoints.list(hh.id as HouseholdId).map((ep) => [ep.id, ep]),
      );

      for (const e of recent) {
        if (e.receivedAt < dayAgoIso) continue;

        if (e.direction === "outbound") {
          const status = e.deliveryStatus;
          if (status === "failed" || status === "undelivered") {
            counts.deliveryFailures++;
            const ep = e.endpointId ? epIndex.get(e.endpointId) : null;
            items.push({
              kind: "delivery_failure",
              householdId: hh.id,
              householdName: hhName,
              sortAt: e.deliveryStatusAt ?? e.receivedAt,
              summary: `Send to ${ep?.address ?? e.toAddress} ${status}${e.deliveryErrorCode ? ` (${e.deliveryErrorCode})` : ""}`,
              detail: {
                eventId: e.id,
                endpointId: e.endpointId,
                to: e.toAddress,
                body: e.body.length > 120 ? `${e.body.slice(0, 120)}…` : e.body,
                deliveryStatus: status,
                deliveryErrorCode: e.deliveryErrorCode,
                authoredByType: e.authoredByType,
                authoredByLabel: e.authoredByLabel,
              },
            });
          }
        } else if (e.direction === "inbound" && e.endpointId) {
          const lastOut = lastOutboundByEndpoint.get(e.endpointId);
          // Unread if we haven't sent anything to this endpoint
          // since the customer's message landed.
          if (!lastOut || lastOut < e.receivedAt) {
            counts.unreadThreads++;
            const ep = epIndex.get(e.endpointId);
            items.push({
              kind: "unread_thread",
              householdId: hh.id,
              householdName: hhName,
              sortAt: e.receivedAt,
              summary: `${ep?.address ?? e.fromAddress}: ${e.body.length > 80 ? `${e.body.slice(0, 80)}…` : e.body}`,
              detail: {
                eventId: e.id,
                endpointId: e.endpointId,
                principalId: ep?.principalId ?? null,
                from: e.fromAddress,
                body: e.body,
                channel: e.channel,
              },
            });
          }
        }
      }

      // Upcoming obligations in the next 14 days.
      const now = Date.now();
      const soonest: {
        id: string;
        dueAt: string;
        title: string;
        daysLeft: number;
      }[] = [];
      for (const n of graph.listNodes(hh.id as HouseholdId, {
        type: "obligation.deadline",
      })) {
        const d = n.data as { dueAt?: string; title?: string };
        if (!d.dueAt) continue;
        const due = Date.parse(d.dueAt);
        if (!Number.isFinite(due)) continue;
        if (due - now > fortnightMs) continue;
        if (due < now - 30 * 24 * 60 * 60 * 1000) continue; // ignore months-old overdue for now
        soonest.push({
          id: n.id,
          dueAt: d.dueAt,
          title: d.title ?? "(untitled)",
          daysLeft: Math.round((due - now) / (24 * 60 * 60 * 1000)),
        });
      }
      soonest.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      for (const s of soonest) {
        counts.upcomingObligations++;
        items.push({
          kind: "upcoming_obligation",
          householdId: hh.id,
          householdName: hhName,
          sortAt: s.dueAt,
          summary: `${s.title} — due in ${s.daysLeft}d`,
          detail: {
            nodeId: s.id,
            dueAt: s.dueAt,
            daysLeft: s.daysLeft,
          },
        });
      }
    }

    // Rank order: delivery_failure > unread_thread > upcoming_obligation > frozen_household.
    // Within a kind, sortAt desc for reactive items (customer
    // waiting / delivery broken NOW) and asc for proactive
    // (obligation dueAt) so what's due soonest floats up.
    const kindRank: Record<string, number> = {
      delivery_failure: 0,
      frozen_household: 1,
      unread_thread: 2,
      upcoming_obligation: 3,
    };
    items.sort((a, b) => {
      if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind]! - kindRank[b.kind]!;
      if (a.kind === "upcoming_obligation") return a.sortAt.localeCompare(b.sortAt);
      return b.sortAt.localeCompare(a.sortAt);
    });

    return {
      generatedAt: nowIso,
      items,
      counts,
    };
  };

  app.get("/me/attention", async (req) => attentionEndpoint(req));
};

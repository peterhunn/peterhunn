import { z } from "zod";
import type { Agent, AgentContext, AgentTaskOutput, Intent } from "../types.js";

// Admin agent — handles the paperwork that piles up. Two intents so
// far:
//
//   admin.renewals.review — scans the graph for document.* nodes with
//     an upcoming expiresAt, classifies each via a single T1 batch
//     call, writes a follow-up obligation.deadline candidate per
//     item, and returns a summary. This is the "detect a renewal
//     before it lapses" workflow from operating-plan.md's SOP list.
//
//   admin.form.fill — placeholder for a future workflow. Not
//     implemented yet; the agent escalates so the manager can act
//     manually.

export const RenewalsReviewAttrs = z.object({
  windowDays: z.number().int().positive().max(365).optional(),
});

const NAME = "admin";
const VERSION = "0.1.0";

interface ExpiringItem {
  id: string;
  type: string;
  title: string;
  category: string;
  expiresAt: string;
  daysUntilExpiry: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const readExpiring = (
  ctx: AgentContext,
  windowDays: number,
): ExpiringItem[] => {
  const now = Date.now();
  const cutoff = now + windowDays * DAY_MS;
  const items: ExpiringItem[] = [];
  for (const n of ctx.graph.listNodes()) {
    if (!n.type.startsWith("document.")) continue;
    const expiresAtVal = n.data["expiresAt"];
    if (typeof expiresAtVal !== "string") continue;
    const expiresAtMs = Date.parse(expiresAtVal);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > cutoff) continue;
    if (expiresAtMs < now - 30 * DAY_MS) continue; // already lapsed too long ago
    items.push({
      id: n.id,
      type: n.type,
      title: String(n.data["title"] ?? n.data["label"] ?? "Untitled document"),
      category: String(n.data["category"] ?? "record"),
      expiresAt: expiresAtVal,
      daysUntilExpiry: Math.round((expiresAtMs - now) / DAY_MS),
    });
  }
  items.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  return items;
};

const parseClassificationJson = (
  raw: string,
): { items?: Array<{ id?: string; urgency?: string; recommendedAction?: string }>; summary?: string } => {
  const jsonMatch = raw.match(/\{[\s\S]*\}$/) ?? raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};
  try {
    return JSON.parse(jsonMatch[0]) as {
      items?: Array<{ id?: string; urgency?: string; recommendedAction?: string }>;
      summary?: string;
    };
  } catch {
    return {};
  }
};

export const adminAgent: Agent = {
  name: NAME,
  version: VERSION,

  handles(intent: Intent): boolean {
    return (
      intent.kind === "admin.renewals.review" ||
      intent.kind === "admin.form.fill"
    );
  },

  async handle(intent: Intent, ctx: AgentContext): Promise<AgentTaskOutput> {
    if (intent.kind === "admin.form.fill") {
      return {
        state: "escalated",
        decisionSummary: "admin.form.fill not yet implemented; escalating to manager.",
        outputs: { intent: intent.attrs },
      };
    }

    const parsed = RenewalsReviewAttrs.safeParse(intent.attrs);
    if (!parsed.success) {
      return {
        state: "failed",
        errorMessage: `Invalid intent attrs: ${parsed.error.message}`,
      };
    }
    const windowDays = parsed.data.windowDays ?? 60;
    const expiring = readExpiring(ctx, windowDays);

    if (expiring.length === 0) {
      return {
        state: "completed",
        decisionSummary: `No document renewals due in the next ${windowDays} days.`,
        outputs: { windowDays, expiring: [] },
      };
    }

    // One T1 batch classification for the whole list. Cheaper and more
    // consistent than one call per item; the model sees the full set
    // and can produce coherent urgency ranking.
    const modelRes = await ctx.callModel({
      taskClass: "admin.renewal.detect",
      messages: [
        {
          role: "system",
          content:
            "You are the ATELIER Admin agent. Given a list of documents nearing expiry, return JSON: { summary, items: [{id, urgency: low|normal|high, recommendedAction}] }. Recommended actions should be short imperative phrases (e.g., 'renew passport', 'confirm auto-renew', 'schedule appointment').",
          cache: true,
        },
        {
          role: "user",
          content: JSON.stringify({
            windowDays,
            items: expiring.map((i) => ({
              id: i.id,
              type: i.type,
              title: i.title,
              category: i.category,
              expiresAt: i.expiresAt,
              daysUntilExpiry: i.daysUntilExpiry,
            })),
          }),
        },
      ],
      maxOutputTokens: 800,
    });

    const parsedClassification = parseClassificationJson(modelRes.content);
    const perItem = new Map<string, { urgency: string; recommendedAction: string }>();
    for (const c of parsedClassification.items ?? []) {
      if (c.id && c.recommendedAction) {
        perItem.set(c.id, {
          urgency: c.urgency ?? "normal",
          recommendedAction: c.recommendedAction,
        });
      }
    }

    // Write one follow-up obligation.deadline per expiring item. Each
    // as a candidate (confidence 0.7) pointing back to the source
    // document via sourceRef.
    const writtenIds: string[] = [];
    for (const item of expiring) {
      const c = perItem.get(item.id);
      const action = c?.recommendedAction ?? `Handle renewal of "${item.title}"`;
      const dueAt = new Date(
        Math.min(
          Date.parse(item.expiresAt) - 14 * DAY_MS,
          Date.now() + 30 * DAY_MS,
        ),
      ).toISOString();
      const written = ctx.writer.writeNode({
        type: "obligation.deadline",
        data: {
          title: action,
          dueAt,
          category: "renewal",
          notes: `Detected by admin agent from ${item.type}: ${item.title} (expires ${item.expiresAt})`,
        },
        status: "candidate",
        confidence: 0.7,
        sourceRef: item.id,
      });
      writtenIds.push(written.id);
    }

    const summary =
      parsedClassification.summary ??
      `${expiring.length} document${expiring.length === 1 ? "" : "s"} nearing expiry in the next ${windowDays} days; follow-up obligations queued.`;

    return {
      state: "completed",
      decisionSummary: summary,
      outputs: {
        windowDays,
        expiring: expiring.map((i) => ({
          ...i,
          urgency: perItem.get(i.id)?.urgency ?? "normal",
          recommendedAction: perItem.get(i.id)?.recommendedAction ?? "Handle renewal.",
        })),
        obligationIdsWritten: writtenIds,
        summary,
      },
    };
  },
};

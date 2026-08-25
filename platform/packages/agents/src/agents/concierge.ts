import { z } from "zod";
import type { Agent, AgentContext, AgentTaskOutput, Intent } from "../types.js";

// Concierge agent — owns customer-facing SMS replies on the
// concierge line. Sits between the planner and sms.send: reads
// the customer's most recent message plus prior conversation
// turns, drafts a reply via a T2 model call, and hands the draft
// to sms.send. The policy engine gates the send (communication
// side effect defaults to `ask`), so the manager sees the draft
// in the approval queue unless a household policy explicitly
// promotes agent-authored SMS to `execute`.
//
// This is the agent counterpart of the manager's Reply button:
// same outbound path, same messaging_events record, same
// conversation-session attachment — just authored by an agent
// instead of a person.

export const ConciergeReplyAttrs = z.object({
  channel: z.enum(["sms", "whatsapp"]).default("sms"),
  toAddress: z.string().min(3),
  currentMessage: z.string().min(1),
  fromName: z.string().optional(),
  priorTurns: z
    .array(
      z.object({
        role: z.enum(["customer", "agent"]),
        content: z.string(),
      }),
    )
    .optional(),
  // Optional hint from the planner about what the reply should
  // accomplish (e.g. "confirm the reschedule", "ack and defer to
  // manager"). Absent = the agent figures it out from context.
  goal: z.string().optional(),
});

const NAME = "concierge";
const VERSION = "0.1.0";

interface DraftReply {
  reply: string;
  escalate?: boolean;
  escalateReason?: string;
}

const tryParseJson = <T>(s: string): T | null => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

// Grab the first JSON object out of a possibly-noisy model
// response. Mirrors the tolerant parser in planner.ts.
const extractJson = <T>(s: string): T | null => {
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return tryParseJson<T>(s.slice(first, last + 1));
};

export const conciergeAgent: Agent = {
  name: NAME,
  version: VERSION,

  handles(intent: Intent): boolean {
    return intent.kind === "concierge.reply";
  },

  async handle(intent: Intent, ctx: AgentContext): Promise<AgentTaskOutput> {
    const parsed = ConciergeReplyAttrs.safeParse(intent.attrs);
    if (!parsed.success) {
      return {
        state: "failed",
        errorMessage: `Invalid concierge.reply attrs: ${parsed.error.message}`,
      };
    }
    const attrs = parsed.data;

    // Draft the reply.
    const contextLines: string[] = [];
    contextLines.push(
      `Recipient: ${attrs.fromName ?? attrs.toAddress} (${attrs.channel} at ${attrs.toAddress})`,
    );
    if (attrs.goal) contextLines.push(`Goal: ${attrs.goal}`);
    if (attrs.priorTurns && attrs.priorTurns.length > 0) {
      contextLines.push("Prior turns (oldest first):");
      for (const t of attrs.priorTurns) {
        contextLines.push(`  ${t.role}: ${t.content}`);
      }
    }
    contextLines.push(`Current customer message: ${attrs.currentMessage}`);

    const modelRes = await ctx.callModel({
      taskClass: "concierge.reply.draft",
      messages: [
        {
          role: "system",
          content: [
            "You are the ATELIER concierge — the voice a customer sees when they text the household's shared number.",
            "Reply in one to three short sentences. Warm, direct, no filler. Never invent facts about the household; if you need info you don't have, escalate.",
            "You represent a service that runs a household on the customer's behalf. Don't ask the customer to do work the service should do. Don't offer to send links, forms, or portals unless a prior turn established that path.",
            "If the customer's message is a task you cannot handle safely from context alone (financial commitment, complex booking, legal/medical), set escalate: true with a one-line reason and leave reply as a brief holding message.",
            "Return JSON only: { reply: string, escalate?: boolean, escalateReason?: string }.",
          ].join(" "),
          cache: true,
        },
        {
          role: "user",
          content: contextLines.join("\n"),
        },
      ],
      maxOutputTokens: 400,
    });

    const draft =
      extractJson<DraftReply>(modelRes.content) ??
      tryParseJson<DraftReply>(modelRes.content) ??
      // Last-resort fallback: use the raw content as the reply.
      { reply: modelRes.content.trim().slice(0, 480) };

    if (draft.escalate) {
      // Don't call the send tool at all — the manager should
      // handle it. Task lands as `escalated`; the manager sees
      // the draft (if any) and the reason in the console.
      return {
        state: "escalated",
        decisionSummary:
          draft.escalateReason ??
          "Concierge escalated — outside safe autonomous scope.",
        outputs: {
          channel: attrs.channel,
          toAddress: attrs.toAddress,
          drafted: draft.reply,
          escalateReason: draft.escalateReason ?? null,
        },
      };
    }

    const trimmed = draft.reply.trim().slice(0, 1600);
    if (!trimmed) {
      return {
        state: "failed",
        errorMessage: "Concierge produced an empty reply.",
      };
    }

    // Hand the draft to sms.send. The policy engine sits between
    // this call and the actual Twilio POST — a `communication`
    // side-effect action defaults to `ask` autonomy, so unless a
    // household policy specifically allows agent-authored SMS to
    // execute, the send lands in the approval queue and returns
    // decision.decision === "customer_approval" / "manager_review".
    const result = await ctx.invokeTool<
      { channel: "sms" | "whatsapp"; to: string; body: string },
      {
        sentMessageId: string;
        sentAt: string;
        provider: "twilio" | "mock";
        to: string;
        from: string;
        refused?: "opted_out";
      }
    >(
      "sms.send",
      { channel: attrs.channel, to: attrs.toAddress, body: trimmed },
      { summary: `Reply on ${attrs.channel} to ${attrs.toAddress}` },
    );

    const decision = result.decision.decision;
    if (decision === "denied") {
      return {
        state: "rejected",
        decisionSummary:
          "Reply denied by policy — household disallows agent-authored SMS.",
        outputs: {
          channel: attrs.channel,
          toAddress: attrs.toAddress,
          drafted: trimmed,
          policyDecision: decision,
        },
      };
    }
    if (decision !== "auto_execute") {
      // customer_approval / manager_review — reply queued in
      // the approval inbox with the drafted body attached.
      // proposing_action is the closest task state for
      // "drafted; queued for human approval."
      return {
        state: "proposing_action",
        decisionSummary: `Reply drafted; ${decision.replace("_", " ")} required before send.`,
        outputs: {
          channel: attrs.channel,
          toAddress: attrs.toAddress,
          drafted: trimmed,
          policyDecision: decision,
          approvalId: result.approvalId,
        },
      };
    }

    if (result.outputs?.refused === "opted_out") {
      return {
        state: "failed",
        decisionSummary: "Reply refused — recipient opted out.",
        outputs: {
          channel: attrs.channel,
          toAddress: attrs.toAddress,
          drafted: trimmed,
          refused: "opted_out",
        },
      };
    }

    return {
      state: "completed",
      decisionSummary: `Sent ${attrs.channel} reply to ${attrs.toAddress} (${result.outputs?.provider ?? "unknown"}).`,
      outputs: {
        channel: attrs.channel,
        toAddress: attrs.toAddress,
        sent: {
          provider: result.outputs?.provider,
          sentMessageId: result.outputs?.sentMessageId,
          from: result.outputs?.from,
        },
        body: trimmed,
      },
    };
  },
};

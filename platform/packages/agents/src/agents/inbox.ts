import { z } from "zod";
import type { Agent, AgentContext, AgentTaskOutput, Intent } from "../types.js";

// Inbox agent — the first agent whose whole job depends on the router.
// Triages via a T1 call, extracts obligations via a T1 call, drafts a
// reply via T2 (or T3 for sensitive recipients), and proposes
// message.send. The send tool sits at the communication side-effect
// class, so policy will almost always demote to draft/ask and the
// drafted reply lands in the approval queue for a human to review.

export const ProcessMessageAttrs = z.object({
  messageId: z.string(),
  fromName: z.string(),
  fromAddress: z.string(),
  subject: z.string(),
  body: z.string(),
  receivedAt: z.string().datetime().optional(),
});

const NAME = "inbox";
const VERSION = "0.1.0";

const SENSITIVE = new Set(["counsel", "medical", "employer"]);

const tryParseJson = <T>(s: string): T | null => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export const inboxAgent: Agent = {
  name: NAME,
  version: VERSION,

  handles(intent: Intent): boolean {
    return intent.kind === "inbox.message.process";
  },

  async handle(intent: Intent, ctx: AgentContext): Promise<AgentTaskOutput> {
    const parsed = ProcessMessageAttrs.safeParse(intent.attrs);
    if (!parsed.success) {
      return {
        state: "failed",
        errorMessage: `Invalid intent attrs: ${parsed.error.message}`,
      };
    }
    const msg = parsed.data;
    const outputs: Record<string, unknown> = { messageId: msg.messageId };

    // Triage (T1).
    const triageRes = await ctx.callModel({
      taskClass: "inbox.triage",
      messages: [
        {
          role: "system",
          content:
            "Classify an inbound message. Return JSON: {urgency: low|normal|high, recipientClass, requiresReply: yes|no, notes}.",
        },
        {
          role: "user",
          content: `From: ${msg.fromName} <${msg.fromAddress}>\nSubject: ${msg.subject}\n\n${msg.body}`,
        },
      ],
      maxOutputTokens: 200,
    });
    type Triage = {
      urgency: string;
      recipientClass: string;
      requiresReply: "yes" | "no" | "unknown";
      notes?: string;
    };
    const triage: Triage =
      tryParseJson<Triage>(triageRes.content) ?? {
        urgency: "normal",
        recipientClass: "other",
        requiresReply: "unknown",
      };
    outputs["triage"] = triage;

    // Extract (T1) — obligations get written back to the graph as
    // candidates. Manager review promotes them per the learning rules.
    const extractRes = await ctx.callModel({
      taskClass: "inbox.extract",
      messages: [
        {
          role: "system",
          content:
            "Extract obligations from an inbound message. Return JSON: {obligations: [{title, category, dueHint?}]}.",
        },
        {
          role: "user",
          content: `Subject: ${msg.subject}\n\n${msg.body}`,
        },
      ],
      maxOutputTokens: 400,
    });
    type Extraction = {
      obligations?: Array<{ title: string; category?: string; dueHint?: string }>;
    };
    const extraction = tryParseJson<Extraction>(extractRes.content) ?? { obligations: [] };
    const writtenObligationIds: string[] = [];
    for (const o of extraction.obligations ?? []) {
      const written = ctx.writer.writeNode({
        type: "obligation.deadline",
        data: {
          title: o.title,
          dueAt: parseDueHint(o.dueHint) ?? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
          category: (o.category as never) ?? "personal",
          notes: `Extracted from inbox message ${msg.messageId}: ${msg.subject}`,
        },
        status: "candidate",
        confidence: 0.6,
        sourceRef: msg.messageId,
      });
      writtenObligationIds.push(written.id);
    }
    outputs["extractedObligationIds"] = writtenObligationIds;

    if (triage.requiresReply !== "yes") {
      return {
        state: "completed",
        decisionSummary: `Triaged (${triage.urgency}, ${triage.recipientClass}); no reply required.`,
        outputs,
      };
    }

    // Draft — tier depends on recipient class.
    const sensitive = SENSITIVE.has(triage.recipientClass);
    const draftRes = await ctx.callModel({
      taskClass: sensitive ? "inbox.draft.reply.sensitive" : "inbox.draft.reply.low",
      messages: [
        {
          role: "system",
          content:
            "Draft a reply on behalf of Atelier. Warm, calm, precise. Do not commit to anything specific; propose a follow-up if needed.",
        },
        {
          role: "user",
          content: `To: ${msg.fromName}\nSubject: ${msg.subject}\n\nOriginal:\n${msg.body}`,
        },
      ],
      maxOutputTokens: 300,
    });
    const draftText = draftRes.content;
    outputs["draft"] = draftText;

    // Propose the send — policy will demote to draft/ask and enqueue.
    const sendRes = await ctx.invokeTool<Record<string, unknown>, { sentMessageId: string; sentAt: string }>(
      "message.send",
      {
        toName: msg.fromName,
        toAddress: msg.fromAddress,
        subject: msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`,
        body: draftText,
        inReplyToRef: msg.messageId,
      },
      {
        summary: `Draft reply to ${msg.fromName} — "${msg.subject}"`,
        attrs: { recipient_class: triage.recipientClass },
      },
    );

    const decision = sendRes.decision.decision;
    if (decision === "shelved") {
      return {
        state: "shelved",
        decisionSummary: "Household is frozen; draft not queued.",
        outputs,
      };
    }
    if (decision === "denied") {
      return {
        state: "rejected",
        decisionSummary: `Denied: ${sendRes.decision.reasons.join(", ")}`,
        outputs,
      };
    }
    if (decision === "customer_approval" || decision === "manager_review") {
      return {
        state: "escalated",
        decisionSummary: `Draft ready — awaiting ${decision.replace("_", " ")}${
          sendRes.approvalId ? ` (approval ${sendRes.approvalId})` : ""
        }.`,
        outputs: {
          ...outputs,
          ...(sendRes.approvalId ? { approvalId: sendRes.approvalId } : {}),
        },
      };
    }
    if (decision === "auto_execute" && sendRes.action?.outcome === "succeeded") {
      return {
        state: "completed",
        decisionSummary: sendRes.action.summary,
        outputs: { ...outputs, action: sendRes.action, sent: sendRes.outputs },
      };
    }
    return {
      state: "failed",
      decisionSummary: `Send did not complete: ${sendRes.action?.outcome ?? "no_action"}`,
      outputs,
    };
  },
};

const parseDueHint = (hint: string | undefined): string | null => {
  if (!hint) return null;
  const iso = /^\d{4}-\d{2}-\d{2}/.test(hint) ? new Date(hint) : null;
  if (iso && !isNaN(iso.getTime())) return iso.toISOString();
  return null;
};

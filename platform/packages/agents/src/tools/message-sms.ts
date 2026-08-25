import { z } from "zod";
import type { Tool } from "../types.js";

// sms.send — the agent-side reply tool for the concierge line.
// Communication side-effect class = policy engine forces T3 and
// pushes autonomy to "ask" by default, so an agent-authored SMS
// lands as an approval unless a household policy explicitly
// promotes it to execute.
//
// The tool does NOT talk to Twilio directly. Every send goes
// through ctx.sendChannelMessage(), a runtime-supplied seam that
// applies the same outbound consent gate + session auto-attach
// that /messaging/send uses. Agent-authored and manager-authored
// sends land through one path — same recorded shape, same
// consent contract, same conversation history.

export const SmsSendInputs = z.object({
  channel: z.enum(["sms", "whatsapp"]).default("sms"),
  to: z.string().min(3),
  body: z.string().min(1).max(1600),
});
export type SmsSendInputs = z.infer<typeof SmsSendInputs>;

export interface SmsSendOutputs {
  readonly sentMessageId: string;
  readonly sentAt: string;
  readonly provider: "twilio" | "mock";
  readonly to: string;
  readonly from: string;
  readonly refused?: "opted_out";
}

export const smsSendTool: Tool<SmsSendInputs, SmsSendOutputs> = {
  name: "sms.send",
  version: "0.1.0",
  sideEffectClass: "communication",
  domain: "communication",
  actionClass: "sms.send",

  async invoke(ctx, invocation) {
    const inputs = SmsSendInputs.parse(invocation.inputs);

    if (!ctx.sendChannelMessage) {
      // No runtime-supplied sender — happens in isolated tool
      // tests. Return a mock so the policy → approval → send
      // loop still exercises end-to-end.
      const sentMessageId = `mock-sms-${Math.random().toString(36).slice(2, 10)}`;
      return {
        outputs: {
          sentMessageId,
          sentAt: new Date().toISOString(),
          provider: "mock",
          to: inputs.to,
          from: "atelier-mock",
        },
        outcome: "succeeded",
        summary: `Sent ${inputs.channel} to ${inputs.to} [mock — no runtime sender]`,
      };
    }

    const out = await ctx.sendChannelMessage({
      channel: inputs.channel,
      to: inputs.to,
      body: inputs.body,
    });

    if (out.refusedFor === "opted_out") {
      return {
        outputs: {
          sentMessageId: out.externalMessageId,
          sentAt: new Date().toISOString(),
          provider: out.provider,
          to: inputs.to,
          from: out.from,
          refused: "opted_out",
        },
        outcome: "failed_permanent",
        summary: `Refused to send ${inputs.channel} to ${inputs.to} — recipient opted out.`,
      };
    }

    return {
      outputs: {
        sentMessageId: out.externalMessageId,
        sentAt: new Date().toISOString(),
        provider: out.provider,
        to: inputs.to,
        from: out.from,
      },
      outcome: "succeeded",
      summary:
        out.provider === "twilio"
          ? `Sent ${inputs.channel} to ${inputs.to} via Twilio (${out.externalMessageId}).`
          : `Sent ${inputs.channel} to ${inputs.to} [mock — ${out.reason ?? "no live credential"}].`,
    };
  },
};

import { z } from "zod";
import type { Tool } from "../types.js";

// message.send — communication side effect. Sends an outbound message
// on the customer's behalf. In production this hits the customer's
// email or SMS provider; here it returns a synthetic message id so the
// full flow runs without external dependencies. The seed's
// message.send policy sits at draft/ask, so a real invocation almost
// always lands in the approval queue for a human to review before the
// send actually happens.
export const MessageSendInputs = z.object({
  toName: z.string(),
  toAddress: z.string(),
  subject: z.string(),
  body: z.string(),
  inReplyToMessageId: z.string().optional(),
});
export type MessageSendInputs = z.infer<typeof MessageSendInputs>;

export interface MessageSendOutputs {
  readonly sentMessageId: string;
  readonly sentAt: string;
}

export const messageSendTool: Tool<MessageSendInputs, MessageSendOutputs> = {
  name: "message.send",
  version: "0.1.0",
  sideEffectClass: "communication",
  domain: "communication",
  actionClass: "message.send",

  async invoke(ctx, invocation) {
    const inputs = MessageSendInputs.parse(invocation.inputs);
    const sentMessageId = `mock-sent-${Math.random().toString(36).slice(2, 10)}`;
    ctx.logger?.info("message.send invoked", {
      to: inputs.toAddress,
      subject: inputs.subject,
      authorityId: ctx.authorityId,
    });
    return {
      outputs: { sentMessageId, sentAt: new Date().toISOString() },
      outcome: "succeeded",
      summary: `Sent "${inputs.subject}" to ${inputs.toName} <${inputs.toAddress}>`,
    };
  },
};

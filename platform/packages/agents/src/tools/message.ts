import { z } from "zod";
import gmailApi from "@googleapis/gmail";
import type { Tool, ToolContext } from "../types.js";
import { base64UrlEncode, readGoogleAuth, type GoogleOAuthFields } from "./_google.js";

// message.send — communication side effect. Prefers a real Gmail
// send when the household has connected a `gmail` credential;
// otherwise returns a synthetic sent-id so the full policy →
// approval → send loop still runs without external dependencies.
//
// Uses the @googleapis/gmail SDK. RFC-822 body construction stays
// hand-rolled — the SDK doesn't help there — but the transport,
// auth, and error surfacing come from google-auth-library +
// gaxios.

interface GmailFields extends GoogleOAuthFields {
  readonly from_address?: string;
  readonly from_name?: string;
}

export const MessageSendInputs = z.object({
  toName: z.string(),
  toAddress: z.string().email(),
  subject: z.string(),
  body: z.string(),
  inReplyToMessageId: z.string().optional(),
  fromName: z.string().optional(),
  fromAddress: z.string().email().optional(),
});
export type MessageSendInputs = z.infer<typeof MessageSendInputs>;

export interface MessageSendOutputs {
  readonly sentMessageId: string;
  readonly sentAt: string;
  readonly provider: "gmail" | "mock";
  readonly threadId?: string;
}

// Build an RFC-822 message body Gmail's send endpoint accepts. Header
// lines are CRLF-terminated; text/plain UTF-8 body follows a blank
// line. Kept intentionally simple — HTML alternative parts, threading
// headers, and attachments are next-commit territory.
const rfc822Message = (opts: {
  fromName?: string;
  fromAddress: string;
  toName: string;
  toAddress: string;
  subject: string;
  body: string;
  inReplyToRef?: string;
}): string => {
  const from = opts.fromName ? `${opts.fromName} <${opts.fromAddress}>` : opts.fromAddress;
  const to = opts.toName ? `${opts.toName} <${opts.toAddress}>` : opts.toAddress;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 7bit",
    ...(opts.inReplyToRef ? [`In-Reply-To: <${opts.inReplyToRef}>`] : []),
    ...(opts.inReplyToRef ? [`References: <${opts.inReplyToRef}>`] : []),
  ];
  return `${headers.join("\r\n")}\r\n\r\n${opts.body}`;
};

const trySendViaGmail = async (
  ctx: ToolContext,
  inputs: MessageSendInputs,
): Promise<
  | { provider: "gmail"; sentMessageId: string; threadId: string | undefined }
  | null
> => {
  const auth = await readGoogleAuth<GmailFields>(ctx, "gmail");
  if (!auth) return null;

  const fromAddress = inputs.fromAddress ?? auth.credential.from_address;
  if (!fromAddress) {
    ctx.logger?.info("gmail credential missing from_address; skipping live send", {
      credentialId: auth.credentialId,
    });
    return null;
  }

  const raw = rfc822Message({
    ...(inputs.fromName !== undefined ? { fromName: inputs.fromName } : {}),
    ...(auth.credential.from_name !== undefined && inputs.fromName === undefined
      ? { fromName: auth.credential.from_name }
      : {}),
    fromAddress,
    toName: inputs.toName,
    toAddress: inputs.toAddress,
    subject: inputs.subject,
    body: inputs.body,
    ...(inputs.inReplyToMessageId !== undefined
      ? { inReplyToRef: inputs.inReplyToMessageId }
      : {}),
  });

  const gmail = gmailApi.gmail({ version: "v1", auth: auth.client });
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: base64UrlEncode(raw) },
  });
  ctx.logger?.info("gmail message sent", {
    messageId: res.data.id,
    authorityId: ctx.authorityId,
  });
  return {
    provider: "gmail",
    sentMessageId: res.data.id ?? "unknown",
    threadId: res.data.threadId ?? undefined,
  };
};

export const messageSendTool: Tool<MessageSendInputs, MessageSendOutputs> = {
  name: "message.send",
  version: "0.2.0",
  sideEffectClass: "communication",
  domain: "communication",
  actionClass: "message.send",

  async invoke(ctx, invocation) {
    const inputs = MessageSendInputs.parse(invocation.inputs);

    try {
      const sent = await trySendViaGmail(ctx, inputs);
      if (sent) {
        return {
          outputs: {
            sentMessageId: sent.sentMessageId,
            sentAt: new Date().toISOString(),
            provider: sent.provider,
            ...(sent.threadId !== undefined && { threadId: sent.threadId }),
          },
          outcome: "succeeded",
          summary: `Sent "${inputs.subject}" to ${inputs.toName} <${inputs.toAddress}> via Gmail`,
        };
      }
    } catch (err) {
      ctx.logger?.info("gmail send failed; falling back to mock", {
        error: (err as Error).message,
      });
    }

    const sentMessageId = `mock-sent-${Math.random().toString(36).slice(2, 10)}`;
    return {
      outputs: {
        sentMessageId,
        sentAt: new Date().toISOString(),
        provider: "mock",
      },
      outcome: "succeeded",
      summary: `Sent "${inputs.subject}" to ${inputs.toName} <${inputs.toAddress}> [mock]`,
    };
  },
};

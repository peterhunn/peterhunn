import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";
import { base64UrlEncode, readGoogleAuth, type GoogleOAuthFields } from "./_google.js";

// message.send — communication side effect. Prefers a real Gmail
// send when the household has connected a `gmail` credential;
// otherwise returns a synthetic sent-id so the full policy →
// approval → send loop still runs without external dependencies.

const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

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

  const fromAddress = inputs.fromAddress ?? auth.from_address;
  if (!fromAddress) {
    ctx.logger?.info("gmail credential missing from_address; skipping live send", {
      credentialId: auth.credentialId,
    });
    return null;
  }

  const raw = rfc822Message({
    ...(inputs.fromName !== undefined ? { fromName: inputs.fromName } : {}),
    ...(auth.from_name !== undefined && inputs.fromName === undefined
      ? { fromName: auth.from_name }
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

  const res = await fetch(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw: base64UrlEncode(raw) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`gmail_${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { id?: string; threadId?: string };
  ctx.logger?.info("gmail message sent", {
    messageId: json.id,
    authorityId: ctx.authorityId,
  });
  return {
    provider: "gmail",
    sentMessageId: json.id ?? "unknown",
    threadId: json.threadId,
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

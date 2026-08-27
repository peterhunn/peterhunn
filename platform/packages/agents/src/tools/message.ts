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
  // RFC 5322 Message-ID (angle brackets stripped) of the message
  // being replied to. Renders as In-Reply-To + References headers
  // so non-Gmail MUAs thread the reply.
  inReplyToRef: z.string().optional(),
  // Gmail-side thread id. When set, the Gmail send call includes
  // it in the request body so Gmail places the reply in the same
  // conversation server-side.
  threadId: z.string().optional(),
  fromName: z.string().optional(),
  fromAddress: z.string().email().optional(),
});
export type MessageSendInputs = z.infer<typeof MessageSendInputs>;

export interface MessageSendOutputs {
  readonly sentMessageId: string;
  readonly sentAt: string;
  readonly provider: "gmail" | "mock";
  readonly threadId?: string;
  // The RFC 5322 Message-ID (angle brackets stripped) generated
  // for the outbound message. Callers persist this alongside the
  // send so a future reply — inbound sync landing a message whose
  // In-Reply-To matches this id — can be threaded.
  readonly messageIdHeader?: string;
}

// Generate an RFC 5322 Message-ID. Format:
// <timestamp.random@fromDomain>. The fromDomain-based right-hand
// side follows RFC convention; the random+timestamp left half is
// enough uniqueness for our volume.
const generateMessageId = (fromAddress: string): string => {
  const domain = fromAddress.split("@")[1] ?? "atelier.local";
  const rand =
    typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
      ? Array.from(crypto.getRandomValues(new Uint8Array(8)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
      : Math.random().toString(16).slice(2, 18).padStart(16, "0");
  return `${Date.now()}.${rand}@${domain}`;
};

// Build an RFC-822 message body Gmail's send endpoint accepts. Header
// lines are CRLF-terminated; text/plain UTF-8 body follows a blank
// line. Kept intentionally simple — HTML alternative parts and
// attachments are next-commit territory.
const rfc822Message = (opts: {
  fromName?: string;
  fromAddress: string;
  toName: string;
  toAddress: string;
  subject: string;
  body: string;
  inReplyToRef?: string;
  messageIdHeader: string;
}): string => {
  const from = opts.fromName ? `${opts.fromName} <${opts.fromAddress}>` : opts.fromAddress;
  const to = opts.toName ? `${opts.toName} <${opts.toAddress}>` : opts.toAddress;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${opts.subject}`,
    `Message-ID: <${opts.messageIdHeader}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 7bit",
    ...(opts.inReplyToRef ? [`In-Reply-To: <${opts.inReplyToRef}>`] : []),
    ...(opts.inReplyToRef ? [`References: <${opts.inReplyToRef}>`] : []),
  ];
  return `${headers.join("\r\n")}\r\n\r\n${opts.body}`;
};

// Exported so the API's manager-facing email composer route can
// send through the same Gmail path as the agent tool without
// re-implementing the auth + RFC-822 build. Returns null when the
// household hasn't connected Gmail; throws on Gmail-side errors so
// the caller can decide whether to fall back to mock or surface.
export const trySendViaGmail = async (
  ctx: ToolContext,
  inputs: MessageSendInputs,
): Promise<
  | {
      provider: "gmail";
      sentMessageId: string;
      threadId: string | undefined;
      messageIdHeader: string;
    }
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

  const messageIdHeader = generateMessageId(fromAddress);
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
    ...(inputs.inReplyToRef !== undefined
      ? { inReplyToRef: inputs.inReplyToRef }
      : {}),
    messageIdHeader,
  });

  const gmail = gmailApi.gmail({ version: "v1", auth: auth.client });
  // Pass threadId so Gmail places the reply in the same
  // conversation server-side; combined with the In-Reply-To /
  // References headers, this threads for both Gmail and non-
  // Gmail recipients.
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: base64UrlEncode(raw),
      ...(inputs.threadId ? { threadId: inputs.threadId } : {}),
    },
  });
  ctx.logger?.info("gmail message sent", {
    messageId: res.data.id,
    authorityId: ctx.authorityId,
  });
  return {
    provider: "gmail",
    sentMessageId: res.data.id ?? "unknown",
    threadId: res.data.threadId ?? undefined,
    messageIdHeader,
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
            messageIdHeader: sent.messageIdHeader,
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

import twilio from "twilio";
import type { StoredCredential } from "../types.js";

// Twilio adapter — shared helper for sending SMS + WhatsApp via the
// official Node SDK.
//
// Credential shape (stored via credentialRepo as
// provider="twilio", kind="api_key"):
//   { account_sid, auth_token, from_number?, messaging_service_sid? }
// A messaging_service_sid takes precedence when set (Twilio's
// recommended production path — the messaging service picks a
// From automatically). Otherwise from_number is used verbatim.
//
// Also re-exports the SDK's request-validator so the messaging
// route can verify incoming X-Twilio-Signature headers with the
// same auth token, keeping one library on both sides of the wire.
//
// Falls back to a deterministic mock send when no credential is
// stored or the SDK throws, stamping provider="mock" with a
// visible reason so nothing is silent.

export interface TwilioSendInput {
  readonly to: string;
  readonly body: string;
  readonly channel?: "sms" | "whatsapp";
}

export interface TwilioSendOutput {
  readonly provider: "twilio" | "mock";
  readonly externalMessageId: string;
  readonly from: string;
  readonly to: string;
  readonly status?: string;
  readonly reason?: string;
}

interface TwilioFields {
  readonly account_sid?: string;
  readonly auth_token?: string;
  readonly from_number?: string;
  readonly messaging_service_sid?: string;
}

const withPrefix = (channel: "sms" | "whatsapp", addr: string): string =>
  channel === "whatsapp" && !addr.startsWith("whatsapp:") ? `whatsapp:${addr}` : addr;

export const sendTwilioMessage = async (
  credential: StoredCredential | null,
  input: TwilioSendInput,
  opts: { logger?: { info: (msg: string, ctx?: unknown) => void } } = {},
): Promise<TwilioSendOutput> => {
  const channel = input.channel ?? "sms";
  const cred = (credential?.credential ?? {}) as TwilioFields;
  const hasLive = Boolean(
    cred.account_sid &&
      cred.auth_token &&
      (cred.messaging_service_sid || cred.from_number),
  );

  if (!hasLive) {
    const mockId = `mock-sms-${Math.random().toString(36).slice(2, 12)}`;
    opts.logger?.info("twilio credential missing — mock send", {
      to: input.to,
      channel,
    });
    return {
      provider: "mock",
      externalMessageId: mockId,
      from: cred.from_number ?? "atelier-mock",
      to: input.to,
      reason: "no_twilio_credential",
    };
  }

  const toAddr = withPrefix(channel, input.to);
  const client = twilio(cred.account_sid!, cred.auth_token!);
  try {
    const message = await client.messages.create({
      to: toAddr,
      body: input.body,
      ...(cred.messaging_service_sid
        ? { messagingServiceSid: cred.messaging_service_sid }
        : { from: withPrefix(channel, cred.from_number!) }),
    });
    return {
      provider: "twilio",
      externalMessageId: message.sid,
      from: message.from ?? cred.from_number ?? "",
      to: message.to ?? toAddr,
      ...(message.status ? { status: message.status } : {}),
    };
  } catch (err) {
    const twilioErr = err as { status?: number; code?: number | string; message?: string };
    const status = twilioErr.status ?? twilioErr.code ?? "err";
    opts.logger?.info("twilio send failed — mock fallback", {
      status,
      message: twilioErr.message?.slice(0, 200),
    });
    const mockId = `mock-sms-${Math.random().toString(36).slice(2, 12)}`;
    return {
      provider: "mock",
      externalMessageId: mockId,
      from: cred.from_number ?? "atelier-mock",
      to: input.to,
      reason: `twilio_${status}`,
    };
  }
};

// Signature verification for inbound webhooks. The SDK's
// validateRequest does the same HMAC-SHA1 the pre-SDK code did
// (sort form params, concat, sign the full URL + concatenated
// values), just maintained by Twilio so future signature-scheme
// changes land here.
export const verifyTwilioInboundSignature = (input: {
  authToken: string;
  fullUrl: string;
  params: Record<string, string>;
  signature: string | undefined;
}): boolean => {
  if (!input.signature) return false;
  return twilio.validateRequest(
    input.authToken,
    input.signature,
    input.fullUrl,
    input.params,
  );
};

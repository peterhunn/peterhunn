import type { StoredCredential } from "../types.js";

// Twilio adapter — shared helper for sending SMS + WhatsApp.
//
// Credential shape (stored via credentialRepo as
// provider="twilio", kind="api_key"):
//   { account_sid, auth_token, from_number?, messaging_service_sid? }
// A messaging_service_sid takes precedence when set (Twilio's
// recommended production path — the messaging service picks a
// From automatically). Otherwise from_number is used verbatim.
//
// Falls back to a deterministic mock send when no credential is
// stored, stamping provider="mock" so the fallback is never silent.

const TWILIO_BASE = "https://api.twilio.com/2010-04-01";

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
  const form = new URLSearchParams();
  form.set("To", toAddr);
  form.set("Body", input.body);
  if (cred.messaging_service_sid) {
    form.set("MessagingServiceSid", cred.messaging_service_sid);
  } else if (cred.from_number) {
    form.set("From", withPrefix(channel, cred.from_number));
  }

  const url = `${TWILIO_BASE}/Accounts/${cred.account_sid}/Messages.json`;
  const auth = Buffer.from(`${cred.account_sid}:${cred.auth_token}`).toString("base64");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (err) {
    const mockId = `mock-sms-${Math.random().toString(36).slice(2, 12)}`;
    opts.logger?.info("twilio send fetch failed — mock fallback", {
      error: (err as Error).message,
    });
    return {
      provider: "mock",
      externalMessageId: mockId,
      from: cred.from_number ?? "atelier-mock",
      to: input.to,
      reason: `twilio_fetch: ${(err as Error).message}`,
    };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    const mockId = `mock-sms-${Math.random().toString(36).slice(2, 12)}`;
    opts.logger?.info("twilio send non-2xx — mock fallback", {
      status: res.status,
      body: text.slice(0, 200),
    });
    return {
      provider: "mock",
      externalMessageId: mockId,
      from: cred.from_number ?? "atelier-mock",
      to: input.to,
      reason: `twilio_${res.status}`,
    };
  }
  const json = (await res.json()) as {
    sid?: string;
    from?: string;
    to?: string;
    status?: string;
  };
  return {
    provider: "twilio",
    externalMessageId: json.sid ?? "unknown",
    from: json.from ?? cred.from_number ?? "",
    to: json.to ?? toAddr,
    ...(json.status ? { status: json.status } : {}),
  };
};

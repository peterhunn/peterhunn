import type { ModelCall, ModelResponse, ModelSpec } from "@atelier/domain";

// Mock provider used until real adapters are wired in. Canned per-task
// responses so the console demo shows plausible model output. Real
// adapters replace this file only.

export const invokeMock = async (
  model: ModelSpec,
  call: ModelCall,
): Promise<Omit<ModelResponse, "modelCallId">> => {
  const inputChars = call.messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = Math.max(1, Math.ceil(inputChars / 4));
  const content = cannedResponse(model, call);
  const outputTokens = Math.max(1, Math.ceil(content.length / 4));
  const costUsdEstimated =
    (inputTokens / 1000) * model.costPer1kInputUsd +
    (outputTokens / 1000) * model.costPer1kOutputUsd;
  return {
    modelId: model.id,
    tier: model.tier,
    content,
    usage: { inputTokens, outputTokens, costUsdEstimated },
    latencyMs: model.latencyP50Ms,
    finishReason: "stop",
    reasons: ["mock_provider"],
  };
};

const cannedResponse = (model: ModelSpec, call: ModelCall): string => {
  const userMsg = call.messages.find((m) => m.role === "user")?.content ?? "";

  switch (call.taskClass) {
    case "inbox.triage":
      return JSON.stringify({
        urgency: guessUrgency(userMsg),
        recipientClass: guessRecipientClass(userMsg),
        requiresReply: /\?|please respond|let me know|confirm/i.test(userMsg) ? "yes" : "no",
        notes: "Auto-triaged (mock provider).",
      });

    case "inbox.extract":
      return JSON.stringify({
        obligations: guessObligations(userMsg),
      });

    case "inbox.draft.reply.low":
      return draftReply(userMsg, "low");

    case "inbox.draft.reply.sensitive":
      return draftReply(userMsg, "sensitive");

    case "calendar.parse":
      return JSON.stringify({ category: "professional" });

    default:
      return `mock:${model.id}:${call.taskClass}`;
  }
};

const guessUrgency = (body: string): "low" | "normal" | "high" => {
  if (/urgent|asap|emergency|immediately/i.test(body)) return "high";
  if (/tomorrow|today|end of day/i.test(body)) return "normal";
  return "low";
};

const guessRecipientClass = (
  body: string,
): "family" | "friend" | "staff" | "vendor" | "employer" | "counsel" | "medical" | "regulator" | "other" => {
  if (/attorney|counsel|legal|lawyer/i.test(body)) return "counsel";
  if (/doctor|physician|medical|clinic|hospital/i.test(body)) return "medical";
  if (/school|principal|teacher|nurse/i.test(body)) return "family";
  if (/invoice|quote|estimate|repair|service call/i.test(body)) return "vendor";
  if (/board|meeting|q\d earnings|deck|memo/i.test(body)) return "employer";
  return "other";
};

const guessObligations = (
  body: string,
): Array<{ title: string; category: string; dueHint?: string }> => {
  const items: Array<{ title: string; category: string; dueHint?: string }> = [];
  const dateHint = /\b(\d{4}-\d{2}-\d{2}|next \w+|this \w+|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/i.exec(
    body,
  );
  if (/rsvp|reply by|respond by/i.test(body)) {
    items.push({
      title: "Reply requested",
      category: "personal",
      ...(dateHint && { dueHint: dateHint[0] }),
    });
  }
  if (/renewal|expires|expiration/i.test(body)) {
    items.push({
      title: "Renewal handling",
      category: "renewal",
      ...(dateHint && { dueHint: dateHint[0] }),
    });
  }
  if (/appointment|schedule|book|reservation/i.test(body)) {
    items.push({
      title: "Appointment to schedule",
      category: "personal",
      ...(dateHint && { dueHint: dateHint[0] }),
    });
  }
  return items;
};

const draftReply = (body: string, kind: "low" | "sensitive"): string => {
  const opening =
    kind === "sensitive"
      ? "Thank you for your note. I'll review carefully and reply promptly."
      : "Thank you for the message.";
  const middle = /appointment|schedule|book/i.test(body)
    ? " I'll confirm timing and be back to you shortly."
    : /invoice|quote|estimate/i.test(body)
      ? " I'll review and confirm next steps."
      : " I'll follow up with a full response soon.";
  return `${opening}${middle}\n\nWith thanks,\nAtelier`;
};

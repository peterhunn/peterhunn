import { describe, it, expect } from "vitest";
import { smsSendTool } from "../src/tools/message-sms.js";
import type { HouseholdId } from "@atelier/domain";
import type { ToolContext } from "../src/types.js";

const HH = "hh_test" as HouseholdId;

const mkCtx = (
  overrides: Partial<ToolContext> = {},
): ToolContext => ({
  householdId: HH,
  authorityId: "pol_test",
  proposedBy: { actor: "concierge_agent", version: "0.1.0" },
  readCredential: () => null,
  logger: { info: () => {} },
  ...overrides,
});

describe("sms.send", () => {
  it("uses the runtime-supplied sendChannelMessage seam when present", async () => {
    const captured: Array<{ channel: string; to: string; body: string }> = [];
    const ctx = mkCtx({
      sendChannelMessage: async (input) => {
        captured.push(input);
        return {
          provider: "twilio",
          externalMessageId: "SM_abcdef",
          from: "+15555550100",
          to: input.to,
          eventId: "mev_captured",
        };
      },
    });

    const res = await smsSendTool.invoke(ctx, {
      inputs: { channel: "sms", to: "+14158675309", body: "Confirmed for 7pm." },
      summary: "Confirmation SMS",
    });

    expect(res.outcome).toBe("succeeded");
    expect(res.outputs.provider).toBe("twilio");
    expect(res.outputs.sentMessageId).toBe("SM_abcdef");
    expect(res.outputs.to).toBe("+14158675309");
    expect(captured).toEqual([
      { channel: "sms", to: "+14158675309", body: "Confirmed for 7pm." },
    ]);
    expect(res.summary).toContain("Sent sms to +14158675309");
  });

  it("returns failed_permanent when the runtime reports the recipient opted out", async () => {
    const ctx = mkCtx({
      sendChannelMessage: async () => ({
        provider: "mock",
        externalMessageId: "refused-opted-out",
        from: "",
        to: "+14158675310",
        eventId: "",
        reason: "opted_out_at_2026-01-01T00:00:00Z",
        refusedFor: "opted_out",
      }),
    });

    const res = await smsSendTool.invoke(ctx, {
      inputs: { channel: "sms", to: "+14158675310", body: "Any updates?" },
      summary: "Follow-up",
    });

    expect(res.outcome).toBe("failed_permanent");
    expect(res.outputs.refused).toBe("opted_out");
    expect(res.summary).toMatch(/Refused.*opted out/);
  });

  it("falls back to a mock send when no runtime sender is wired (isolated tool tests)", async () => {
    const res = await smsSendTool.invoke(mkCtx(), {
      inputs: { channel: "whatsapp", to: "+14158675311", body: "test" },
      summary: "test",
    });

    expect(res.outcome).toBe("succeeded");
    expect(res.outputs.provider).toBe("mock");
    expect(res.outputs.sentMessageId).toMatch(/^mock-sms-/);
    expect(res.summary).toMatch(/no runtime sender/);
  });
});

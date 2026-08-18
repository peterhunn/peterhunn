import { z } from "zod";
import type { Agent, AgentContext, AgentTaskOutput, Intent } from "../types.js";

// Household agent — handles vendor scheduling and vendor purchase
// intents. Reads the graph for a preferred vendor, proposes an action,
// and either auto-executes, escalates to an approval, or fails.

export const VendorScheduleAttrs = z.object({
  propertyNodeId: z.string(),
  serviceType: z.string(),
  requestedFor: z.string().datetime().optional(),
  notes: z.string().optional(),
});

export const VendorPurchaseAttrs = z.object({
  itemDescription: z.string(),
  serviceType: z.string(),
  amountUsd: z.number().nonnegative(),
  notes: z.string().optional(),
});

const NAME = "household";
const VERSION = "0.2.0";

const findVendor = (
  ctx: AgentContext,
  serviceType: string,
): { id: string; name: string } | null => {
  const vendors = ctx.graph.listNodes({ type: "org.vendor" });
  const match = vendors.find((v) => {
    const notes = String(v.data["notes"] ?? "").toLowerCase();
    const name = String(v.data["name"] ?? "").toLowerCase();
    const needle = serviceType.toLowerCase();
    return notes.includes(needle) || name.includes(needle);
  });
  if (!match) return null;
  return { id: match.id, name: String(match.data["name"] ?? "unknown") };
};

const mapToolResult = <O>(
  result: {
    decision: { decision: string; reasons: readonly string[] };
    action: { outcome: string; summary: string } | null;
    outputs: O | null;
    approvalId: string | null;
  },
  successPayload: (outputs: O) => Record<string, unknown>,
): AgentTaskOutput => {
  if (result.decision.decision === "shelved") {
    return {
      state: "shelved",
      decisionSummary: "Household is frozen; action shelved.",
      outputs: { decision: result.decision },
    };
  }
  if (result.decision.decision === "denied") {
    return {
      state: "rejected",
      decisionSummary: `Denied: ${result.decision.reasons.join(", ")}`,
      outputs: { decision: result.decision },
    };
  }
  if (
    result.decision.decision === "customer_approval" ||
    result.decision.decision === "manager_review"
  ) {
    return {
      state: "escalated",
      decisionSummary: `Awaiting ${result.decision.decision.replace("_", " ")}${
        result.approvalId ? ` (approval ${result.approvalId})` : ""
      }.`,
      outputs: {
        decision: result.decision,
        ...(result.approvalId ? { approvalId: result.approvalId } : {}),
      },
    };
  }
  if (result.decision.decision !== "auto_execute") {
    return {
      state: "escalated",
      decisionSummary: `Requires ${result.decision.decision.replace("_", " ")}.`,
      outputs: { decision: result.decision },
    };
  }
  if (!result.action || result.action.outcome !== "succeeded") {
    return {
      state: "failed",
      decisionSummary: `Tool did not succeed: ${result.action?.outcome ?? "no_action"}`,
      outputs: { decision: result.decision, action: result.action },
    };
  }
  return {
    state: "completed",
    decisionSummary: result.action.summary,
    outputs: {
      decision: result.decision,
      action: result.action,
      ...(result.outputs ? successPayload(result.outputs) : {}),
    },
  };
};

export const householdAgent: Agent = {
  name: NAME,
  version: VERSION,

  handles(intent: Intent): boolean {
    return (
      intent.kind === "household.vendor.schedule" ||
      intent.kind === "household.vendor.purchase"
    );
  },

  async handle(intent: Intent, ctx: AgentContext): Promise<AgentTaskOutput> {
    if (intent.kind === "household.vendor.schedule") {
      const parsed = VendorScheduleAttrs.safeParse(intent.attrs);
      if (!parsed.success) {
        return {
          state: "failed",
          errorMessage: `Invalid intent attrs: ${parsed.error.message}`,
        };
      }
      const attrs = parsed.data;
      const vendor = findVendor(ctx, attrs.serviceType);
      if (!vendor) {
        return {
          state: "escalated",
          decisionSummary: `No known vendor for ${attrs.serviceType}; escalating to manager for selection.`,
          outputs: { serviceType: attrs.serviceType, reason: "no_known_vendor" },
        };
      }
      const result = await ctx.invokeTool<Record<string, unknown>, { bookingRef: string; scheduledFor: string }>(
        "vendor.schedule",
        {
          vendorNodeId: vendor.id,
          propertyNodeId: attrs.propertyNodeId,
          serviceType: attrs.serviceType,
          ...(attrs.requestedFor ? { requestedFor: attrs.requestedFor } : {}),
          ...(attrs.notes ? { notes: attrs.notes } : {}),
        },
        {
          summary: `Schedule ${attrs.serviceType} with ${vendor.name}`,
          attrs: { service_type: attrs.serviceType },
        },
      );
      return mapToolResult(result, (outputs) => ({
        vendor,
        booking: outputs,
      }));
    }

    if (intent.kind === "household.vendor.purchase") {
      const parsed = VendorPurchaseAttrs.safeParse(intent.attrs);
      if (!parsed.success) {
        return {
          state: "failed",
          errorMessage: `Invalid intent attrs: ${parsed.error.message}`,
        };
      }
      const attrs = parsed.data;
      const vendor = findVendor(ctx, attrs.serviceType);
      if (!vendor) {
        return {
          state: "escalated",
          decisionSummary: `No known vendor for ${attrs.serviceType}; escalating for manager to source.`,
          outputs: { serviceType: attrs.serviceType, reason: "no_known_vendor" },
        };
      }
      const result = await ctx.invokeTool<Record<string, unknown>, { receiptRef: string; purchasedAt: string }>(
        "vendor.purchase",
        {
          vendorNodeId: vendor.id,
          itemDescription: attrs.itemDescription,
          amountUsd: attrs.amountUsd,
          ...(attrs.notes ? { notes: attrs.notes } : {}),
        },
        {
          summary: `Purchase ${attrs.itemDescription} from ${vendor.name} for $${attrs.amountUsd.toFixed(2)}`,
          amountUsd: attrs.amountUsd,
        },
      );
      return mapToolResult(result, (outputs) => ({
        vendor,
        purchase: outputs,
      }));
    }

    return {
      state: "failed",
      errorMessage: `Unsupported intent: ${intent.kind}`,
    };
  },
};

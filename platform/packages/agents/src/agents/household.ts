import { z } from "zod";
import type { Agent, AgentContext, AgentTaskOutput, Intent } from "../types.js";

// Household agent — handles vendor scheduling intents. Reads the graph
// for the preferred vendor of the requested service type, proposes a
// scheduling action, and (assuming policy allows) invokes the
// vendor.schedule tool. Higher-friction paths (no preferred vendor,
// policy escalation) surface as "escalated" for a manager to resolve.

export const VendorScheduleAttrs = z.object({
  propertyNodeId: z.string(),
  serviceType: z.string(),
  requestedFor: z.string().datetime().optional(),
  notes: z.string().optional(),
});

const NAME = "household";
const VERSION = "0.1.0";

export const householdAgent: Agent = {
  name: NAME,
  version: VERSION,

  handles(intent: Intent): boolean {
    return intent.kind === "household.vendor.schedule";
  },

  async handle(intent: Intent, ctx: AgentContext): Promise<AgentTaskOutput> {
    const parsed = VendorScheduleAttrs.safeParse(intent.attrs);
    if (!parsed.success) {
      return {
        state: "failed",
        errorMessage: `Invalid intent attrs: ${parsed.error.message}`,
      };
    }
    const attrs = parsed.data;

    // Find a preferred vendor for this service type. Phase-0 heuristic:
    // any org.vendor node whose notes contain the service type wins.
    // Real matching goes through preferred-vendor edges in the graph;
    // that's a natural next step once relationships are seeded.
    const vendors = ctx.graph.listNodes({ type: "org.vendor" });
    const vendor = vendors.find((v) => {
      const notes = String(v.data["notes"] ?? "").toLowerCase();
      const name = String(v.data["name"] ?? "").toLowerCase();
      return (
        notes.includes(attrs.serviceType.toLowerCase()) ||
        name.includes(attrs.serviceType.toLowerCase())
      );
    });

    if (!vendor) {
      return {
        state: "escalated",
        decisionSummary: `No known vendor for ${attrs.serviceType}; escalating to manager for selection.`,
        outputs: { serviceType: attrs.serviceType, reason: "no_known_vendor" },
      };
    }

    ctx.logger.info("household.vendor.schedule proposing", {
      vendor: vendor.id,
      serviceType: attrs.serviceType,
    });

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
        summary: `Schedule ${attrs.serviceType}`,
        attrs: { service_type: attrs.serviceType },
      },
    );

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
    if (result.decision.decision !== "auto_execute") {
      return {
        state: "escalated",
        decisionSummary: `Requires ${result.decision.decision.replace("_", " ")}.`,
        outputs: { decision: result.decision, plannedAction: { vendor: vendor.id, ...attrs } },
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
        vendor: { id: vendor.id, name: vendor.data["name"] },
        booking: result.outputs,
      },
    };
  },
};

import { z } from "zod";
import type { Tool, ToolContext, ToolInvocation, ToolResult } from "../types.js";

// Mock vendor.schedule tool. In production this would call the vendor's
// booking API (email + calendar hold or an actual integration). For
// phase 0 it returns a synthetic booking id so the full flow runs
// end to end without external dependencies.

export const VendorScheduleInputs = z.object({
  vendorNodeId: z.string(),
  propertyNodeId: z.string(),
  serviceType: z.string(),
  requestedFor: z.string().datetime().optional(),
  notes: z.string().optional(),
});
export type VendorScheduleInputs = z.infer<typeof VendorScheduleInputs>;

export interface VendorScheduleOutputs {
  readonly bookingRef: string;
  readonly scheduledFor: string;
}

export const vendorScheduleTool: Tool<VendorScheduleInputs, VendorScheduleOutputs> = {
  name: "vendor.schedule",
  version: "0.1.0",
  sideEffectClass: "write_reversible",
  domain: "household",
  actionClass: "vendor.schedule",

  async invoke(
    ctx: ToolContext,
    invocation: ToolInvocation<VendorScheduleInputs, VendorScheduleOutputs>,
  ): Promise<ToolResult<VendorScheduleOutputs>> {
    const inputs = VendorScheduleInputs.parse(invocation.inputs);
    const scheduledFor =
      inputs.requestedFor ?? new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const bookingRef = `mock-${Math.random().toString(36).slice(2, 10)}`;

    ctx.logger?.info("vendor.schedule invoked", {
      vendorNodeId: inputs.vendorNodeId,
      scheduledFor,
      authorityId: ctx.authorityId,
    });

    return {
      outputs: { bookingRef, scheduledFor },
      outcome: "succeeded",
      summary: `Scheduled ${inputs.serviceType} with vendor ${short(inputs.vendorNodeId)} for ${scheduledFor}`,
      amountUsd: invocation.amountUsd,
    };
  },
};

const short = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

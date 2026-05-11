import type { ContractEvent, ContractResponse, ContractState, Obligation } from "@legal-agents/core";
import { initialState } from "@legal-agents/core";
import type { ContractLogic, ContractLogicContext } from "@legal-agents/core";
import type { NDAData } from "./model.js";

/**
 * NDA-specific event types — TypeScript replacements for Ergo request types.
 */
export type NDAEventType =
  | "DISCLOSURE_MADE"
  | "BREACH_NOTIFIED"
  | "TERM_EXPIRED"
  | "AGREEMENT_TERMINATED";

export interface NDAEvent extends ContractEvent {
  $class: `org.accordproject.nda.${NDAEventType}`;
  type: NDAEventType;
  payload: {
    description?: string;
    terminationReason?: string;
  };
}

export interface NDAResponse {
  message: string;
  newObligations?: Obligation[];
}

/**
 * NDA contract logic — TypeScript replacement for an Ergo contract.
 *
 * Ergo would express this as:
 *   contract NDA over NDAContract state NDAState {
 *     clause disclosureMade(request: DisclosureMade): NDAResponse { ... }
 *     clause breachNotified(request: BreachNotified): NDAResponse { ... }
 *   }
 *
 * We express it as a plain ContractLogic<T> object with TypeScript functions.
 * This is simpler, LLM-readable, and runs without an Ergo runtime.
 */
export const ndaLogic: ContractLogic<NDAData, NDAEvent, NDAResponse> = {
  init(data) {
    const expiryDate = addMonths(data.effectiveDate, data.durationMonths);

    const obligations: Obligation[] = [
      {
        obligationId: crypto.randomUUID(),
        party: data.receivingParty.partyId,
        action: "Maintain confidentiality of all disclosed information",
        deadline: expiryDate,
        status: "pending",
      },
    ];

    if (data.mutual) {
      obligations.push({
        obligationId: crypto.randomUUID(),
        party: data.disclosingParty.partyId,
        action: "Maintain confidentiality of all information received from receiving party",
        deadline: expiryDate,
        status: "pending",
      });
    }

    return initialState({ obligations });
  },

  execute(event, ctx) {
    switch (event.type) {
      case "DISCLOSURE_MADE":
        return handleDisclosure(event, ctx);
      case "BREACH_NOTIFIED":
        return handleBreach(event, ctx);
      case "TERM_EXPIRED":
        return handleExpiry(event, ctx);
      case "AGREEMENT_TERMINATED":
        return handleTermination(event, ctx);
      default:
        return {
          state: ctx.state,
          result: { message: `Unknown event type: ${event.type}` },
          error: `Unhandled NDA event type: ${event.type}`,
        };
    }
  },
};

function handleDisclosure(
  event: NDAEvent,
  ctx: ContractLogicContext<NDAData>,
): ContractResponse<NDAResponse> {
  const newObligation: Obligation = {
    obligationId: crypto.randomUUID(),
    party: ctx.data.receivingParty.partyId,
    action: `Protect confidential information: ${event.payload.description ?? "disclosed information"}`,
    deadline: addMonths(event.timestamp, ctx.data.durationMonths),
    condition: "Information received under this NDA",
    status: "pending",
  };

  return {
    state: {
      ...ctx.state,
      obligations: [...ctx.state.obligations, newObligation],
      history: [...ctx.state.history, event],
    },
    result: {
      message: `Disclosure recorded. Confidentiality obligation created until ${newObligation.deadline}.`,
      newObligations: [newObligation],
    },
  };
}

function handleBreach(
  event: NDAEvent,
  ctx: ContractLogicContext<NDAData>,
): ContractResponse<NDAResponse> {
  const updatedObligations = ctx.state.obligations.map((o) =>
    o.party === event.party ? { ...o, status: "breached" as const } : o,
  );

  return {
    state: {
      ...ctx.state,
      status: "breached",
      obligations: updatedObligations,
      history: [...ctx.state.history, event],
    },
    result: {
      message: `Breach notified by ${event.party}. Contract status set to breached.`,
    },
    emit: [
      {
        $class: "org.accordproject.nda.BreachEvent",
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        party: event.party,
        payload: { description: event.payload.description },
      },
    ],
  };
}

function handleExpiry(
  _event: NDAEvent,
  ctx: ContractLogicContext<NDAData>,
): ContractResponse<NDAResponse> {
  const fulfilledObligations = ctx.state.obligations.map((o) =>
    o.status === "pending" ? { ...o, status: "fulfilled" as const } : o,
  );

  return {
    state: {
      ...ctx.state,
      status: "completed",
      obligations: fulfilledObligations,
      history: [...ctx.state.history, _event],
    },
    result: { message: "NDA term expired. All pending obligations fulfilled." },
  };
}

function handleTermination(
  event: NDAEvent,
  ctx: ContractLogicContext<NDAData>,
): ContractResponse<NDAResponse> {
  return {
    state: {
      ...ctx.state,
      status: "terminated",
      history: [...ctx.state.history, event],
    },
    result: {
      message: `Agreement terminated. Reason: ${event.payload.terminationReason ?? "not specified"}`,
    },
  };
}

function addMonths(isoDate: string, months: number): string {
  const d = new Date(isoDate);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

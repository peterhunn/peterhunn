/**
 * Core types for the legal agent contract stack.
 *
 * These map to Accord Protocol concepts but are expressed as plain TypeScript
 * rather than Concerto .cto files or Ergo functions, making them natively
 * readable and writable by code-capable AI agents.
 */

// Base type for all contract data models.
// The "$class" field preserves Concerto namespace compatibility.
export type ContractData = {
  $class: string;
  [key: string]: unknown;
};

// A party to a contract.
export interface Party {
  $class: "org.accordproject.party.Party";
  partyId: string;
  name: string;
  role?: string;
  email?: string;
  address?: string;
}

// A contractual obligation assigned to a party.
export interface Obligation {
  obligationId: string;
  party: string;           // partyId of the obligated party
  action: string;          // plain-language description
  deadline?: string;       // ISO 8601
  condition?: string;      // condition that triggers this obligation
  status: ObligationStatus;
}

export type ObligationStatus = "pending" | "fulfilled" | "breached" | "excused";

// An event submitted to contract logic (replaces Ergo request types).
export interface ContractEvent {
  $class: string;
  eventId: string;
  timestamp: string;       // ISO 8601
  party?: string;          // partyId of the party submitting the event
  payload: Record<string, unknown>;
}

// Mutable state tracked across the contract lifecycle.
export interface ContractState {
  stateId: string;
  status: ContractStatus;
  obligations: Obligation[];
  history: ContractEvent[];
  data: Record<string, unknown>;
}

export type ContractStatus =
  | "draft"
  | "active"
  | "completed"
  | "terminated"
  | "breached";

// The result returned by ContractLogic.execute — mirrors the Accord Protocol response.
export interface ContractResponse<TResult = unknown> {
  state: ContractState;
  result: TResult;
  emit?: ContractEvent[];
  error?: string;
}

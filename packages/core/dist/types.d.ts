/**
 * Core types for the legal agent contract stack.
 *
 * These map to Accord Protocol concepts but are expressed as plain TypeScript
 * rather than Concerto .cto files or Ergo functions, making them natively
 * readable and writable by code-capable AI agents.
 */
export type ContractData = {
    $class: string;
    [key: string]: unknown;
};
export interface Party {
    $class: "org.accordproject.party.Party";
    partyId: string;
    name: string;
    role?: string;
    email?: string;
    address?: string;
}
export interface Obligation {
    obligationId: string;
    party: string;
    action: string;
    deadline?: string;
    condition?: string;
    status: ObligationStatus;
}
export type ObligationStatus = "pending" | "fulfilled" | "breached" | "excused";
export interface ContractEvent {
    $class: string;
    eventId: string;
    timestamp: string;
    party?: string;
    payload: Record<string, unknown>;
}
export interface ContractState {
    stateId: string;
    status: ContractStatus;
    obligations: Obligation[];
    history: ContractEvent[];
    data: Record<string, unknown>;
}
export type ContractStatus = "draft" | "active" | "completed" | "terminated" | "breached";
export interface ContractResponse<TResult = unknown> {
    state: ContractState;
    result: TResult;
    emit?: ContractEvent[];
    error?: string;
}
/**
 * Structured representation of key legal terms extracted from a contract template.
 * Operators supply this at template registration time; the facilitator stores it
 * alongside the template so callers can filter and compare agreements programmatically
 * without re-parsing the natural-language text.
 *
 * All fields are optional — supply only the terms relevant to your template.
 * Use `extras` for clauses that don't fit the standard fields.
 */
export interface ContractTerms {
    liabilityCap?: {
        amount: number;
        currency: string;
    };
    governingLaw?: string;
    jurisdiction?: string;
    terminationNotice?: {
        days: number;
    };
    paymentTerms?: {
        netDays: number;
    };
    autoRenewal?: boolean;
    disputeResolution?: "arbitration" | "litigation" | "mediation";
    indemnification?: "mutual" | "unilateral" | "none";
    confidentiality?: "mutual" | "unilateral" | "none";
    /** Operator-defined clauses not covered by the standard fields. */
    extras?: Record<string, unknown>;
}
//# sourceMappingURL=types.d.ts.map
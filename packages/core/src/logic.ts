import type {
  ContractData,
  ContractEvent,
  ContractResponse,
  ContractState,
} from "./types.js";

/**
 * The execution context passed to ContractLogic.execute on every event.
 * Mirrors the Accord Protocol request/state pattern.
 */
export interface ContractLogicContext<T extends ContractData> {
  /** The immutable contract data (parameters agreed at signing). */
  data: T;
  /** Current mutable contract state. */
  state: ContractState;
  /** Wall-clock time of the event, used for deadline evaluation. */
  now: Date;
}

/**
 * ContractLogic — the TypeScript replacement for Ergo.
 *
 * Ergo is a purpose-built functional DSL for contract logic. We replace it with
 * a plain TypeScript interface so that:
 *   1. Developers write familiar code with full npm ecosystem access.
 *   2. Code-capable LLMs can read, reason over, and generate contract logic.
 *   3. The logic runs anywhere TypeScript runs — no Ergo runtime required.
 *
 * The interface mirrors the Accord Protocol:
 *   - `init` is called once at contract activation to build initial state.
 *   - `execute` is called for each ContractEvent and returns updated state + result.
 */
export interface ContractLogic<
  TData extends ContractData,
  TEvent extends ContractEvent = ContractEvent,
  TResult = unknown,
> {
  /**
   * Called once when the contract is activated.
   * Returns the initial ContractState (obligations, status, etc).
   * If omitted, a default empty state is used.
   */
  init?(data: TData): ContractState;

  /**
   * Called for each event submitted to the contract.
   * Must return updated state and a result payload.
   */
  execute(
    event: TEvent,
    ctx: ContractLogicContext<TData>,
  ): ContractResponse<TResult>;
}

/** Helper: build a minimal initial ContractState. */
export function initialState(overrides?: Partial<ContractState>): ContractState {
  return {
    stateId: crypto.randomUUID(),
    status: "active",
    obligations: [],
    history: [],
    data: {},
    ...overrides,
  };
}

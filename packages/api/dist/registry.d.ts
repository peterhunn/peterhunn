import type { ContractData } from "@legal-agents/core";
import type { ContractModel, ContractTemplate, ContractLogic } from "@legal-agents/core";
export interface ContractRegistration<T extends ContractData = ContractData> {
    model: ContractModel<T>;
    template: ContractTemplate<T>;
    logic: ContractLogic<T>;
}
/**
 * Maps contract type names to their model/template/logic triple.
 *
 * Register all contract types at startup, then pass to createApp().
 * Type names are used as URL path segments, e.g. "nda" → /contracts/nda/*.
 *
 * Example:
 *   const registry = new ContractRegistry();
 *   registry.register("nda", { model: ndaModel, template: ndaTemplate, logic: ndaLogic });
 */
export declare class ContractRegistry {
    private readonly entries;
    register<T extends ContractData>(name: string, reg: ContractRegistration<T>): this;
    get<T extends ContractData = ContractData>(name: string): ContractRegistration<T> | undefined;
    types(): string[];
}
//# sourceMappingURL=registry.d.ts.map
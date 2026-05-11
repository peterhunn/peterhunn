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
export class ContractRegistry {
    entries = new Map();
    register(name, reg) {
        this.entries.set(name, reg);
        return this;
    }
    get(name) {
        return this.entries.get(name);
    }
    types() {
        return [...this.entries.keys()];
    }
}
//# sourceMappingURL=registry.js.map
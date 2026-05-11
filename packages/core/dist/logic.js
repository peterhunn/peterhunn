/** Helper: build a minimal initial ContractState. */
export function initialState(overrides) {
    return {
        stateId: crypto.randomUUID(),
        status: "active",
        obligations: [],
        history: [],
        data: {},
        ...overrides,
    };
}
//# sourceMappingURL=logic.js.map
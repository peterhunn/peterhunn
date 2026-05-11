export class InMemoryStore {
    map = new Map();
    async get(contractId, orgId) {
        const stored = this.map.get(contractId);
        if (!stored)
            return undefined;
        if (orgId !== undefined && stored.orgId !== orgId)
            return undefined;
        return stored;
    }
    async set(contractId, contract) {
        this.map.set(contractId, contract);
    }
    async delete(contractId) {
        this.map.delete(contractId);
    }
    async findWithDueObligations(now) {
        const result = [];
        for (const [contractId, stored] of this.map) {
            if (stored.state.status !== "active")
                continue;
            const hasDue = stored.state.obligations.some((o) => o.status === "pending" &&
                o.deadline !== undefined &&
                new Date(o.deadline) <= now);
            if (hasDue)
                result.push({ contractId, stored });
        }
        return result;
    }
}
//# sourceMappingURL=store.js.map
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPendingContractStore } from "../pending.js";

describe("InMemoryPendingContractStore", () => {
  it("create stores and get retrieves an entry", async () => {
    const store = new InMemoryPendingContractStore();
    const entry = await store.create({
      contractId: "cid-1",
      templateHash: "hash-abc",
      requiredParties: 2,
    });
    assert.equal(entry.contractId, "cid-1");
    assert.equal(entry.requiredParties, 2);
    assert.deepEqual(entry.acceptances, []);

    const got = await store.get("cid-1");
    assert.ok(got !== null);
    assert.equal(got?.contractId, "cid-1");
  });

  it("get returns null for unknown contractId", async () => {
    const store = new InMemoryPendingContractStore();
    assert.equal(await store.get("unknown"), null);
  });

  it("addParty appends an acceptance", async () => {
    const store = new InMemoryPendingContractStore();
    await store.create({ contractId: "cid-1", templateHash: "h", requiredParties: 2 });
    const entry = await store.addParty("cid-1", "party-a", { name: "Alice" });
    assert.ok(entry !== null);
    assert.equal(entry?.acceptances.length, 1);
    assert.equal(entry?.acceptances[0]?.partyId, "party-a");
  });

  it("addParty returns null for unknown contractId", async () => {
    const store = new InMemoryPendingContractStore();
    const result = await store.addParty("unknown", "party-a", {});
    assert.equal(result, null);
  });

  it("complete removes the entry", async () => {
    const store = new InMemoryPendingContractStore();
    await store.create({ contractId: "cid-1", templateHash: "h", requiredParties: 2 });
    await store.complete("cid-1");
    assert.equal(await store.get("cid-1"), null);
  });

  it("multiple parties accumulate in acceptances", async () => {
    const store = new InMemoryPendingContractStore();
    await store.create({ contractId: "cid-1", templateHash: "h", requiredParties: 3 });
    await store.addParty("cid-1", "party-a", { name: "Alice" });
    await store.addParty("cid-1", "party-b", { name: "Bob" });
    const entry = await store.get("cid-1");
    assert.equal(entry?.acceptances.length, 2);
  });
});

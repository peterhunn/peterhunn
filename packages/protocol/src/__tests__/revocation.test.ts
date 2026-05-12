import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRevocationStore } from "../revocation.js";

describe("InMemoryRevocationStore", () => {
  it("isRevoked returns false before any revocation", async () => {
    const store = new InMemoryRevocationStore();
    assert.equal(await store.isRevoked("cid-1"), false);
  });

  it("isRevoked returns true after revoke()", async () => {
    const store = new InMemoryRevocationStore();
    await store.revoke("cid-1");
    assert.equal(await store.isRevoked("cid-1"), true);
  });

  it("does not affect other contractIds", async () => {
    const store = new InMemoryRevocationStore();
    await store.revoke("cid-1");
    assert.equal(await store.isRevoked("cid-2"), false);
  });

  it("accepts an optional reason without throwing", async () => {
    const store = new InMemoryRevocationStore();
    await assert.doesNotReject(() => store.revoke("cid-1", "Terms violation"));
  });

  it("revoke is idempotent", async () => {
    const store = new InMemoryRevocationStore();
    await store.revoke("cid-1");
    await store.revoke("cid-1");
    assert.equal(await store.isRevoked("cid-1"), true);
  });
});

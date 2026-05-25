import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  signEip712Agreement,
  verifyEip712Agreement,
  deriveTokenId,
  type Eip712AgreementData,
} from "../evm.js";

// Known test private key (Hardhat/Anvil account 0)
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Corresponding address for account 0
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// A different private key (Hardhat/Anvil account 1) — wrong signer
const OTHER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OTHER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const SAMPLE_AGREEMENT: Eip712AgreementData = {
  contractId: "contract-abc-123",
  templateHash: "0xdeadbeef0000000000000000000000000000000000000000000000000000cafe",
  partyId: TEST_ADDRESS,
  resource: "*",
  issuedAt: 1700000000,
  expiresAt: 1700003600,
};

describe("signEip712Agreement + verifyEip712Agreement round-trip", () => {
  it("signature from known key verifies correctly", async () => {
    const sig = await signEip712Agreement(SAMPLE_AGREEMENT, TEST_PRIVATE_KEY as `0x${string}`);
    assert.ok(sig.startsWith("0x"), "signature should be 0x-prefixed");
    assert.ok(sig.length > 10, "signature should have non-trivial length");

    const valid = await verifyEip712Agreement(SAMPLE_AGREEMENT, sig, TEST_ADDRESS);
    assert.strictEqual(valid, true, "signature should verify against signer address");
  });

  it("signature verifies with correct chainId", async () => {
    const chainId = 137; // Polygon
    const sig = await signEip712Agreement(SAMPLE_AGREEMENT, TEST_PRIVATE_KEY as `0x${string}`, chainId);
    const valid = await verifyEip712Agreement(SAMPLE_AGREEMENT, sig, TEST_ADDRESS, chainId);
    assert.strictEqual(valid, true);
  });

  it("same inputs produce same signature (deterministic)", async () => {
    const sig1 = await signEip712Agreement(SAMPLE_AGREEMENT, TEST_PRIVATE_KEY as `0x${string}`);
    const sig2 = await signEip712Agreement(SAMPLE_AGREEMENT, TEST_PRIVATE_KEY as `0x${string}`);
    assert.strictEqual(sig1, sig2, "EIP-712 signing is deterministic for the same inputs");
  });

  it("different contractId produces different signature", async () => {
    const other = { ...SAMPLE_AGREEMENT, contractId: "different-contract-id" };
    const sig1 = await signEip712Agreement(SAMPLE_AGREEMENT, TEST_PRIVATE_KEY as `0x${string}`);
    const sig2 = await signEip712Agreement(other, TEST_PRIVATE_KEY as `0x${string}`);
    assert.notStrictEqual(sig1, sig2);
  });
});

describe("verifyEip712Agreement — wrong signer", () => {
  it("returns false when verified against a different address", async () => {
    const sig = await signEip712Agreement(SAMPLE_AGREEMENT, TEST_PRIVATE_KEY as `0x${string}`);
    // Verify against OTHER_ADDRESS — should fail
    const valid = await verifyEip712Agreement(SAMPLE_AGREEMENT, sig, OTHER_ADDRESS);
    assert.strictEqual(valid, false, "should return false for wrong signer address");
  });

  it("returns false when verified against zero address", async () => {
    const sig = await signEip712Agreement(SAMPLE_AGREEMENT, TEST_PRIVATE_KEY as `0x${string}`);
    const valid = await verifyEip712Agreement(SAMPLE_AGREEMENT, sig, "0x0000000000000000000000000000000000000000");
    assert.strictEqual(valid, false);
  });

  it("returns false for a malformed signature", async () => {
    const valid = await verifyEip712Agreement(SAMPLE_AGREEMENT, "0xdeadbeef" as `0x${string}`, TEST_ADDRESS);
    assert.strictEqual(valid, false, "malformed signature should not verify");
  });

  it("returns false when agreement data is tampered after signing", async () => {
    const sig = await signEip712Agreement(SAMPLE_AGREEMENT, TEST_PRIVATE_KEY as `0x${string}`);
    const tampered = { ...SAMPLE_AGREEMENT, contractId: "tampered-id" };
    const valid = await verifyEip712Agreement(tampered, sig, TEST_ADDRESS);
    assert.strictEqual(valid, false, "tampered data should fail verification");
  });
});

describe("deriveTokenId", () => {
  it("is deterministic for the same contractId", () => {
    const id1 = deriveTokenId("my-contract-123");
    const id2 = deriveTokenId("my-contract-123");
    assert.strictEqual(id1, id2, "tokenId derivation must be deterministic");
  });

  it("returns a bigint", () => {
    const tokenId = deriveTokenId("some-uuid-here");
    assert.strictEqual(typeof tokenId, "bigint");
  });

  it("produces different tokenIds for different contractIds", () => {
    const id1 = deriveTokenId("contract-a");
    const id2 = deriveTokenId("contract-b");
    assert.notStrictEqual(id1, id2);
  });

  it("matches known keccak256 output for 'test'", () => {
    // keccak256(utf8('test')) = 0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658
    const tokenId = deriveTokenId("test");
    const expected = BigInt("0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658");
    assert.strictEqual(tokenId, expected);
  });
});

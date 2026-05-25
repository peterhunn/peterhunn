/**
 * EVM utilities for the x490 facilitator.
 *
 * Provides optional EIP-712 credential signing and ERC-721 NFT minting.
 * All functions are safe to call when env vars are absent — they throw only
 * on explicit misconfiguration, so callers should guard with env-var checks.
 */

import {
  createWalletClient,
  http,
  keccak256,
  toBytes,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import type { Hex } from "viem";

// ── EIP-712 domain & types ────────────────────────────────────────────────────

const EIP712_TYPES = {
  Agreement: [
    { name: "contractId", type: "string" },
    { name: "templateHash", type: "string" },
    { name: "partyId", type: "address" },
    { name: "resource", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export interface Eip712AgreementData {
  contractId: string;
  templateHash: string;
  partyId: string;   // wallet address
  resource: string;
  issuedAt: number;
  expiresAt: number;
}

function buildDomain(chainId: number) {
  return {
    name: "x490" as const,
    version: "1" as const,
    chainId,
  };
}

/**
 * Sign an agreement with EIP-712 typed data.
 *
 * @param agreement  - Agreement fields to sign.
 * @param signerKey  - 0x-prefixed hex private key.
 * @param chainId    - EVM chain ID (default 1 = Ethereum mainnet).
 * @returns          - 0x-prefixed ECDSA signature string.
 */
export async function signEip712Agreement(
  agreement: Eip712AgreementData,
  signerKey: Hex,
  chainId = 1,
): Promise<Hex> {
  const account = privateKeyToAccount(signerKey);
  const signature = await account.signTypedData({
    domain: buildDomain(chainId),
    types: EIP712_TYPES,
    primaryType: "Agreement",
    message: {
      contractId: agreement.contractId,
      templateHash: agreement.templateHash,
      partyId: agreement.partyId as Hex,
      resource: agreement.resource,
      issuedAt: BigInt(agreement.issuedAt),
      expiresAt: BigInt(agreement.expiresAt),
    },
  });
  return signature;
}

/**
 * Verify an EIP-712 agreement signature.
 *
 * @param agreement       - The agreement data that was signed.
 * @param signature       - 0x-prefixed signature to verify.
 * @param expectedSigner  - 0x-prefixed Ethereum address of the expected signer.
 * @param chainId         - EVM chain ID (default 1).
 * @returns               - true if the signature was produced by expectedSigner.
 */
export async function verifyEip712Agreement(
  agreement: Eip712AgreementData,
  signature: Hex,
  expectedSigner: string,
  chainId = 1,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      domain: buildDomain(chainId),
      types: EIP712_TYPES,
      primaryType: "Agreement",
      message: {
        contractId: agreement.contractId,
        templateHash: agreement.templateHash,
        partyId: agreement.partyId as Hex,
        resource: agreement.resource,
        issuedAt: BigInt(agreement.issuedAt),
        expiresAt: BigInt(agreement.expiresAt),
      },
      signature,
    });
    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}

// ── ERC-721 minting ───────────────────────────────────────────────────────────

const NFT_MINT_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    name: "mint",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface MintNftOpts {
  rpcUrl: string;
  contractAddress: string;
  privateKey: string;
}

export interface MintNftResult {
  tokenId: bigint;
  txHash: string;
}

/**
 * Derive the NFT token ID from a contract ID.
 * tokenId = keccak256(utf8(contractId)) interpreted as a BigInt.
 */
export function deriveTokenId(contractId: string): bigint {
  const hash = keccak256(toBytes(contractId));
  return BigInt(hash);
}

/**
 * Mint an ERC-721 NFT for the given wallet address.
 *
 * @param walletAddress  - Recipient address (0x…).
 * @param contractId     - Agreement contract ID (used to derive tokenId).
 * @param opts           - RPC URL, NFT contract address, and minter private key.
 * @returns              - The tokenId and transaction hash.
 */
export async function mintAgreementNft(
  walletAddress: string,
  contractId: string,
  opts: MintNftOpts,
): Promise<MintNftResult> {
  const account = privateKeyToAccount(opts.privateKey as Hex);

  // Build a chain descriptor with the RPC URL — we only need basic chain info.
  const chain = {
    ...mainnet,
    rpcUrls: {
      default: { http: [opts.rpcUrl] },
      public: { http: [opts.rpcUrl] },
    },
  };

  const client = createWalletClient({
    account,
    chain,
    transport: http(opts.rpcUrl),
  });

  const tokenId = deriveTokenId(contractId);

  const txHash = await client.writeContract({
    address: opts.contractAddress as Hex,
    abi: NFT_MINT_ABI,
    functionName: "mint",
    args: [walletAddress as Hex, tokenId],
  });

  return { tokenId, txHash };
}

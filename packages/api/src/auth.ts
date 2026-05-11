export interface ApiKey {
  id: string;
  orgId: string;
  name: string;
  keyHash: string;    // sha256 of raw key — never stored in plaintext
  mode: "live" | "test";
  /**
   * When set, this key represents a specific contract party.
   * Events submitted with this key are automatically attributed to partyId
   * without the caller having to pass `party` in the request body.
   * This is how AI agents sign their contract actions.
   */
  partyId?: string;
  createdAt: Date;
  revokedAt?: Date;
}

export interface ApiKeyStore {
  create(
    orgId: string,
    name: string,
    mode: "live" | "test",
    partyId?: string,
  ): Promise<{ key: ApiKey; raw: string }>;
  findByRawKey(raw: string): Promise<ApiKey | undefined>;
  list(orgId: string): Promise<ApiKey[]>;
  revoke(id: string): Promise<void>;
}

/** sha256 hex of the raw key string — used for safe storage and lookup. */
export async function hashApiKey(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a new raw API key and its hash.
 * Format: sk_live_<64 hex chars>  /  sk_test_<64 hex chars>
 * The raw value is shown to the user exactly once; only the hash is stored.
 */
export async function generateApiKey(
  mode: "live" | "test",
): Promise<{ raw: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const raw = `sk_${mode}_${hex}`;
  return { raw, hash: await hashApiKey(raw) };
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly keys = new Map<string, ApiKey>();

  async create(
    orgId: string,
    name: string,
    mode: "live" | "test",
    partyId?: string,
  ): Promise<{ key: ApiKey; raw: string }> {
    const { raw, hash } = await generateApiKey(mode);
    const key: ApiKey = {
      id: crypto.randomUUID(),
      orgId,
      name,
      keyHash: hash,
      mode,
      partyId,
      createdAt: new Date(),
    };
    this.keys.set(key.id, key);
    return { key, raw };
  }

  async findByRawKey(raw: string): Promise<ApiKey | undefined> {
    const hash = await hashApiKey(raw);
    return [...this.keys.values()].find(
      (k) => k.keyHash === hash && !k.revokedAt,
    );
  }

  async list(orgId: string): Promise<ApiKey[]> {
    return [...this.keys.values()].filter(
      (k) => k.orgId === orgId && !k.revokedAt,
    );
  }

  async revoke(id: string): Promise<void> {
    const key = this.keys.get(id);
    if (key) this.keys.set(id, { ...key, revokedAt: new Date() });
  }
}

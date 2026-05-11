export interface ApiKey {
    id: string;
    orgId: string;
    name: string;
    keyHash: string;
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
    create(orgId: string, name: string, mode: "live" | "test", partyId?: string): Promise<{
        key: ApiKey;
        raw: string;
    }>;
    findByRawKey(raw: string): Promise<ApiKey | undefined>;
    list(orgId: string): Promise<ApiKey[]>;
    revoke(id: string): Promise<void>;
}
/** sha256 hex of the raw key string — used for safe storage and lookup. */
export declare function hashApiKey(raw: string): Promise<string>;
/**
 * Generate a new raw API key and its hash.
 * Format: sk_live_<64 hex chars>  /  sk_test_<64 hex chars>
 * The raw value is shown to the user exactly once; only the hash is stored.
 */
export declare function generateApiKey(mode: "live" | "test"): Promise<{
    raw: string;
    hash: string;
}>;
export declare class InMemoryApiKeyStore implements ApiKeyStore {
    private readonly keys;
    create(orgId: string, name: string, mode: "live" | "test", partyId?: string): Promise<{
        key: ApiKey;
        raw: string;
    }>;
    findByRawKey(raw: string): Promise<ApiKey | undefined>;
    list(orgId: string): Promise<ApiKey[]>;
    revoke(id: string): Promise<void>;
}
//# sourceMappingURL=auth.d.ts.map
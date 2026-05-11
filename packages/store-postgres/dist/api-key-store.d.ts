import type postgres from "postgres";
import type { ApiKeyStore, ApiKey } from "@legal-agents/api";
type Sql = ReturnType<typeof postgres>;
export declare class PostgresApiKeyStore implements ApiKeyStore {
    private readonly sql;
    constructor(sql: Sql);
    create(orgId: string, name: string, mode: "live" | "test", partyId?: string): Promise<{
        key: ApiKey;
        raw: string;
    }>;
    findByRawKey(raw: string): Promise<ApiKey | undefined>;
    list(orgId: string): Promise<ApiKey[]>;
    revoke(id: string): Promise<void>;
}
export {};
//# sourceMappingURL=api-key-store.d.ts.map
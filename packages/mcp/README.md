# @x490/mcp

MCP server for x490 — lets Claude and other MCP-compatible AI assistants handle legal contract agreements autonomously.

```
npm install @x490/mcp
```

## What it does

The MCP server gives Claude the ability to inspect contract requirements, read template text, accept agreements, revoke them, and retrieve cached tokens — all without custom prompting. When wired up, Claude can navigate x490-gated APIs autonomously, handling the full contract lifecycle as part of normal tool use.

## Tools

| Tool | What it does |
|------|-------------|
| `inspect_requirements` | Fetch a URL and return its x490 `ContractRequirements` (status 490 or 402 response) |
| `fetch_template` | Fetch and return the full contract template text from a `templateUrl` |
| `accept_contract` | POST party data to `acceptEndpoint`, cache the returned token |
| `revoke_agreement` | POST to `revokeEndpoint`, remove the agreement from cache |
| `list_agreements` | List all active cached agreements in the current session |
| `get_token` | Retrieve a cached token by `contractId` or resource path |

**Resource:** `x490://agreements` — JSON snapshot of all active cached agreements, readable by the host.

## Claude Desktop setup

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x490": {
      "command": "npx",
      "args": ["-y", "@x490/mcp"]
    }
  }
}
```

Config file locations:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop after saving.

## Programmatic use (custom MCP hosts)

```typescript
import { createX490McpServer } from "@x490/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createX490McpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

Each call to `createX490McpServer()` creates an isolated instance with its own agreement cache.

## Example agent interaction

Given: "Fetch the data at `https://api.example.com/data`"

1. Claude calls `inspect_requirements({ url: "https://api.example.com/data" })` — sees NDA requirements including `templateUrl`, `acceptEndpoint`, and required party fields.
2. Claude calls `fetch_template({ templateUrl: "https://api.example.com/contracts/nda.md" })` — reads the full contract text.
3. Claude calls `accept_contract({ acceptEndpoint: "...", templateId: "...", templateHash: "...", partyData: { name: "Claude", jurisdiction: "California" } })` — receives and caches a token.
4. Claude makes the original request with the `X-490-Contract: <token>` header and returns the data to the user.

## Relation to ContractClient

`@x490/mcp` is for MCP-based AI assistants (Claude Desktop, custom MCP hosts). For programmatic use in TypeScript or Python applications — where no LLM is involved — use `ContractClient` from `@x490/protocol` or the `x490` Python package instead. Both auto-traverse x490 gates without any AI involvement.

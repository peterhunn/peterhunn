# Using the x490 MCP server with Claude Desktop

Build the package first:

```bash
npm run build --workspace=packages/mcp
```

Add to your `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "x490": {
      "command": "node",
      "args": ["/path/to/peterhunn/packages/mcp/dist/index.js"]
    }
  }
}
```

## What Claude can do with this server

Once connected, Claude has six tools:

| Tool | Purpose |
|---|---|
| `inspect_requirements` | Fetch a URL and read its contract requirements before agreeing |
| `fetch_template` | Read the full contract text (understand what you're signing) |
| `accept_contract` | Accept terms, negotiate, or co-sign a multi-party contract |
| `revoke_agreement` | Terminate an existing agreement |
| `list_agreements` | See all active agreements in the current session |
| `get_token` | Retrieve the `X-490-Contract` header value for a resource |

And one resource:

- `x490://agreements` — live JSON snapshot of cached agreement tokens

## Example prompt

> "I need to access https://api.example.com/data. Check what contract is required, read the template, and if the terms are reasonable accept it as: name=Acme AI, jurisdiction=California."

Claude will call `inspect_requirements`, then `fetch_template`, reason over the terms, and call `accept_contract` only if it judges them acceptable — rather than auto-accepting blindly.

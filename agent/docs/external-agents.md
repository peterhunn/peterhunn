# Calling external agents (MCP)

OpenClaw can hand work off to other agents you (or someone else) built.
Three interop paths — pick based on what the other agent already speaks:

| Path | Package | When to use |
|---|---|---|
| **MCP server** | `mcp-http` | Recommended default. Standard protocol, works with everything (Claude Desktop, Cursor, ChatGPT desktop, etc.) without rewriting. |
| **ACP** | `acp-core` | OpenClaw's peer-to-peer agent protocol. Use when you want bidirectional conversation between agents, not just tool calls. |
| **Plain HTTP tool** | `plugin-sdk` | Fastest. Wrap any existing REST endpoint as a custom tool. |

## Example: your trading agent

Assuming your trading agent exposes an MCP server on `127.0.0.1:8710` with
tools `get_positions`, `propose_trade`, `execute_order`:

```jsonc
// ~/Library/Application Support/openclaw/config.jsonc
{
  "mcp": {
    "servers": {
      "trader": {
        "transport": "http",
        "url": "http://127.0.0.1:8710",
        "toolsAllowed": ["get_positions", "propose_trade", "execute_order"]
      }
    }
  }
}
```

Then in a chat / automation:

```
you (Telegram)  →  OpenClaw (Gemma 4 parses intent, drafts proposal)
                →  trader.propose_trade({...})
                →  OpenClaw asks you on Telegram: "Sell 100 AAPL @ market, confirm?"
                →  you: "yes"
                →  trader.execute_order(proposalId, confirmationToken)
```

## Non-negotiable trading guardrails

Same shape as the draft-first email pattern, higher stakes:

- **Two-call design**: `propose_trade` returns a signed proposal id;
  `execute_order` requires that id **and** a fresh user confirmation
  token. Model can call `propose`; only a user-confirmed action calls
  `execute`. Enforce this in the trading agent, not in a prompt.
- **Hard caps in the trading agent** (never the model): per-order size,
  per-day dollar volume, per-symbol whitelist, market-hours only,
  no-shorting flag. Model asks for anything; agent refuses out-of-policy.
- **Never let Gemma 4 auto-execute.** Not because it's local — because
  it's an 8B model. Frontier models shouldn't auto-execute either. This
  is a policy rule, not a capability rule.
- **Full audit trail**: enable `diagnostics-otel` and export to a local
  Prometheus + a permanent log store. Every proposal, every
  confirmation, every fill — timestamped, model-attributed. This is
  your receipt if a broker asks.
- **Dedicated confirmation channel**: don't confirm trades over the
  same Telegram bot you use for reminders. Second bot, 2FA'd account,
  minimal contact list. A compromised general-purpose channel becomes
  a compromised trading loop.

The same pattern applies to any high-stakes external agent — deploy
agent, billing agent, HR agent. Split proposal from execution; enforce
policy in the agent, not in the model prompt.

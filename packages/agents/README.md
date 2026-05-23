# @x490/agents

Claude-powered contracting agent for the x490 protocol. Provides `AgentContractClient` — a drop-in replacement for `ContractClient` that uses the Anthropic SDK to intelligently review contract terms and propose negotiation values instead of accepting blindly.

## Install

```bash
npm install @x490/agents @x490/protocol @anthropic-ai/sdk
```

Set your Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Quick start

```typescript
import { AgentContractClient } from "@x490/agents";

const client = new AgentContractClient({
  partyData: {
    name: "Acme Corp",
    email: "legal@acme.com",
  },
  // Optional: custom review callback
  onReview: async (decision, requirements) => {
    console.log(`Claude decision: ${decision.decision} — ${decision.reason}`);
    if (decision.decision === "reject") {
      throw new Error(`Contract rejected: ${decision.reason}`);
    }
  },
});

// Drop-in replacement for fetch — handles 490 contract gates automatically
const response = await client.fetch("https://api.example.com/protected-resource");
const data = await response.json();
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `partyData` | `Record<string, string>` or `(req) => Record<string, string>` | **required** | Party fields sent in the contract accept request |
| `apiKey` | `string` | `process.env.ANTHROPIC_API_KEY` | Anthropic API key |
| `model` | `string` | `"claude-sonnet-4-6"` | Claude model to use for review |
| `onReview` | `(decision, requirements) => Promise<void>` | auto-throw on reject | Called after Claude reviews requirements |
| `onRevoked` | `(contractId) => void` | — | Called when a cached token is rejected by the server |
| `tokenRefreshThreshold` | `number` | `60` | Seconds before expiry to proactively refresh token |
| `checkRevocationOnUse` | `boolean` | `false` | Call `verifyEndpoint` before using a cached token |
| `maxNegotiationRounds` | `number` | `3` | Max negotiation round-trips |
| `skipTemplateVerification` | `boolean` | `false` | Skip template hash verification (tests only) |

## How it works

When a 490 response is received, `AgentContractClient`:

1. Extracts contract requirements from the `X-490-Requirements` header
2. Sends the requirements to Claude for review
3. If Claude accepts, establishes the agreement and retries the original request
4. If Claude decides to negotiate, proposes terms via the `negotiateEndpoint`
5. If Claude rejects (and no `onReview` is provided), throws an error

The system prompt is cached with `cache_control: { type: "ephemeral" }` so repeated calls to the same server benefit from prompt caching.

# Legal Agent Infrastructure — Architecture

## The Core Insight

The Accord Project created a three-layer contract stack:

| Layer | Accord Project | This SDK |
|---|---|---|
| Text | Cicero Markdown templates | `ContractTemplate` |
| Data | Concerto `.cto` models | TypeScript interfaces |
| Logic | Ergo functions | TypeScript functions |

AI agents already understand all three layers: LLMs are trained on Markdown, JSON schemas, and TypeScript. The stack is natively AI-readable. This SDK exposes that stack as developer infrastructure for building legal AI agents.

## What We Build

`@legal-agents/core` and `@legal-agents/agents` — a TypeScript-first SDK for:

- **Defining** contract models as typed TypeScript interfaces (compatible with Concerto namespaces)
- **Drafting and parsing** contracts via Cicero-compatible Markdown templates
- **Executing** contract logic in TypeScript (obligations, state transitions, breach detection) — replacing Ergo
- **Exposing** contracts as AI agent tools (function-calling compatible with Anthropic, OpenAI, etc.)

## Package Structure

```
packages/
├── core/        @legal-agents/core
│   └── src/
│       ├── types.ts      ContractData, Party, Obligation, ContractState, ContractEvent
│       ├── model.ts      ContractModel<T> — typed contract data definition
│       ├── template.ts   ContractTemplate<T> — draft/parse via Markdown
│       └── logic.ts      ContractLogic<T> — TypeScript contract execution
│
├── agents/      @legal-agents/agents
│   └── src/
│       ├── tools.ts      Tool definitions for LLM function calling
│       ├── llm.ts        Provider-agnostic LLM client interface + Anthropic adapter
│       └── agent.ts      ContractAgent<T> — orchestrates model, template, logic, LLM
│
└── examples/    @legal-agents/examples
    └── src/
        └── nda/
            ├── model.ts      NDA data model
            ├── template.ts   NDA contract template
            ├── logic.ts      NDA execution logic (confidentiality obligations, breach)
            └── agent.ts      NDA agent usage example
```

## The Contract Stack in Code

### 1. Data Layer — TypeScript replaces Concerto

Concerto `.cto` files define typed schemas for contract data. We replace them with TypeScript interfaces that carry the same namespace metadata:

```typescript
// Concerto: namespace org.accordproject.nda
// concept NDAContract { o Party disclosingParty, o Duration duration ... }

// TypeScript equivalent — fully typed, LLM-readable
export interface NDAData extends ContractData {
  "$class": "org.accordproject.nda.NDAContract";
  disclosingParty: Party;
  receivingParty: Party;
  effectiveDate: string;      // ISO 8601
  durationMonths: number;
  jurisdiction: string;
}
```

TypeScript interfaces are easier to work with than Concerto, interoperate with Zod/JSON Schema, and are understood natively by code-capable LLMs.

### 2. Template Layer — Cicero-compatible Markdown

Templates remain in Cicero Markdown format (human-readable, AI-readable). The SDK provides `ContractTemplate<T>` to `draft()` (data → text) and `parse()` (text → partial data):

```
## Non-Disclosure Agreement

This Agreement is entered into as of {{effectiveDate}} between 
{{disclosingParty.name}} ("Disclosing Party") and 
{{receivingParty.name}} ("Receiving Party").
...
```

### 3. Logic Layer — TypeScript replaces Ergo

Ergo is a purpose-built DSL for contract logic. We replace it with plain TypeScript functions that implement the `ContractLogic<T>` interface. Developers write familiar code; LLMs can read and reason over it directly.

```typescript
export const ndaLogic: ContractLogic<NDAData, NDAEvent, NDAResponse> = {
  init(data) {
    return { status: 'active', obligations: disclosureObligations(data), ... };
  },
  execute(event, ctx) {
    if (event.type === 'BREACH') return handleBreach(event, ctx);
    if (event.type === 'EXPIRY') return handleExpiry(event, ctx);
    ...
  }
};
```

### 4. Agent Layer — LLM Tool Definitions

`ContractAgent<T>` exposes the contract stack as a set of tools any LLM can call:

| Tool | What it does |
|---|---|
| `parse_contract` | Extract structured `ContractData` from raw contract text |
| `draft_contract` | Produce contract text from structured data |
| `extract_obligations` | List all party obligations with deadlines and conditions |
| `check_compliance` | Evaluate contract terms against specified requirements |
| `analyze_clause` | Explain a clause in plain language and flag risks |
| `trigger_event` | Fire a contract event (e.g. breach, payment) and return new state |
| `compare_contracts` | Diff two contract versions at the obligation level |

## Data Flow

```
                     ┌─────────────────────────────┐
                     │         AI Agent             │
                     │  (Claude / GPT + tool use)   │
                     └────────────┬────────────────-┘
                                  │ calls tools
                     ┌────────────▼────────────────-┐
                     │       ContractAgent<T>        │
                     │  orchestrates LLM + contract  │
                     └──┬──────────┬────────────┬───┘
                        │          │            │
              ┌─────────▼──┐  ┌────▼─────┐  ┌──▼──────────┐
              │  Template  │  │  Model   │  │   Logic     │
              │ draft/parse│  │ validate │  │ init/execute│
              └────────────┘  └──────────┘  └─────────────┘
```

## Design Decisions

**TypeScript over Ergo**: Ergo is correct and elegant but has a small ecosystem and requires a separate runtime. TypeScript gives access to npm, is understood by all code-capable LLMs, and runs anywhere Node runs. The tradeoff is that TypeScript logic is less formally verifiable — acceptable for a v1 developer SDK.

**Concerto-compatible namespaces**: We preserve `"$class"` fields and Concerto namespace conventions so models remain interoperable with existing Accord Project template libraries and tooling.

**Provider-agnostic LLM interface**: `LLMClient` is an adapter interface with one method (`complete`). Anthropic is the reference implementation; switching to OpenAI is a one-line change.

**No runtime Cicero dependency in core**: `ContractTemplate` is a plain TypeScript interface. The reference implementation uses a lightweight Handlebars-style renderer to avoid a heavy Java/Node Cicero dependency in the hot path. Full Cicero compatibility is available via an optional adapter.

## Target Users

- **Legal tech developers** building contract automation pipelines
- **Enterprise teams** adding AI to contract lifecycle management (CLM) systems
- **Platform developers** building AI agents that reason over legal obligations

## Accord Project Compatibility

| Accord Project | This SDK |
|---|---|
| Concerto `.cto` | TypeScript interfaces with `$class` metadata |
| Cicero templates | `ContractTemplate` with Handlebars renderer |
| Ergo logic | TypeScript `ContractLogic<T>` |
| Accord Protocol | `ContractEvent` / `ContractResponse` shapes |
| Template library | Importable as JSON models or TypeScript types |

# @x490/core

TypeScript-first contract primitives: models, templates, logic, and state. Framework-agnostic — works in Node.js, Bun, Deno, and the browser.

## Install

```bash
npm install @x490/core
```

## Concepts

| Primitive | What it is |
|-----------|------------|
| `ContractModel<T>` | Type guard + serializer for contract data |
| `ContractTemplate<T>` | Markdown template with `{{dotted.path}}` placeholders |
| `ContractLogic<TData, TEvent, TResult>` | Pure state-machine logic (init → execute) |
| `ContractState` | Runtime state: `status`, `obligations`, `metadata` |

## Usage

### 1. Define a model

```ts
import { defineModel } from "@x490/core";
import { z } from "zod";

const NdaData = z.object({
  disclosingParty: z.string(),
  receivingParty: z.string(),
  effectiveDate: z.string(),
});

export const ndaModel = defineModel(
  { name: "NDA", description: "Non-disclosure agreement" },
  (v): v is z.infer<typeof NdaData> => NdaData.safeParse(v).success,
);
```

### 2. Define a template

```ts
import { defineTemplate } from "@x490/core";

export const ndaTemplate = defineTemplate(
  ndaModel,
  `# Non-Disclosure Agreement
This NDA is entered into between {{disclosingParty}} and {{receivingParty}}
effective {{effectiveDate}}.`,
);
```

### 3. Implement logic

```ts
import type { ContractLogic } from "@x490/core";
import { initialState } from "@x490/core";

export const ndaLogic: ContractLogic<NdaData, NdaEvent, NdaResult> = {
  init(data) {
    return initialState({ metadata: { parties: [data.disclosingParty, data.receivingParty] } });
  },
  execute(event, ctx) {
    // Return { state, result, emit? }
  },
};
```

## API

### `defineModel(meta, validator)`

Returns a `ContractModel<T>` with `.is(value)`, `.serialize(data)`, `.deserialize(raw)`.

### `defineTemplate(model, text)`

Returns a `ContractTemplate<T>` with:
- `.draft(data)` — render data into text
- `.parse(text)` — extract structured data from text
- `.variables()` — list of `{{placeholder}}` names

### `initialState(overrides?)`

Creates a fresh `ContractState` with `status: "draft"`.

### `ContractLogic<TData, TEvent, TResult>`

Interface your logic object must implement:
- `init?(data): ContractState` — called on `activate`
- `execute(event, ctx): ContractResponse<TResult>` — called on each event
- `onObligationDue?(obligation, ctx)` — called by the scheduler

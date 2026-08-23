# Models, Inference & Cost

The system is model-agnostic by design. This document specifies how
model selection actually happens, what runs where, and how we keep
inference cost from becoming the operating cost.

The premise is simple: LLM inference is a raw input to the business,
like electricity. It should be procured, tiered, measured, and
optimized. It is not a strategic dependency on any one vendor.

## Design commitments

1. **The graph is the context.** Prompts contain small, targeted
   subgraph slices — not chat transcripts, not raw email bodies.
   Small contexts are the single largest lever on cost and on model
   choice.
2. **Right-sized models per task.** Every agent-task pair is bound to
   a **model tier**, not a specific model. Tiers are what the agent
   declares; the router picks the specific model.
3. **No LLM where classical code will do.** Time math, availability
   checks, deterministic transforms, structured parsing of known
   formats, and policy evaluation are code, not prompts.
4. **Autonomy rung and model tier are paired.** Higher-autonomy
   action classes require higher-tier models. Lower rungs tolerate
   cheaper models because a manager or customer reviews the output.
5. **Everything is portable.** Prompts, agent versions, model ids,
   and inputs are stored per-task so any task can be replayed on any
   model. No lock-in to any provider.

## Model tiers

Four tiers. Everything else is packaging.

| Tier | Purpose | Typical model class | Cost order | Latency target |
| --- | --- | --- | --- | --- |
| **T0 — Rules** | No LLM. Deterministic code, regex, calendar arithmetic, structured parsers, embeddings lookup. | — | ~0 | ms |
| **T1 — Small** | Classification, extraction from structured/semi-structured input, short drafting from templates, routing, entity linking. | 7B–13B open-weight, self-hosted or serverless GPU. | ¢/1M tokens | 100–500 ms |
| **T2 — Mid** | General drafting, moderate reasoning, multi-turn summarization, intent parsing, policy-check narratives. | 30B–70B open-weight, self-hosted; or provider mid-tier. | Low $ / 1M tokens | 0.5–2 s |
| **T3 — Frontier** | Cross-domain planning, sensitive drafting, ambiguity resolution, judgment on Ask/Execute-rung actions. | Provider frontier (Claude/GPT/Gemini top tier). | $ / 1M tokens (order-of-magnitude higher) | 1–5 s |

Every agent task declares a **minimum tier**. The router may go
higher if the router's classifier says the task is out-of-distribution
for the declared tier, but never lower.

## Agent-to-tier baseline

This is the starting map. It moves with measurement (see §Promotion
and demotion).

| Agent | Task | Min tier |
| --- | --- | --- |
| Inbox | Triage classification | T1 |
| Inbox | Entity/obligation extraction | T1 |
| Inbox | Draft reply, low-stakes recipient | T2 |
| Inbox | Draft reply, sensitive recipient (counsel, medical, employer) | T3 |
| Calendar | Free-text time parsing | T1 |
| Calendar | Conflict analysis (single principal) | T1 |
| Calendar | Reshuffle proposal (multi-party, dependencies) | T2 |
| Travel | Preference matching + candidate ranking | T2 |
| Travel | Multi-leg / multi-traveler planning | T3 |
| Household | Vendor scheduling from known set | T1 |
| Household | New vendor selection with rationale | T2 |
| Family | School form triage/extraction | T1 |
| Family | Coverage planning during travel | T2 |
| Admin | Renewal detection and drafting | T1 |
| Admin | Complex forms with judgment | T2 |
| Procurement | Quote comparison narrative | T2 |
| Research | Structured research (defined query, defined sources) | T2 |
| Research | Open-ended research | T3 |
| Documents | OCR | T0 |
| Documents | Classification, field extraction | T1 |
| Documents | Contract-level summarization | T2 |
| Proactive | Obligation detection from graph scan | T0 (rules) with T1 for edge cases |
| Orchestrator | Simple single-domain intent | T2 |
| Orchestrator | Cross-domain planning (task DAG) | T3 |

Two rules run over the whole table:

- **Any task producing an Execute-rung action on a
  `write_irreversible`, `financial`, or `communication`-to-third-party
  tool must be T3.** No exceptions during Phases 1–3. Cost pressure
  does not override this.
- **Any task producing a Draft or Ask rung message routes at ≤ T2
  by default**, because a manager or customer reviews the output. The
  cost lever lives here.

## The router

A T0 classifier sitting in front of every LLM call. Its job is to
pick the model, not to reason about the task.

Inputs:

- Declared minimum tier.
- Task class (agent + task type).
- Estimated input size and expected output size.
- Household risk tier (see below).
- Recent quality signals for the target tier on this task class
  (manager edit distance, rejection rate, exception rate).
- Current cost budget state.

Output: a specific model handle from the model registry, an SLA, and
a fallback chain.

The router is where the strategic bet on cost lives. It is small,
inspectable code — not an agent, not an LLM. Its rules are versioned.
Its decisions are logged per task.

### Fallback chain

Every model call carries a fallback list. If the primary is
unavailable, over quota, or returns a low-confidence signal, the
router escalates to the next model in the chain. Fallbacks are
allowed to go *up* tier; they are not allowed to go *down* tier from
the declared minimum.

### Household risk tier

Households are tagged in the graph with a risk tier: `standard`,
`elevated`, `hnw`. Higher risk tiers pin more tasks to T3 by policy.
This lets pricing tiers actually mean something at the inference
layer: a Private-tier customer gets more frontier calls than a
Life-tier customer, deterministically.

## Where we self-host and where we don't

### Self-host

- **T1 workhorses.** Inbox triage, entity extraction, classification,
  short template-driven drafting, calendar parsing. These dominate
  token volume. Self-hosting an 8B–13B model on serverless GPU (or
  dedicated GPU past a volume threshold) drops the per-action cost
  to a small fraction of provider API pricing.
- **Embeddings.** For search and precedent matching in the graph.
  Small open-weight embedding models, self-hosted, indexed per
  household.
- **OCR and document classification.** Not LLM at all; classical
  models on CPU or small GPU.

### Provider API

- **T3 frontier** for orchestrator planning, sensitive drafting,
  judgment-heavy Ask/Execute actions. Volume is low per household
  per week; per-customer monthly cost is small.
- **T2 as an option**, especially early. Provider mid-tier models
  are competitive on quality-per-dollar until self-hosted volume
  amortizes the GPU spend.

### Rule of thumb

- Do not self-host in Phase 0. Volume is too low; ops cost dominates
  inference cost.
- Self-host a task class once (a) it exceeds a sustained token
  volume threshold, (b) quality has been measured on the open-weight
  candidate against the current provider baseline, and (c) latency
  and reliability targets are met by the candidate hosting stack.
- Re-run the buy-vs-build math quarterly. Provider prices trend down;
  open-weight capability trends up; the crossover point moves.

## Prompt and context discipline

Cost per action is a function of tokens as much as tier.

- Every agent prompt is versioned and lives in source. No inline
  ad-hoc prompts.
- Every prompt has an **input budget** (max input tokens) and an
  **output budget** (max output tokens). Router enforces.
- Context is a subgraph query, not a dump. The Inbox agent drafting
  a reply pulls the relevant `person.contact`, prior interactions
  with them, and the household's communication preferences — not
  the whole inbox and not the whole graph.
- Long documents are summarized once (T2, cached in the content
  store with provenance) and the summary — not the document — enters
  subsequent prompts.
- Caching: prompt-prefix caching where the provider supports it;
  otherwise deduplicate at the agent layer for identical prefixes
  across a batch.

## Measurement — what makes tiering data-driven

Per (agent, task type, tier) we track continuously:

- **Cost per successful action.**
- **Latency (median, p95).**
- **Quality signals**: manager edit distance on drafts; customer
  approval rate on Asks; exception rate; policy-check-fail rate;
  rollback rate on Execute.
- **Router escalation rate**: how often this class had to go up-tier.
- **Replay delta**: sampled tasks replayed on the next-tier-up model,
  scored, and compared. Answers "would the more expensive model have
  been better here?" This is how we know when to promote.
- **Replay delta down**: sampled tasks replayed on the next-tier-down
  model, scored. Answers "could the cheaper model have handled this?"
  This is how we know when to demote.

## Promotion and demotion

The per-task-class tier is not fixed. Every four weeks (or after a
material quality regression) the model council reviews the metrics
and moves task classes up or down. The rules:

- **Promote** if router escalation rate > threshold *or* manager
  edit distance trending up *or* customer rejection rate on Asks > X
  *or* exception rate up-and-to-the-right.
- **Demote** if replay-delta-down shows the cheaper tier is
  indistinguishable within a defined margin on ≥ N sampled tasks,
  *and* the class is not on the "never demote" list (Execute-rung
  irreversible/financial/communication).
- Every change is recorded, versioned, and rolled out per-household
  behind a flag. A household on `hnw` risk tier is exempt from
  demotions.

## Model registry

A single source of truth listing every model available to the router:

- Model id, provider, hosting mode (self-hosted / API), region,
  context window, function-call schema support, JSON-mode support.
- Rated tier (T1/T2/T3) and rated task classes.
- Cost per 1K input / output tokens.
- Latency SLA and observed p50/p95.
- Availability status.
- Known limitations (e.g., "does not handle date arithmetic
  reliably").
- Provenance: which internal eval set qualified it, when, by whom.

New models are added via eval, not via preference. A model does not
enter the registry until it has been benchmarked on the internal
eval suite for the tiers it is being proposed for.

## Evals

We maintain an internal, versioned eval suite per tier:

- **T1 evals**: extraction accuracy, classification F1, latency,
  cost per 1K actions.
- **T2 evals**: drafting quality (rubric-scored), constraint
  adherence, tone, entity accuracy against graph, refusal behavior.
- **T3 evals**: multi-domain planning (a "London in October"–class
  bench), sensitive drafting, edge-case judgment, calibration on
  uncertainty.

Evals are built from redacted, consented real cases where possible;
synthetic where not. Evals gate registry admission and gate every
tier promotion/demotion.

## Cost budget as a first-class control

Every household carries a monthly **inference budget** derived from
its subscription tier. The router observes cumulative spend per
household and does two things when a household approaches budget:

1. **Route more work down-tier** where quality tolerates it,
   informed by the demotion evidence.
2. **Alert the manager** when the household's action mix is
   structurally out of budget for the tier — that's a pricing signal,
   not a routing problem.

Budgets do not degrade service silently. Anything the router refuses
to route surfaces as an exception in the console.

## Vendor-independence checklist

Before adopting any single provider for anything, verify:

- The prompt runs, with acceptable quality, on at least one
  alternative provider or self-hosted model at the same tier.
- Function-calling / structured-output surface is expressed in a
  provider-agnostic schema in our code (translated at the adapter
  layer).
- No prompt relies on a provider-specific feature that lacks a
  fallback (e.g., a proprietary tool-use mode with no analog).
- Rate-limit and outage runbooks name the fallback provider and
  the expected quality delta.

The point isn't to avoid using the best model available today. The
point is to never be in a position where a single provider's
availability, pricing, or policy change is a P0 to the business.

## What this document is not

- It is not a claim that self-hosting is always cheaper. It often
  isn't, especially early. It is a specification for making that
  decision with data, per task class, on a schedule.
- It is not a commitment to a specific model vendor. Names in this
  doc are examples of *classes*.
- It is not a substitute for the eval suite. Nothing goes to
  production because it "looked good" on one example.

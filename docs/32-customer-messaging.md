# Customer messaging

How a customer reaches ATELIER, how we identify them, how we
stay compliant, and how we remember what they said last time.

Adjacent reading:
[`20-architecture.md §11`](./20-architecture.md) for the
invariant, [`23-data-model.md`](./23-data-model.md) for the
tables involved, [`40-security.md`](./40-security.md) for the
webhook signature and rate-limit posture.

## Product shape

**One number for every customer.** Every household in a tenant
shares one concierge phone number. A customer texts
+CONCIERGE from their own phone; the system identifies them by
that FROM number, routes to their household, and knows *who* in
the household is talking (not just "someone from the Carrington
household") because the number is bound to a specific person
profile.

Same code path also supports **dedicated-line deploys** (an
enterprise household with its own DID). The resolver falls back
to TO-address routing when a FROM lookup misses, so a household
that wants its own number gets its own number without any
branching in the platform.

The customer never sees software. They send a text; a manager or
an agent responds. The choreography behind that is what this
doc covers.

## The four flows

### 1. Onboarding: invite → verify

The manager clicks *Invite* on the household page in the
console, picks the profile (a `person.principal` /
`person.member` / `person.staff` / `person.contact` node), and
enters the customer's number. The server:

1. Mints a 6-digit verification code (15-min TTL).
2. Records it on `pending_verifications` with the
   `principalId` carried along.
3. Sends "Atelier: reply with `<CODE>` to connect this number to
   `<household>`. Reply STOP to opt out. Msg&data rates may apply."
   from the concierge line via `sendTwilioMessage`.

The customer replies to the concierge number with the code. The
inbound webhook's verification-claim branch:

1. Finds the live pending row by (channel, code).
2. Creates a `contact_endpoints` row bound to the household +
   the invited profile.
3. Stamps `consent_status = opted_in` / `source = "reply_yes"` —
   the customer's explicit action IS the consent signal.
4. Consumes the code (single-use).
5. Sends a "Verified — you're now connected" reply.

If the customer's number is already bound to a different
household, the claim is refused. No cross-household hijacking.

### 2. Steady state: known-endpoint inbound

Customer texts the concierge line from a number we've seen:

1. `handleInbound` resolves the endpoint by (channel,
   from-address). Missing → falls to the verification-claim
   branch above, then to unrouted.
2. Consent gate — see below.
3. Session lookup — see below.
4. Dispatch to the planner with the person node as
   `actor.id` / `actor.displayName`, plus recent turns as
   `priorTurns`.

The planner produces a plan; the orchestrator materialises
intents into agent tasks; agents call tools; the manager sees
whatever needs their judgment in the approval queue.

### 3. Consent: STOP / START

Every contact endpoint carries `consentStatus`:

| Status       | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `unknown`    | No explicit signal. Default for manager-direct adds. |
| `opted_in`   | Customer took an explicit action.                    |
| `opted_out`  | Customer sent STOP-family keyword. Outbound BLOCKED. |

**STOP-family keywords** (case-insensitive, first token of the
message): STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT.
Match → flip to `opted_out` (source `reply_stop`), return the
mandated confirmation ("You've been unsubscribed. Reply START
to opt back in."), do NOT dispatch to the planner.

**START-family keywords**: START, UNSTOP, YES. Match → flip to
`opted_in` (source `reply_start`), return the resubscribed
confirmation.

**Outbound consent gate**: `outboundConsentGate(...)` runs
before every send from `/messaging/send` and
`/messaging/invite`. If the recipient endpoint is `opted_out`,
the send is refused with 403 `recipient_opted_out`.

**Bypass for confirmations**: STOP / START confirmations
themselves are sent as inline TwiML on the webhook response,
which bypasses the consent gate. Legally required — the
confirmation must reach an opted-out endpoint.

Twilio auto-recognises many of these keywords on its side, but
we handle at the application layer so (a) the mock adapter
honours them in dev, (b) non-Twilio channels behave the same,
and (c) our own consent history is authoritative.

### 4. Conversation memory: rolling sessions

Every known-endpoint inbound opens or resumes a
`conversation_sessions` row. Same endpoint, same open session,
within `CONVERSATION_IDLE_MS` (30 min today). Sessions
auto-close on the next `openOrResume` call after the idle
window — no cleanup job.

`handleInbound` reads the last 20 turns on the active session,
maps them to `priorTurns` (customer → user, agent → assistant),
and passes them into `planAndRun`. The orchestrator interleaves
them between the cached system prompt and the current user
prompt.

Outbound sends via `/messaging/send` auto-attach to the
recipient's open session so agent replies land in the running
history for the next inbound to see.

STOP messages are deliberately session-less: opt-outs stand
outside the conversation, and we don't want them fed back into
the planner as context.

Result: "book me a car" → "actually make it 7pm" reads as an
amendment, not two disconnected first-messages.

## Configuration

Platform-level (env — set once per tenant):

```
ATELIER_TWILIO_ACCOUNT_SID
ATELIER_TWILIO_AUTH_TOKEN
ATELIER_TWILIO_FROM_NUMBER          # the concierge number
ATELIER_TWILIO_MESSAGING_SERVICE_SID  # or use a service instead
```

`ATELIER_TWILIO_AUTH_TOKEN` also drives inbound signature
verification. If unset, the webhook accepts without verifying
(dev mode) and logs a one-line notice. Never leave it unset in
production.

Per-household (via `credentialRepo`, provider `"twilio"`,
kind `"api_key"`) for enterprise households that want their own
DID:

```json
{ "account_sid": "...", "auth_token": "...",
  "from_number": "+1...", "messaging_service_sid": "..." }
```

`resolveTwilioSender(householdId)` prefers per-household when
stored, else falls back to the platform concierge credential.

Public `GET /messaging/config` returns
`{ conciergeNumber, sharedLineActive }` so the console can
display the number to hand to customers.

## Data model at a glance

```
                                      ┌─────────────────────────┐
                                      │  households             │
                                      └──────────┬──────────────┘
                                                 │
   ┌────────────────────────┐  principalId ┌─────▼──────────────┐
   │  pending_verifications │─────────────▶│  contact_endpoints │
   │  (code, ttl, consumed) │              │  (address, consent) │
   └────────────────────────┘              └─────┬──────────────┘
                                                 │
                                     endpointId  │
                                                 │
                          ┌──────────────────────▼──────────────┐
                          │  conversation_sessions              │
                          │  (open/closed, lastActivityAt)      │
                          └───────────────┬─────────────────────┘
                                          │ sessionId
                                          │
                            ┌─────────────▼──────────────┐
                            │  messaging_events           │
                            │  (inbound / outbound, body) │
                            └─────────────────────────────┘
                                          │
                                          │ principalId lookup
                                          ▼
                            ┌─────────────────────────────┐
                            │  nodes (person.*)           │
                            │  Ada Lovelace, Alex Chen, …  │
                            └─────────────────────────────┘
```

## Failure modes

| Situation                                  | Response                                                              |
| ------------------------------------------ | --------------------------------------------------------------------- |
| Twilio signature verification fails        | 403; event NOT recorded; caller sees empty response                   |
| No Twilio credential (dev)                 | `sendTwilioMessage` returns `provider: "mock"`, reason `no_twilio_credential` |
| Number bound to a different household      | Verification claim refused, code stays live for the intended household |
| Opted-out recipient receives an outbound   | 403 `recipient_opted_out` from `/messaging/send` or `/messaging/invite` |
| Unrouted from-number with no matching code | Empty TwiML for Twilio (no info leak); 404 for the mock endpoint       |
| Duplicate webhook (Twilio retry)           | Dedupe by `(provider, externalMessageId)`; planner not re-dispatched   |
| Retried STOP                               | Idempotent — endpoint already opted_out, no double confirmation        |

## Endpoints

Every route below sits in `apps/api/src/routes/messaging.ts`.

**Authenticated (manager scope):**

- `GET /households/:id/messaging/endpoints` — list
- `POST /households/:id/messaging/endpoints` — direct add
- `DELETE /households/:id/messaging/endpoints/:endpointId` — revoke
- `GET /households/:id/messaging/events` — event history
- `POST /households/:id/messaging/send` — outbound (consent-gated)
- `GET /households/:id/messaging/verifications` — pending list
- `POST /households/:id/messaging/verifications` — mint code
- `POST /households/:id/messaging/invite` — mint + send in one call
- `GET /households/:id/messaging/sessions` — open conversations

**Public:**

- `POST /messaging/inbound/mock` — dev / test
- `POST /messaging/inbound/twilio` — Twilio webhook
- `GET /messaging/config` — concierge number + status

## Reply — human OR agent

Two authoring surfaces, one send path:

- **Manager reply.** Every inbound row on the household page's
  "Recent messages" panel gets a `Reply` button. Opens a
  textarea, submits via the `sendMessage` server action, which
  hits `/messaging/send` on the API.
- **Agent reply.** The `concierge` agent handles
  `concierge.reply` intents — reads the customer's message +
  prior turns, drafts a reply via a T2 model call, and hands
  the draft to the `sms.send` tool. Policy engine defaults
  `sms.send` to `ask` autonomy (side-effect class
  `communication` forces T3 + high supervision), so
  agent-authored SMS lands as an approval unless a household
  policy explicitly promotes it to `execute`. The model can
  also set `escalate: true` in its reply to punt to the manager
  (financial commitments, complex bookings, medical/legal) —
  the tool is not called at all in that case.
- **Planner routing.** The planner's registry includes
  `concierge.reply` alongside the task-shaped intents (calendar,
  travel, admin, family). Conversational messages route here;
  a "book me a car" routes to the calendar specialist which
  emits its own outbound if needed.
- **Runtime context injection.** `PlanAndRunOptions` accepts
  `defaultIntentAttrs` — the messaging inbound path fills in
  `channel`, `toAddress`, `currentMessage`, `priorTurns`,
  `fromName` so the concierge agent (and any future
  reply-shaped intent) gets the customer context without the
  planner having to invent phone numbers.

Both paths route through **one shared helper**,
`sendOutboundMessage` in `apps/api/src/messaging-outbound.ts`.
The helper:

1. Applies the outbound consent gate — an opted-out recipient
   refuses with `refused: "opted_out"` and no Twilio API call.
2. Resolves the Twilio sender (per-household DID first, platform
   concierge fallback).
3. Sends via `sendTwilioMessage`.
4. Auto-attaches the outbound to the recipient's open
   conversation session so agent replies land in the running
   history.
5. Records a `messaging_events` row so the household's traffic
   view sees the send regardless of who authored it.

The agent side reaches the helper through a `ToolContext` seam:
`ctx.sendChannelMessage(...)`. The runtime (`buildOrchestrator`)
supplies the implementation; test contexts leave it undefined
and the tool falls back to a mock send with a visible reason.
`OrchestratorDeps.messagingOutbound` is the top-level dep name
if you're plumbing this into a new runtime.

## Instant ack + async dispatch

`handleInbound` records the event, sets up the session, and
returns a `runDispatch()` function — it does NOT wait for the
planner. Callers decide when to fire that function.

- **Twilio webhook** ships the TwiML ack ("Got it — I'm on
  this…") immediately if the household opts in (see the flag
  below), then `void runDispatch()` in the background. A
  20-second planner call no longer turns into 20 seconds of
  "waiting for reply" on the customer's phone.
- **Mock webhook** awaits `runDispatch` before returning so
  tests (and interactive dev inspection) see the completed
  planner run in the response.

Same code path, different await behaviour — the divergence is
documented in `apps/api/src/routes/messaging.ts`.

### The ack is a customer-facing agent surface — opt-in

The "Got it, will follow up" ack is agent-authored SMS going to
the customer without manager review. Under the manager-mediated
model — agents help managers, never the customer directly — that
is a violation of the default posture. So the ack is gated
per-household by `households.instantAckEnabled` (migration
0011), which defaults to **off**. `POST /households/:id/
instant-ack` toggles it (`{ enabled: true | false }`), and the
console renders an `InstantAckToggle` next to the autopilot
switch with a short explainer. Recommended default is off: keep
every customer-facing message manager-written; a household with
a shared line or out-of-hours coverage where the customer
expects an automated confirmation can opt in per-household.

Legally / transactionally required confirmations are NOT gated
by this flag and always fire regardless:

- **STOP / START consent confirmations** — TCPA-required.
- **Verification confirmations** — customer completed a binding
  step (verification code) and expects immediate feedback.

Same message the ack came from (`handleInbound`'s `ackMessage`
field); the flag only decides whether to include one for the
`dispatched` outcome.

## MMS attachments

Twilio inbound webhooks include `NumMedia` + `MediaUrl<N>` +
`MediaContentType<N>` when the customer sends photos, PDFs, or
audio. Handling:

1. The webhook returns the ack TwiML immediately (see above).
2. `downloadTwilioAttachments` runs in the background: fetches
   each URL with Twilio basic auth
   (`AccountSID:AuthToken`), pipes bytes through the
   content-addressed blob store, records a `document_blobs`
   row, and creates a `document.record` node in the graph as
   a `candidate` (needs manager / extractor review to
   categorise).
3. Per-item errors (404, oversized, malformed content) log and
   skip; other items in the same MMS still land.
4. Hard cap: `MMS_MAX_BYTES = 10 MiB` per item — well above
   real-world MMS attachments (photos ~1-3 MB, PDFs ~1 MB),
   protects the blob store from a hostile URL.

Provenance is `customer_document / twilio_inbound` with
confidence 0.7 and status `candidate`. Titles are guessed from
the MIME type (`Photo — <hash>`, `PDF — <hash>`, `Voice memo —
<hash>`, `Video — <hash>`, else `Attachment — <hash>`).

## Console — conversation view

The household page renders one thread card per contact endpoint,
ordered by most-recent activity (revoked endpoints sink to the
bottom). Each card carries:

- **Header**: profile name (from the endpoint's `principalId` →
  person-node `fullName`), the raw address, the channel tag, a
  consent pill (opted in / opted out / consent unknown), and a
  `revoked` tag if applicable.
- **Bubbles**: chronological (oldest at top). Inbound
  left-aligned in gray, outbound right-aligned in blue. Session
  boundaries render as "— new session —" separators so it's
  obvious when the 30-min idle window rolled over.
- **Bubble meta**: timestamp, delivery pill on outbound
  (delivered / read → green, sent / queued → indigo, failed →
  red with error code), and a shortened planner-run link on
  inbound rows that triggered a run.
- **Composer**: one textarea per thread at the bottom that
  posts to `/messaging/send` via the existing `sendMessage`
  server action. Disabled when the endpoint is opted-out or
  revoked with a clear inline explanation.

The old flat "Recent messages" list is preserved behind a
collapsed `<details>` for raw-event triage.

## Author attribution on outbound

Every outbound `messaging_events` row records who wrote it.
Three columns:

- `authoredByType` — `manager` | `agent` | `system` (nullable on
  inbound and on legacy outbound rows from before this landed).
- `authoredById` — the manager id, agent `name/version`
  (`concierge/0.1.0`), or `system`.
- `authoredByLabel` — display name cached at send time, so the
  console renders without a JOIN.

Wiring:

- `sendOutboundMessage(db, { …, authoredBy })` — the shared
  helper accepts optional `authoredBy: { type, id, label? }`.
- `/messaging/send` (manager path) stamps
  `{ type: "manager", id: req.actor.id, label: displayName }`.
- Agent-authored sends go through the `MessagingOutboundSink`
  seam; the orchestrator supplies
  `{ type: "agent", id: "<agent>/<version>", label: "<agent>" }`
  from `input.agent` on every tool invocation.

Console: an `AuthorPill` renders on every outbound bubble in
the conversation-thread view — slate for manager
("Ada Chen · manager"), violet for agent ("concierge · agent"),
gray for system. Manager and agent replies land the same way
in the customer's thread but read as distinctly authored so
the operator can see the mix at a glance.

## Delivery status

Every outbound row on `messaging_events` grows three columns
that Twilio's async `MessageStatus` webhook populates:

- `deliveryStatus` — `queued` | `sent` | `delivered` | `read`
  (WhatsApp) | `undelivered` | `failed`.
- `deliveryStatusAt` — timestamp of the last transition.
- `deliveryErrorCode` — Twilio's numeric error code on the
  failure path (30003 unreachable, 30005 unknown destination,
  30006 landline-can't-SMS, etc.).

Wiring:

1. Set `ATELIER_TWILIO_STATUS_CALLBACK_URL` to a public URL
   that resolves to `POST /messaging/status/twilio`. Unset in
   dev = no callbacks, status column stays null on outbound.
2. `sendTwilioMessage` passes `statusCallback: <url>` on
   `client.messages.create(...)`. Twilio starts POSTing.
3. `/messaging/status/twilio` verifies the signature (same
   `ATELIER_TWILIO_AUTH_TOKEN` as inbound), matches on
   `(provider="twilio", externalMessageId=MessageSid)`, and
   updates the row idempotently.
4. Console renders a status pill on outbound rows: green for
   delivered/read, indigo for sent/queued, red for
   failed/undelivered (with the error code in parens).

Callbacks for unknown MessageSids ack 200 (so Twilio doesn't
retry forever) and log for triage. Missing MessageSid or
MessageStatus 400s.

## Known limits
- **Single-tenant concierge.** One number per tenant, not one
  per operator. A large multi-tenant deploy would need
  per-tenant concierge routing.
- **English only** in the default invite body and STOP / START
  confirmations. `bodyOverride` on invite lets a manager
  localise.
- **Attachments don't get auto-categorised.** They land as
  `category: "other"`; a manager (or the extractor when it
  runs) reclassifies to `identity | legal | policy | record |
  receipt`. OCR on images / PDFs is a future commit.

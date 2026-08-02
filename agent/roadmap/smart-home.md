# Smart home — Google Home + Rainbird via Home Assistant

May controls the house: lights, thermostat, scenes, and the sprinklers.
Aligned with "own your AI" — cloud dependencies eliminated wherever
possible, everything terminates at a local Home Assistant instance.

## Why not now

- Base May must have run stably for ≥ 4 weeks
- Home Assistant deployed and stable on its own (either on the same
  Mac mini in Docker, or on a separate Pi 5 dedicated to it)
- Google Home devices already onboarded to Home Assistant (Nest / Cast
  / Matter integrations working)
- Rainbird LNK WiFi module confirmed reachable on your LAN, controller
  serial + password captured

## Architecture

Home Assistant is the middleware. May does **not** talk to Google or
Rainbird directly.

```
you (Telegram) ↔ May (Gemma 4)
                → MCP: home-assistant-mcp / REST call to HA
                → Home Assistant
                   ↔ Google Home devices  (via Nest/Cast/Matter)
                   ↔ Rainbird controller  (via pyrainbird integration)
                   ↔ everything else (locks, cameras, sensors, etc.)
```

Why route through HA instead of direct API integrations:

1. **One integration to maintain, not two-per-device.** HA already has
   working integrations for Google Home, Rainbird, and a hundred other
   things you'll add later.
2. **Local by default.** HA runs on your network. Google Home devices
   still need cloud for some functions, but everything Rainbird +
   sensors + scenes runs locally, no internet required.
3. **Single audit surface.** Every device action is logged in HA's
   history + logbook. You can see exactly what May turned on, when.
4. **Manual override always wins.** Physical switches, HA UI, and
   Google Home app all keep working. May is one more client, not the
   only client.

## Layers of maturity

### Layer 1 — Read-only observability

- Current state of every device (lights on/off, thermostat setpoint,
  sprinkler zone status, door locks, presence sensors)
- Recent history — "was the garage door open yesterday afternoon?"
- Alerts on anomalies — "garage door open > 30 min at night", "front
  door unlocked while everyone's asleep"
- Morning brief additions — "Rainbird ran zones 1-4 overnight for 22
  minutes total; forecast is dry, no schedule change recommended"

Risk: zero. Read-only. Build first.

### Layer 2 — Explicit-command execution

- "Turn off downstairs lights" → May calls HA → done
- "Set thermostat to 68 for tonight" → time-bounded change with
  auto-revert
- "Run sprinklers zone 3 for 10 minutes" → single-shot, not a schedule
  change
- "Skip tomorrow's watering, rain forecast" → one-off suppression via
  Rainbird's rain-delay
- "Lock the doors and set night scene" → composite scene call

Rule: every command is triggered by an explicit user request. May
executes; she doesn't decide when.

### Layer 3 — Rules & routines with hard boundaries

May follows pre-agreed routines, still executes only what's approved.

- **Wake / sleep routines** — "at 06:30 weekdays, gentle bedroom light
  ramp + kitchen lights on if someone's up (motion sensor)"
- **Presence-aware energy** — "everyone out of the house 45 min → HVAC
  eco mode, non-essential lights off, arm cameras"
- **Weather-aware irrigation** — "24 hr forecast > 60% rain → skip
  tomorrow's zones automatically; > 90°F sustained → add 15% run time
  to grass zones for the week"
- **Delivery + guest modes** — "Amazon delivery expected today → unlock
  side gate 09:00-18:00; lock at 18:01 regardless"

Everything in this layer is a **standing rule** you've approved once.
Runtime execution doesn't need per-action confirmation, but adding a
new rule always does.

### Layer 4 — Autonomous decisions (mostly say no)

Actual policy: **May does not add or change smart-home rules on her own.**
She can:

- Propose a rule ("looks like nobody uses the guest bath vent after
  22:00 — want me to auto-off it at 23:00?")
- Notice patterns ("Rainbird zone 5 has been running 40% longer than
  baseline this month — possible leak or sensor drift, want to
  investigate?")

She cannot:

- Change a rule she wasn't asked to change
- Add a new routine unilaterally
- Override a manual override for at least 24 hours (if you physically
  turn a light back on after her scene, she doesn't fight you)

## Concrete integrations

### Google Home / Google devices

- **Home Assistant integrations**: `nest` (Nest Thermostat, Nest Cams,
  Nest Doorbell), `cast` (Chromecast/Nest Hub speakers), `google_home`
  (community integration for Google Home Mini/Max routines)
- **Local-first path**: as many devices as possible via Matter/Thread
  through HA's Matter integration — bypasses Google Cloud entirely
- **Cloud-required for a subset**: Nest devices still need Google
  Cloud for some functions; accept this or replace with alternatives

### Rainbird

- **Home Assistant integration**: `rainbird` — built on the excellent
  [`pyrainbird`](https://github.com/allenporter/pyrainbird) library
- **Supported controllers**: ESP-Me, ESP-Mev, ESP-TM (all with the LNK
  WiFi module)
- **What HA exposes**: per-zone start/stop, rain-delay, current
  schedule, sensor readings (rain sensor, freeze sensor)
- **What HA does not expose** (do these in the Rainbird app):
  full schedule programming, seasonal adjust base — HA handles
  overrides and one-shot runs, not the master program

### The MCP layer for May

Two options:

**A. Community MCP server** — someone has almost certainly built an
`mcp-home-assistant` by the time you're setting this up; search
`https://github.com/topics/mcp-server`. Pin the version.

**B. Custom HTTP tool** — HA has a REST API + long-lived access
tokens. Register an OpenClaw custom tool with a narrow verb set
(`get_state`, `call_service`, `list_entities`). Faster than waiting
for the perfect community MCP.

Recommendation: start with **B** (narrow, auditable, ships in an hour),
migrate to **A** later if the community server exceeds your custom
tool's capability.

## Non-negotiable guardrails

- **Physical override always wins for 24 hours.** If a human touches
  a switch, May respects it for a day before her rules apply again.
- **Locks and cameras require explicit per-action confirmation**, not
  standing rules. "Unlock the front door" is always a Telegram
  round-trip.
- **Alarm arming/disarming is human-only.** May can propose, never
  execute.
- **Irrigation cap** — never more than `$X` gallons/day even if a rule
  says so. Prevents runaway.
- **Never modify a rule from an inbound message.** Same injection
  defense as everywhere else — instructions embedded in email/SMS
  don't get to reconfigure the house.

## Manual steps (can't be scripted)

- Deploy Home Assistant (Docker on Mac mini, or dedicated Pi)
- Onboard existing Google Home devices to HA (per-device consent flow
  through Google account)
- Get Rainbird LNK IP + password (from the LNK app), verify HA can
  reach the controller
- Create a HA long-lived access token for OpenClaw
- Decide + document standing rules (Layer 3) before enabling them —
  this belongs in a `HOUSE-RULES.md` alongside CONSENT.md

## When it fails

| Failure | Recovery |
|---|---|
| HA offline | May can't control anything, physical + app control still work |
| Google Cloud outage | Local devices via HA still work; Nest devices degrade |
| Rainbird LNK loses WiFi | HA marks controller unavailable; Rainbird's own schedule keeps running from the controller's onboard memory |
| Rule conflict (two rules fight) | HA's automation trace shows what won; explicit precedence rules resolve |
| May misinterprets a command | Every action is logged in HA + May's audit trail; roll back via the reverse action |
| Someone kicks the Home Assistant hardware | Boots from backup; SSD + snapshot recovery is 15 min |

## Order of operations, when we build

1. Deploy Home Assistant, get **existing** Google Home + Rainbird
   working through HA (independent of May)
2. Draft `HOUSE-RULES.md` — what the house should do automatically,
   who agreed to it
3. Register HA as an OpenClaw tool (option B above), narrow verb set
4. Layer 1 only for a week — May reports state, no writes
5. Layer 2 — explicit commands from you, one at a time
6. Layer 3 rules, one rule at a time, watched for a week each
7. Never Layer 4

**Home Assistant first. May second. Rules always documented before
enabled.**

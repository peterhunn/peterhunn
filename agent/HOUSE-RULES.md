# HOUSE-RULES — May's standing automations for the Hunn household

<!--
Template. Copy to ~/.openclaw/workspace/HOUSE-RULES.md once each rule
below has been discussed and agreed. May reads it as bootstrap context
along with CONSENT.md, so if she is ever asked "why did the lights just
go off?" she has the accurate answer instead of guessing.

This file governs the smart-home layer described in
roadmap/smart-home.md. Do not enable any rule until this file has been
signed and the corresponding Home Assistant automation exists.

Update in writing: when a rule changes, edit this file first, re-sign,
then update the config. The doc leads, the automation follows.
-->

## Purpose

The Hunn household's Layer-3 smart-home automations — routines that
run without per-action approval. Each rule is enabled only after both
Peter and Shweta agree in writing. Rules can be paused or removed by
either of them, unilaterally, at any time.

## The physical-override contract

Any physical control — a wall switch flipped, a manual thermostat
turn, a valve closed by hand — **wins for at least 24 hours** over
any automated rule. May does not override manual control the same
day. She may propose ("I see you turned bedroom lights back on
after the sleep scene — want me to skip the scene tomorrow?") but
does not act.

This applies without exception, including for security and safety
scenes.

## Rules (fill in and sign before enabling)

<!-- Copy the block below for each rule. Every rule needs both signatures. -->

### Rule 1 — <descriptive name>

- **What it does**:
- **When it fires**:
- **What conditions block it**:
- **Devices involved**:
- **Human override behavior**: (physical override wins for 24h,
  see contract above; state anything additional)
- **Rollback if wrong**: (what to do / who to call if the rule
  behaves badly)
- **Approved on**: (date)
- **Signed**: Peter ______  Shweta ______

---

## Categories of rules that must never be Layer-3

Even if both of you agree, the following do not become standing
automations. They remain per-action approvals through May:

- **Front / side / back door locks** (unlock action)
- **Alarm arming / disarming**
- **Camera live-feed access to external services**
- **Garage door open action** (close action can be Layer-3 with
  a safety timer)
- **Any single-instance action costing > $10** (irrigation running
  outside its normal window, etc.)
- **Anything involving the kids' rooms after 21:00**

Add categories here as household preferences evolve.

## Change protocol

1. Draft the new rule or amendment inline in this file.
2. Discuss with the other spouse.
3. Both sign the specific rule.
4. Copy the signed file to `~/.openclaw/workspace/HOUSE-RULES.md`.
5. Only then update the Home Assistant automation config.
6. Watch it fire correctly for a week before treating it as trusted.

Never invert this order. If a rule is running that isn't in this
file, disable the rule and add it here first.

## Emergency stop

If any automation misbehaves, on Peter's Telegram (`me`):

```
/pause house-rules 24h
```

Suspends all Layer-3 automations for 24 hours. Layer-1 (observability)
and Layer-2 (explicit commands) still work. Same command on Shweta's
channel has the same authority.

## Signatures

By signing below, we affirm that:

- We have read this file
- We understand every rule listed above
- We know how to `/pause house-rules 24h` on our own channels
- Either of us can add, modify, or remove rules unilaterally

- **Peter**  ______________________________  Date __________
- **Shweta** ______________________________  Date __________

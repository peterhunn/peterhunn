# Give May her own email + family EA access

May operates as executive assistant to the Hunn family. She has her own
identity mailbox and accesses the family's mailboxes with per-user
consent through Google's native OAuth (each user grants access from
their own browser; each user can revoke from their Google Account
security settings).

## Mailboxes

```
may@hunnfamily.com     ← May's own identity — autonomous outbound within allowlist
office@hunnfamily.com  ← shared family admin (humans + May)   → draft-first
peter@hunnfamily.com   ← Peter's personal                     → draft-first, Peter approves
shweta@hunnfamily.com  ← Shweta's personal                    → draft-first, Shweta approves
```

**Read is universal** across all four (each requires that user's
explicit OAuth grant). **Send is per-account** with the policies above.

## Setup — Google Workspace + `gog`

**Browser (Google Workspace Admin Console)**:

1. `admin.google.com` → **Users → Add new user** → `may@hunnfamily.com`.
   That's one additional Workspace license (~$6/mo).

**Terminal** (still on the same Mac running May):

```bash
# May's own mailbox (she consents)
gog auth add may@hunnfamily.com --services gmail,calendar,drive

# Peter's mailbox — Peter runs this and consents in his browser
gog auth add peter@hunnfamily.com --services gmail,calendar

# Shweta's mailbox — Shweta runs this and consents in her browser
gog auth add shweta@hunnfamily.com --services gmail,calendar

# Shared family admin — whoever owns it consents
gog auth add office@hunnfamily.com --services gmail,calendar

gog auth list
# should show all four
```

Each OAuth grant is revocable independently from
`https://myaccount.google.com/security` → **Third-party access**.

## Send policy

Merged config in
[`../email-family-ea.example.jsonc`](../email-family-ea.example.jsonc).
Summary:

| From | Rule | Approver |
|---|---|---|
| `may@` | auto-send within allowlist | none (allowlisted) |
| `office@` | draft-first, always | Peter *or* Shweta |
| `peter@` | draft-first, always | Peter (Telegram) |
| `shweta@` | draft-first, always | Shweta (Telegram) |

**Cross-account rule**: anything May sends that concerns both Peter and
Shweta drafts to **both** channels and needs one to approve; either can
veto. She never picks a side by herself.

## Signature per identity

- From `may@`: "— May, executive assistant to the Hunn family. Reply to
  peter@ or shweta@ for anything time-sensitive."
- From `office@`: "— (sent by May on behalf of the office@ mailbox)"
  appended so recipients + household know it's automated
- From `peter@` / `shweta@`: their own standard signature (May drafted,
  Peter/Shweta sent — the sent identity is theirs)

## Second Telegram channel for Shweta

Shweta needs her own bot so she approves her own drafts — nothing
routes through Peter for her decisions.

**Shweta on Telegram**: DM `@BotFather` → `/newbot` → `/setname May
(Shweta)` → copy token. DM the bot once. Open
`https://api.telegram.org/bot<TOKEN>/getUpdates`, find her chat id.

**Terminal**:

```bash
openclaw channels add telegram
# name: "shweta"
# paste her bot token, paste her chat id
openclaw channels list
```

The config then routes `shweta@` drafts to the `shweta` channel and
`peter@` drafts to `me` (Peter's channel).

## Consent, in writing

Copy [`../CONSENT.md`](../CONSENT.md) from this repo, fill it in with
Peter, Shweta, and whoever consents for `office@`, and keep the signed
copy in `~/.openclaw/workspace/CONSENT.md`. May reads it as part of her
bootstrap context, so if she's ever asked "why do you have access to
Shweta's mail?" she has the accurate answer instead of guessing.

If Shweta later opts out: one line change in the config disables
`shweta@`, plus she revokes the OAuth grant at
`myaccount.google.com/security`. Her data already in May's memory
indexes is not retroactively erased — treat this as
reversible-going-forward, not reversible-fully.

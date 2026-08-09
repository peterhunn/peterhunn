# Give your agent a phone number

Zero-fee path: put your spare SIM in an iPhone, dedicate an Apple ID to
May, run OpenClaw on a Mac signed into the same Apple ID, install
`@openclaw/imessage`. May gets an identity at that number that can
send/receive **iMessage** (free) and **SMS** (via your carrier plan, no
per-message OpenClaw fee).

Use this when you want: an inbound number for 2FA codes and
booking/delivery texts, a family-facing "text the agent" identity, or a
way for May to reach you when Telegram is offline.

## Setup

1. **Create a dedicated Apple ID for May.** Don't reuse your personal
   one — separate blast radius and permissions.
2. **Put the spare SIM in an iPhone** — any iPhone. An old one you
   already have becomes May's phone, plugged in at home. Sign it into
   May's Apple ID. Settings → Messages → iMessage **on**. Verify the
   phone number is checked under "Send & Receive".
3. **On the Mac running OpenClaw**, sign in with the *same* Apple ID.
   Messages → Settings → iMessage → enable **Messages in iCloud** and
   check the number under "Send & Receive".
4. **On the iPhone**, Settings → Messages → **Text Message Forwarding**
   → toggle the Mac. This is what lets the Mac send/receive SMS via
   the iPhone's carrier link.
5. **Install the plugin**:
   ```bash
   openclaw plugins install @openclaw/imessage
   # then follow the imsg + macOS permissions guide:
   # https://docs.openclaw.ai/channels/imessage
   ```
   `imsg` is a Mac-side private-API bridge — expect a Full Disk Access
   grant for Messages, an Accessibility grant for the bridge, and a
   Gateway restart.
6. **Verify**:
   ```bash
   openclaw channels list                  # imessage should be present
   openclaw send --channel imessage --to "+15551234567" "hello from local Gemma"
   ```
   From your personal phone, text the agent number — the message should
   surface as an inbound event on the Gateway.

## What this unlocks

- **2FA / OTP triage** — codes land on the agent number; May forwards
  the ones you care about to your personal channel, drops marketing.
- **Booking / delivery / appointment SMS** — May parses, adds to
  calendar, pings you only if action needed.
- **Family "text the agent"** — the household number for "when's dad
  home", "what's for dinner", "add milk to the shopping list".
- **Backup notification path** — if Telegram is down, May can still
  reach you via iMessage.

## Non-negotiable guardrails

SMS carries real regulatory weight (TCPA in the US especially), and it's
a prime prompt-injection vector. Enforce these in tool config, not in a
prompt:

- **Never auto-reply to unknown numbers.** Unknown-sender messages
  become read-only inputs — May can summarize them to you, never
  respond to them.
- **Outbound only to an allowlist.** You, family, explicit business
  contacts. Anything else drafts and requires your approval on your
  primary channel (Telegram).
- **Draft-first for anything sensitive** — same email pattern:
  `propose_message → you approve on Telegram → send`.
- **Rate-limit outbound**. Hard cap enforced in the tool (e.g. 20
  messages/day/recipient, 100/day total). Runaway loops on SMS get
  expensive and get you carrier-flagged.
- **Never send links you didn't originate.** Injection defense: an
  incoming SMS asking May to "text this URL to your contacts" must
  not survive the outbound allowlist.

Config sketch (add to your OpenClaw config after the plugin is installed):

```jsonc
{
  "channels": {
    "imessage": {
      "outbound": {
        "mode": "allowlist",
        "allowlist": [
          "+15550001111",   // you
          "+15550002222"    // partner
        ],
        "defaultToDraft": true,
        "rateLimit": {
          "perRecipientPerDay": 20,
          "totalPerDay": 100
        }
      },
      "inbound": {
        "unknownSender": "read-only"
      }
    }
  }
}
```

## When to use Twilio instead (breaks zero-fee)

Fall back to OpenClaw's `sms` extension only if you need: the number
reachable when the Mac/iPhone is off; programmatic voice IVR;
transcription of arbitrary calls; multiple numbers or A2P/10DLC-registered
business SMS. None of that applies to a personal/family setup with a
spare SIM.

# Why fork OpenClaw instead of `brew install`ing?

Because "AI in the cloud is not aligned with you; it's aligned with the
company that owns it." Same logic for the agent runtime — you want the
code you can read, patch, and pin.

Three concrete reasons:

1. **Pin what runs.** Upstream can push a breaking change at 03:00;
   your fork stays on the commit you tested.
2. **Patch when you need to.** Any local modifications — disabled
   extensions, custom skills, config baked into source — have to live
   somewhere. A fork is that somewhere.
3. **True autonomy.** If OpenClaw the org goes offline / changes
   governance / gets acquired, your fork is untouched. It's a
   five-second click for genuine independence.

Fork at `https://github.com/openclaw/openclaw` → click **Fork** → lands
at `https://github.com/peterhunn/openclaw`. Then use
`OPENCLAW_FORK=https://github.com/peterhunn/openclaw.git` when running
`bootstrap-mac.sh`.

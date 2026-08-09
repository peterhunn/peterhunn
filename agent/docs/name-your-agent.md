# Name your agent — meet May

The agent's name is **May**. She's Peter's personal agent.

OpenClaw injects a set of workspace bootstrap files into the system prompt
every turn (`docs/gateway/config-agents.md` in the OpenClaw fork). Three
of them shape her identity:

- **`IDENTITY.md`** — who she is, what she does, what she doesn't
- **`SOUL.md`** — her operating values, in priority order
- **`USER.md`** — who Peter is, so she can be useful to him

Starter versions of all three are in [`../identity/`](../identity/). On
first Mac bring-up:

```bash
mkdir -p ~/.openclaw/workspace
cp identity/IDENTITY.md identity/SOUL.md identity/USER.md \
   ~/.openclaw/workspace/
$EDITOR ~/.openclaw/workspace/USER.md    # fill in the blanks
```

Then restart the Gateway. She'll introduce herself as May.

## Sync the name across every surface

`IDENTITY.md` sets what she *thinks* she's called. Match that on every
channel she appears on:

| Surface | Where to set the name |
|---|---|
| Telegram bot | @BotFather → `/setname May` and `/setabouttext` |
| iMessage | Settings → Apple ID → Name = "May" on her Apple ID |
| Gmail sender name | Google Account → Personal info → set for her OAuth account |
| Email signature | Add `— May, on behalf of Peter` as the default sig in `gog send` |
| OpenClaw display | `openclaw config set agents.defaults.displayName "May"` |
| Fleet cell name | For the family setup, this cell is `peter`; May is who lives inside it |

The rule of thumb: if anyone new interacts with her and can't tell she's
May, one surface didn't get updated.

## Tuning her personality later

The three files in `../identity/` are the source of truth in this repo;
your workspace copies at `~/.openclaw/workspace/` are what the running
agent reads. Two patterns:

- **Small tweaks live in the workspace.** Edit `~/.openclaw/workspace/*.md`
  directly, restart the Gateway. Faster iteration.
- **Anything you want to keep**, copy back into `../identity/` and
  commit. That way a fresh Mac bring-up starts with the current May,
  not the day-one May.

For per-context specialization (e.g. a stricter version of May for the
trading loop), use OpenClaw's `agents.entries.*` config to define a
separate agent id with its own IDENTITY override — inherits the same
model, different persona.

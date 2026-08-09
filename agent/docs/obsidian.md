# Obsidian as May's second brain

Your Obsidian vault is just a folder of markdown, which makes it a
near-ideal fit for a local agent: no cloud, no plugins strictly
required, semantic search via local embeddings. Three layers — enable
as many as you want.

## Layer 1 — Direct read/write

Point May at the vault. She uses her built-in file tools; no plugin
needed.

```bash
openclaw config set agents.defaults.contextRoots.obsidian \
  "$HOME/Documents/Obsidian/MyVault"
```

She can now read any note, list any folder, append to a daily note, or
create new notes in `Inbox/`.

## Layer 2 — Semantic search (the real "second brain")

Index the vault with `memory-lancedb` using **local** Ollama embeddings
— zero external calls, zero fees.

```bash
ollama pull nomic-embed-text                            # small, strong, local

openclaw memory add-source obsidian \
  --path "$HOME/Documents/Obsidian/MyVault" \
  --backend lancedb \
  --embed-provider ollama \
  --embed-model nomic-embed-text \
  --watch                                               # re-embed on change
```

If `--watch` ever misses changes, back it up with a scheduled reindex:

```bash
openclaw automations create \
  --every 1h \
  --name "obsidian-reindex" \
  --system-event "openclaw memory reindex obsidian"
```

Now: "what did I write about X" hits the vault semantically, not by
filename. Backlinks, tags, and frontmatter are preserved as metadata.

## Layer 3 — Write-back with guardrails

Same draft-first rule as email — May proposes changes, you confirm —
but some classes are safe enough to auto-append:

Auto (safe):

- Append to today's daily note (`Daily/YYYY-MM-DD.md`)
- Create in `Inbox/` (you triage later)
- Log a meeting summary to `Meetings/YYYY-MM-DD - <title>.md`

Confirm first:

- Edit an existing non-daily note
- Modify frontmatter on any existing note
- Move notes between folders
- Delete anything

Never (denied even with confirmation):

- Anything under `.obsidian/` (plugin configs / workspace state)
- Anything under `.trash/` or `Archive/` by default (change if you want)

Copy [`../obsidian.example.jsonc`](../obsidian.example.jsonc) into your
OpenClaw config as a starting point, then edit the paths.

## What this unlocks

- **"Save that to Obsidian"** → new note in `Inbox/`, tagged
- **"Add to today's daily"** → appended under a `## Captured` heading
- **"What did I say about X?"** → semantic hits with `[[wikilinks]]`
  back to source notes
- **Morning brief additions** — "yesterday you left three threads open
  in your daily note: …"
- **Meeting prep** — "here's everything in your vault mentioning
  [attendee] since your last meeting" — auto-loaded before calendar
  events
- **End-of-day** — "captured 4 items to Inbox today, want me to file
  them?"

## One important guardrail

**Turn on either Obsidian Sync or a git-tracked vault before enabling
Layer 3.** May's writes are reversible only if you can roll back. The
`denyPatterns` block above prevents her from corrupting Obsidian
internals, but nothing prevents an honest mistake in your own notes.
Reversibility is the safety net.

## Optional: Obsidian Local REST API plugin

Install the community **Local REST API** plugin and register its
endpoint as a custom tool if you want May to trigger actions inside the
running Obsidian app (open a note, jump to a heading, run a
command-palette action). Filesystem access alone is enough for reading
and writing — this is only for UI-level control.

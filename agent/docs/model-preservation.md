# Preserving your model — what to back up and how

The whole "own your AI" thesis assumes you actually *have* the model.
Once `ollama pull` finishes, the weights are on your disk at
`~/.ollama/models/` and don't need internet, don't phone home, don't
get revoked. Google can deprecate Gemma tomorrow and your copy keeps
working forever. But that's only true if the file survives.

## What could go wrong

| Scenario | Impact |
|---|---|
| Google stops publishing Gemma updates | Zero — you have the weights you have |
| Ollama removes it from their registry | Fresh pulls on new machines fail; your existing copy keeps working |
| Google changes the license going forward | Bound by license at time of download for your copy — retroactive revocation of open weights isn't a thing that's happened |
| **Your disk dies or is wiped** | **The real risk. Weights are large and easy to forget in ad-hoc backups.** |

## Three insurance policies (five minutes, once)

**1. Back up the model files.** Time Machine covers `~/.ollama/models/`
if enabled. For belt-and-braces, one-shot `rsync` to an external drive:

```bash
du -sh ~/.ollama/models/                                     # ~5-20 GB depending on models
rsync -aP ~/.ollama/models/ /Volumes/Backup/ollama-models/
```

Restore = `rsync` the other direction. Ollama picks the files up on
next launch.

**2. Record model provenance** — which exact version is yours, so you
can audit / reproduce / match later:

```bash
mkdir -p ~/.openclaw/model-provenance
ollama list                        > ~/.openclaw/model-provenance/list-$(date +%F).txt
ollama show gemma4 --modelfile     > ~/.openclaw/model-provenance/gemma4-$(date +%F).txt
```

Refresh this snapshot whenever you swap the default model.

**3. Pre-pull a fallback model** while it's easy, so you have options
if the primary registry ever stops serving your model:

```bash
ollama pull qwen2.5:14b            # strong general-purpose alternative
ollama pull llama3.2:3b            # tiny always-runnable fallback
```

## If you want to go further

Mirror `~/.ollama/models/` to a NAS or a second Mac. Weights + hash
provenance = permanent local copy that survives even Ollama-the-company
disappearing. The directory is portable — move it, use it forever.

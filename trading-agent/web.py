"""Local web UI for the strategy designer.

Two-pane browser interface: chat with Claude on the left, live-editable
YAML on the right. When Claude emits a fenced ```yaml block, it lands in
the right pane; you can also hand-edit that pane directly. Save writes
to strategies.yaml (add or replace by strategy key).

Start:
    python agent.py --web
    # or: python -m web  (from the trading-agent directory)

Binds to 127.0.0.1 by default. No auth — do not expose to a network.
"""

from __future__ import annotations

import webbrowser
from typing import Any

import anthropic
import yaml
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from config import list_endpoints, load_global
from designer import (
    DESIGN_PROMPT_PATH,
    STRATEGIES_YAML,
    _extract_yaml,
    _load_current_strategies,
    _merge_yaml_block,
)


app = FastAPI()

INDEX_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Strategy Designer</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f4;
    color: #1c1917;
    display: flex;
    flex-direction: column;
  }
  header {
    background: #1c1917;
    color: #fafaf9;
    padding: 10px 16px;
    display: flex;
    gap: 16px;
    align-items: center;
    font-size: 14px;
  }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
  header label { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  header select, header button {
    background: #292524;
    color: #fafaf9;
    border: 1px solid #44403c;
    border-radius: 4px;
    padding: 5px 10px;
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  header select { min-width: 140px; }
  header button:hover { background: #44403c; }
  header .spacer { flex: 1; }
  header .status { font-size: 12px; color: #a8a29e; font-family: ui-monospace, monospace; }
  main {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: #d6d3d1;
    overflow: hidden;
    min-height: 0;
  }
  .pane {
    background: #fafaf9;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .pane-header {
    padding: 8px 14px;
    font-size: 12px;
    color: #78716c;
    background: #f5f5f4;
    border-bottom: 1px solid #e7e5e4;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pane-header .right { margin-left: auto; display: flex; gap: 8px; }
  .pane-header button {
    background: #fafaf9;
    border: 1px solid #d6d3d1;
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
    color: #1c1917;
  }
  .pane-header button:hover { background: #f5f5f4; }
  .pane-header button.primary {
    background: #1c1917;
    color: #fafaf9;
    border-color: #1c1917;
  }
  .pane-header button.primary:hover { background: #292524; }
  .pane-header button:disabled { opacity: 0.5; cursor: not-allowed; }
  #chat {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    font-size: 14px;
    line-height: 1.5;
  }
  .msg { margin-bottom: 14px; }
  .msg .role {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #78716c;
    margin-bottom: 4px;
  }
  .msg.user .role { color: #7c2d12; }
  .msg.assistant .role { color: #14532d; }
  .msg .body { white-space: pre-wrap; word-wrap: break-word; }
  .msg .body code {
    background: #f5f5f4;
    padding: 1px 4px;
    border-radius: 3px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12.5px;
  }
  .msg .body pre {
    background: #1c1917;
    color: #fafaf9;
    padding: 10px 12px;
    border-radius: 4px;
    font-size: 12.5px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    overflow-x: auto;
    line-height: 1.4;
  }
  .msg .body pre code { background: transparent; padding: 0; color: inherit; }
  #input-row {
    display: flex;
    gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid #e7e5e4;
    background: #f5f5f4;
  }
  #input {
    flex: 1;
    font-family: inherit;
    font-size: 14px;
    padding: 8px 10px;
    border: 1px solid #d6d3d1;
    border-radius: 4px;
    background: white;
    resize: none;
    min-height: 42px;
    max-height: 160px;
  }
  #send {
    background: #1c1917;
    color: #fafaf9;
    border: 0;
    border-radius: 4px;
    padding: 0 18px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  #send:hover { background: #292524; }
  #send:disabled { background: #a8a29e; cursor: wait; }
  #yaml {
    flex: 1;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px;
    padding: 14px;
    border: 0;
    outline: 0;
    background: #fafaf9;
    color: #1c1917;
    resize: none;
    tab-size: 2;
    line-height: 1.5;
  }
  #save-note {
    padding: 8px 14px;
    background: #f5f5f4;
    border-top: 1px solid #e7e5e4;
    font-size: 12px;
    color: #78716c;
    min-height: 32px;
  }
  #save-note.ok { color: #14532d; }
  #save-note.err { color: #7c2d12; }
  .placeholder { color: #a8a29e; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>strategy designer</h1>
  <label>endpoint <select id="endpoint"></select></label>
  <label>load <select id="strategy"><option value="">— new —</option></select></label>
  <div class="spacer"></div>
  <span class="status" id="status">ready</span>
</header>
<main>
  <div class="pane">
    <div class="pane-header">
      chat
      <div class="right">
        <button id="clear-chat">clear chat</button>
      </div>
    </div>
    <div id="chat"><div class="placeholder">Describe the strategy you want. Claude will ask questions and emit YAML into the right pane.</div></div>
    <div id="input-row">
      <textarea id="input" placeholder="e.g. Weekly DCA of $50 into VOO on Robinhood, skip if I already bought this week..."></textarea>
      <button id="send">send</button>
    </div>
  </div>
  <div class="pane">
    <div class="pane-header">
      strategies.yaml draft (editable)
      <div class="right">
        <button id="save" class="primary">save</button>
      </div>
    </div>
    <textarea id="yaml" spellcheck="false" placeholder="# Draft appears here as Claude proposes YAML. You can also edit it directly."></textarea>
    <div id="save-note"></div>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const state = { messages: [], endpoint: null };

async function api(path, body) {
  const opts = body ? { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.detail || r.statusText);
  return data;
}

function renderMsg(role, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  const roleEl = document.createElement("div");
  roleEl.className = "role";
  roleEl.textContent = role;
  wrap.appendChild(roleEl);
  const body = document.createElement("div");
  body.className = "body";
  // Simple markdown-ish rendering: fenced code blocks
  const parts = text.split(/```(\\w*)\\n([\\s\\S]*?)\\n```/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      const span = document.createElement("span");
      span.textContent = parts[i];
      body.appendChild(span);
    } else if (i % 3 === 1) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = parts[i+1] || "";
      pre.appendChild(code);
      body.appendChild(pre);
      i++; // skip the content part
    }
  }
  wrap.appendChild(body);
  const chat = $("chat");
  const placeholder = chat.querySelector(".placeholder");
  if (placeholder) placeholder.remove();
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
}

async function refreshEndpoints() {
  const data = await api("/api/endpoints");
  const sel = $("endpoint");
  sel.innerHTML = "";
  for (const name of data.endpoints) {
    const opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  }
  state.endpoint = sel.value;
}

async function refreshStrategies() {
  const data = await api("/api/strategies");
  const sel = $("strategy");
  const currentValue = sel.value;
  sel.innerHTML = '<option value="">— new —</option>';
  for (const name of data.strategies) {
    const opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = currentValue;
}

async function loadStrategy(name) {
  if (!name) { $("yaml").value = ""; return; }
  const data = await api("/api/strategies/" + encodeURIComponent(name));
  $("yaml").value = data.yaml_text;
  // pre-bind endpoint to the strategy's endpoint
  if (data.endpoint) {
    $("endpoint").value = data.endpoint;
    state.endpoint = data.endpoint;
  }
}

async function send() {
  const input = $("input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  renderMsg("user", text);
  state.messages.push({role: "user", content: text});
  $("send").disabled = true;
  $("status").textContent = "thinking…";
  try {
    const res = await api("/api/chat", {
      messages: state.messages,
      endpoint: state.endpoint,
      strategy_name: $("strategy").value || null,
    });
    renderMsg("assistant", res.reply);
    state.messages.push({role: "assistant", content: res.reply});
    if (res.extracted_yaml) {
      $("yaml").value = res.extracted_yaml;
      $("save-note").textContent = "YAML pane updated from Claude's reply. Edit freely, then Save.";
      $("save-note").className = "";
    }
  } catch (e) {
    renderMsg("assistant", "[error] " + e.message);
  } finally {
    $("send").disabled = false;
    $("status").textContent = "ready";
    input.focus();
  }
}

async function save() {
  const yaml_text = $("yaml").value.trim();
  if (!yaml_text) {
    $("save-note").textContent = "nothing to save.";
    $("save-note").className = "err";
    return;
  }
  $("save").disabled = true;
  try {
    const res = await api("/api/save", {yaml_text});
    const parts = [];
    if (res.added.length) parts.push("added: " + res.added.join(", "));
    if (res.replaced.length) parts.push("replaced: " + res.replaced.join(", "));
    $("save-note").textContent = "saved. " + (parts.join("; ") || "no change");
    $("save-note").className = "ok";
    await refreshStrategies();
  } catch (e) {
    $("save-note").textContent = "save failed: " + e.message;
    $("save-note").className = "err";
  } finally {
    $("save").disabled = false;
  }
}

$("send").onclick = send;
$("save").onclick = save;
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
});
$("endpoint").onchange = (e) => { state.endpoint = e.target.value; };
$("strategy").onchange = (e) => loadStrategy(e.target.value);
$("clear-chat").onclick = () => {
  state.messages = [];
  $("chat").innerHTML = '<div class="placeholder">Chat cleared. Describe the strategy you want.</div>';
};

(async () => {
  await refreshEndpoints();
  await refreshStrategies();
})();
</script>
</body>
</html>
"""


class ChatRequest(BaseModel):
    messages: list[dict[str, str]]
    endpoint: str | None = None
    strategy_name: str | None = None


class ChatResponse(BaseModel):
    reply: str
    extracted_yaml: str | None = None


class SaveRequest(BaseModel):
    yaml_text: str


class SaveResponse(BaseModel):
    added: list[str]
    replaced: list[str]


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    return INDEX_HTML


@app.get("/api/endpoints")
async def api_endpoints() -> dict[str, list[str]]:
    return {"endpoints": list_endpoints()}


@app.get("/api/strategies")
async def api_strategies() -> dict[str, list[str]]:
    current = _load_current_strategies().get("strategies", {}) or {}
    return {"strategies": sorted(current.keys())}


@app.get("/api/strategies/{name}")
async def api_strategy(name: str) -> dict[str, Any]:
    current = _load_current_strategies().get("strategies", {}) or {}
    if name not in current:
        raise HTTPException(status_code=404, detail=f"strategy '{name}' not found")
    spec = current[name]
    single = {"strategies": {name: spec}}
    return {
        "endpoint": spec.get("endpoint"),
        "yaml_text": yaml.safe_dump(single, sort_keys=False, default_flow_style=False, width=100),
    }


def _build_seed_system_note(endpoint: str | None, strategy_name: str | None) -> str:
    bits = []
    endpoints = list_endpoints()
    if endpoint:
        bits.append(f"Target endpoint: {endpoint}")
    else:
        bits.append(f"Available endpoints: {', '.join(endpoints)}")
    current = _load_current_strategies().get("strategies", {}) or {}
    if strategy_name and strategy_name in current:
        existing_yaml = yaml.safe_dump(
            {"strategies": {strategy_name: current[strategy_name]}},
            sort_keys=False,
            default_flow_style=False,
            width=100,
        )
        bits.append(
            f"Editing existing strategy '{strategy_name}'. Current YAML:\n\n{existing_yaml}"
        )
    return "\n\n".join(bits)


@app.post("/api/chat", response_model=ChatResponse)
async def api_chat(req: ChatRequest) -> ChatResponse:
    global_cfg = load_global()
    system = DESIGN_PROMPT_PATH.read_text(encoding="utf-8")

    # Inject seed context as a synthesized first user turn if the conversation
    # is otherwise empty. Keeps the wire protocol simple (client sends only
    # the user-visible turns).
    messages: list[dict[str, Any]] = []
    seed = _build_seed_system_note(req.endpoint, req.strategy_name)
    if seed and (not req.messages or req.messages[0].get("content", "").strip() != seed):
        messages.append({"role": "user", "content": seed})
        messages.append({
            "role": "assistant",
            "content": "Got it. What would you like the strategy to do?",
        })
    messages.extend(req.messages)

    client = anthropic.AsyncAnthropic(api_key=global_cfg.anthropic_api_key)
    try:
        response = await client.messages.create(
            model=global_cfg.model,
            max_tokens=8000,
            system=system,
            messages=messages,
            thinking={"type": "adaptive"},
            output_config={"effort": "medium"},
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"anthropic error: {e}") from e

    reply = "".join(
        b.text for b in response.content
        if getattr(b, "type", None) == "text" and b.text
    )
    return ChatResponse(reply=reply, extracted_yaml=_extract_yaml(reply))


@app.post("/api/save", response_model=SaveResponse)
async def api_save(req: SaveRequest) -> SaveResponse:
    try:
        added, replaced = _merge_yaml_block(req.yaml_text)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return SaveResponse(added=added, replaced=replaced)


def run(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    import uvicorn
    url = f"http://{host}:{port}"
    print(f"strategy designer web UI at {url}")
    print(f"strategies.yaml: {STRATEGIES_YAML}")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    run()

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


ROBINHOOD_MCP_URL = "https://agent.robinhood.com/mcp/trading"


@dataclass(frozen=True)
class Config:
    anthropic_api_key: str
    robinhood_mcp_token: str
    model: str
    effort: str
    dry_run: bool
    max_trades_per_run: int
    max_notional_per_trade_usd: float
    system_prompt: str


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(
            f"Missing required env var {name}. Copy .env.example to .env and fill it in."
        )
    return value


def load_config() -> Config:
    system_prompt_path = Path(__file__).parent / "prompts" / "system.md"
    system_prompt = system_prompt_path.read_text(encoding="utf-8")

    dry_run = os.environ.get("DRY_RUN", "true").strip().lower() != "false"

    return Config(
        anthropic_api_key=_require("ANTHROPIC_API_KEY"),
        robinhood_mcp_token=_require("ROBINHOOD_MCP_TOKEN"),
        model=os.environ.get("MODEL", "claude-opus-4-8").strip(),
        effort=os.environ.get("EFFORT", "high").strip(),
        dry_run=dry_run,
        max_trades_per_run=int(os.environ.get("MAX_TRADES_PER_RUN", "3")),
        max_notional_per_trade_usd=float(
            os.environ.get("MAX_NOTIONAL_PER_TRADE_USD", "250")
        ),
        system_prompt=system_prompt,
    )

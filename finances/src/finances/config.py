"""Configuration loading and paths."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path


DEFAULT_CONFIG_PATH = Path("~/.finances/config.jsonc").expanduser()


@dataclass
class UserCfg:
    name: str
    display_name: str


@dataclass
class PlaidCfg:
    enabled: bool = False
    client_id: str = ""
    secret: str = ""
    env: str = "development"
    sync_every_minutes: int = 240
    products: list[str] = field(default_factory=lambda: ["transactions"])


@dataclass
class GmailCfg:
    bill_scan_accounts: list[str] = field(default_factory=list)
    scan_every_minutes: int = 720


@dataclass
class AuditCfg:
    log_file: Path = Path("~/.finances/audit.log").expanduser()
    rotate_weekly: bool = True


@dataclass
class Config:
    data_dir: Path
    host: str
    port: int
    users: list[UserCfg]
    default_owner: str
    categories_file: Path
    plaid: PlaidCfg
    gmail: GmailCfg
    audit: AuditCfg

    @property
    def db_path(self) -> Path:
        return self.data_dir / "db.db"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"


def _strip_jsonc(text: str) -> str:
    # Remove // line comments and /* block comments. Naive but sufficient.
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"(^|\s)//[^\n]*", r"\1", text)
    return text


def load_config(path: Path | None = None) -> Config:
    path = path or Path(os.environ.get("FINANCES_CONFIG", DEFAULT_CONFIG_PATH)).expanduser()
    if not path.exists():
        raise FileNotFoundError(
            f"config not found at {path}. Copy config.example.jsonc into "
            "place and edit it."
        )
    raw = _strip_jsonc(path.read_text())
    data = json.loads(raw)

    def p(s: str) -> Path:
        return Path(os.path.expandvars(s)).expanduser()

    plaid_raw = data.get("plaid", {})
    gmail_raw = data.get("gmail", {})
    audit_raw = data.get("audit", {})

    cfg = Config(
        data_dir=p(data.get("dataDir", "~/.finances")),
        host=data.get("host", "127.0.0.1"),
        port=int(data.get("port", 8720)),
        users=[
            UserCfg(name=u["name"], display_name=u["displayName"])
            for u in data.get("users", [])
        ],
        default_owner=data.get("defaultOwner", "household"),
        categories_file=p(data.get("categoriesFile", "~/.finances/categories.yaml")),
        plaid=PlaidCfg(
            enabled=plaid_raw.get("enabled", False),
            client_id=plaid_raw.get("clientId", ""),
            secret=plaid_raw.get("secret", ""),
            env=plaid_raw.get("env", "development"),
            sync_every_minutes=int(plaid_raw.get("syncEveryMinutes", 240)),
            products=list(plaid_raw.get("products", ["transactions"])),
        ),
        gmail=GmailCfg(
            bill_scan_accounts=list(gmail_raw.get("billScanAccounts", [])),
            scan_every_minutes=int(gmail_raw.get("scanEveryMinutes", 720)),
        ),
        audit=AuditCfg(
            log_file=p(audit_raw.get("logFile", "~/.finances/audit.log")),
            rotate_weekly=bool(audit_raw.get("rotateWeekly", True)),
        ),
    )

    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    cfg.logs_dir.mkdir(parents=True, exist_ok=True)
    cfg.audit.log_file.parent.mkdir(parents=True, exist_ok=True)
    return cfg

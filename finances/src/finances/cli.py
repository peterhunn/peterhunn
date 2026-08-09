"""`finances` CLI — one entry point for admin + serve."""

from __future__ import annotations

import os
from pathlib import Path

import click
import uvicorn

from .config import load_config
from .db import connect, init_db


@click.group()
@click.option(
    "--config",
    "config_path",
    type=click.Path(path_type=Path),
    default=None,
    help="path to config.jsonc (default ~/.finances/config.jsonc)",
)
@click.pass_context
def cli(ctx: click.Context, config_path: Path | None):
    ctx.ensure_object(dict)
    ctx.obj["config_path"] = config_path


# ─────────────────────  serve  ─────────────────────


@cli.command()
@click.option("--reload", is_flag=True, help="Auto-reload on code changes (dev)")
@click.pass_context
def serve(ctx: click.Context, reload: bool):
    """Run REST + MCP + web UI on the configured host:port."""
    cfg = load_config(ctx.obj["config_path"])
    os.environ["FINANCES_CONFIG"] = str(
        (ctx.obj["config_path"] or Path("~/.finances/config.jsonc").expanduser())
    )
    uvicorn.run(
        "finances.main:_app",
        host=cfg.host,
        port=cfg.port,
        reload=reload,
        factory=False,
    )


# uvicorn needs a module-level app object when not using factory=True.
# Build it lazily on import so tests can call build_app themselves.
def _make_app():
    from .config import load_config as _l
    from .main import build_app
    return build_app(_l(Path(os.environ.get("FINANCES_CONFIG", "~/.finances/config.jsonc")).expanduser()))


_app = None
def __getattr__(name: str):
    global _app
    if name == "_app":
        if _app is None:
            _app = _make_app()
        return _app
    raise AttributeError(name)


# ─────────────────────  db  ─────────────────────


@cli.group()
def db():
    """Database admin."""


@db.command("init")
@click.pass_context
def db_init(ctx: click.Context):
    """Create schema, seed users + categories + rules."""
    cfg = load_config(ctx.obj["config_path"])
    init_db(cfg)
    click.echo(f"initialized {cfg.db_path}")


@db.command("categories-reload")
@click.pass_context
def db_categories_reload(ctx: click.Context):
    """Re-load categories.yaml (adds new, refreshes rules; keeps txns)."""
    from .db import _load_categories_yaml
    cfg = load_config(ctx.obj["config_path"])
    conn = connect(cfg)
    _load_categories_yaml(conn, cfg)
    click.echo("categories + rules reloaded")


# ─────────────────────  import  ─────────────────────


@cli.group("import")
def import_():
    """Ingest transactions."""


@import_.command("csv")
@click.argument("path", type=click.Path(exists=True, path_type=Path))
@click.option("--account", required=True, help="Short account slug, e.g. chase-checking")
@click.option("--provider", default="generic", help="chase | amex | generic")
@click.pass_context
def import_csv_cmd(ctx: click.Context, path: Path, account: str, provider: str):
    from .ingest.csv_import import import_csv
    cfg = load_config(ctx.obj["config_path"])
    conn = connect(cfg)
    counts = import_csv(conn, path, account=account, provider=provider)
    click.echo(counts)


# ─────────────────────  plaid  ─────────────────────


@cli.group()
def plaid():
    """Plaid link + sync."""


@plaid.command("sync")
@click.pass_context
def plaid_sync_cmd(ctx: click.Context):
    from .ingest.plaid_sync import sync_all_items
    cfg = load_config(ctx.obj["config_path"])
    conn = connect(cfg)
    click.echo(sync_all_items(conn, cfg))


# ─────────────────────  bills  ─────────────────────


@cli.group()
def bills():
    """Bill scanning + management."""


@bills.command("scan")
@click.option("--account", required=True, help="Gmail account (via gog) to scan")
@click.option("--days", default=30, help="How far back to look")
@click.pass_context
def bills_scan(ctx: click.Context, account: str, days: int):
    click.echo(
        f"[stub] would scan {account} for the last {days} days.\n"
        "Requires gog to be installed and authenticated for that account.\n"
        "Wire this to src/finances/ingest/gmail_bills.py when ready."
    )


# ─────────────────────  doctor + launchd  ─────────────────────


@cli.command()
@click.pass_context
def doctor(ctx: click.Context):
    """Config + db + schema sanity check."""
    cfg = load_config(ctx.obj["config_path"])
    conn = connect(cfg)
    checks = {
        "config loaded": True,
        "db exists": cfg.db_path.exists(),
        "categories loaded": bool(
            conn.execute("SELECT 1 FROM categories LIMIT 1").fetchone()
        ),
        "rules loaded": bool(
            conn.execute("SELECT 1 FROM rules LIMIT 1").fetchone()
        ),
        "users seeded": bool(
            conn.execute("SELECT 1 FROM users LIMIT 1").fetchone()
        ),
    }
    for k, v in checks.items():
        click.echo(f"{'✓' if v else '✗'} {k}")
    if not all(checks.values()):
        raise click.ClickException("one or more checks failed")


@cli.group()
def launchd():
    """launchd service install / uninstall."""


@launchd.command("install")
@click.pass_context
def launchd_install(ctx: click.Context):
    cfg = load_config(ctx.obj["config_path"])
    plist_path = Path("~/Library/LaunchAgents/com.hunnfamily.finances.plist").expanduser()
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    plist_path.write_text(_launchd_plist(cfg))
    click.echo(f"wrote {plist_path}")
    click.echo(f"start with:  launchctl load {plist_path}")


@launchd.command("uninstall")
def launchd_uninstall():
    plist_path = Path("~/Library/LaunchAgents/com.hunnfamily.finances.plist").expanduser()
    if plist_path.exists():
        plist_path.unlink()
        click.echo(f"removed {plist_path}")
    else:
        click.echo("no plist installed")


def _launchd_plist(cfg) -> str:
    import shutil
    uv = shutil.which("uv") or "/opt/homebrew/bin/uv"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>       <string>com.hunnfamily.finances</string>
  <key>ProgramArguments</key>
  <array>
    <string>{uv}</string>
    <string>run</string>
    <string>finances</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>  <string>{Path.cwd()}</string>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>{cfg.logs_dir / "stdout.log"}</string>
  <key>StandardErrorPath</key> <string>{cfg.logs_dir / "stderr.log"}</string>
</dict>
</plist>
"""


def main() -> None:
    cli(obj={})


if __name__ == "__main__":
    main()

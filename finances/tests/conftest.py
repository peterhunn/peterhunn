"""Pytest fixtures — an in-memory config + initialized DB per test."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from finances.config import Config, GmailCfg, PlaidCfg, UserCfg, AuditCfg
from finances.db import connect, init_db


@pytest.fixture
def cfg(tmp_path: Path) -> Config:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    cats_path = tmp_path / "categories.yaml"
    cats_path.write_text(_MINIMAL_CATEGORIES_YAML)
    c = Config(
        data_dir=data_dir,
        host="127.0.0.1",
        port=8720,
        users=[
            UserCfg(name="peter", display_name="Peter"),
            UserCfg(name="shweta", display_name="Shweta"),
        ],
        default_owner="household",
        categories_file=cats_path,
        plaid=PlaidCfg(),
        gmail=GmailCfg(),
        audit=AuditCfg(log_file=data_dir / "audit.log"),
    )
    (c.logs_dir).mkdir(exist_ok=True)
    return c


@pytest.fixture
def db(cfg):
    init_db(cfg)
    return connect(cfg)


_MINIMAL_CATEGORIES_YAML = """\
categories:
  - Food & Household:
      - Groceries
      - Coffee
  - Transport:
      - Fuel
      - Rideshare
  - Housing:
      - Mortgage
      - Utilities
  - Uncategorized:
      - Needs review

rules:
  - match: { merchant: "whole foods" }
    set:   { category: "Groceries" }
    priority: 10
  - match: { merchant: "starbucks" }
    set:   { category: "Coffee" }
    priority: 10
  - match: { merchant: "shell" }
    set:   { category: "Fuel" }
    priority: 10
  - match: {}
    set:   { category: "Needs review" }
    priority: 999
"""

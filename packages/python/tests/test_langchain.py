"""Tests for the LangChain tool wrappers."""

from __future__ import annotations

import base64
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from x490 import ContractClient, ContractRequirements
from x490.langchain import make_x490_tools, _make_contract_fetch_tool, _make_inspect_requirements_tool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _requirements_header(req: ContractRequirements) -> str:
    return _b64url_encode(json.dumps(req.to_dict(), separators=(",", ":")).encode())


def _make_requirements(**overrides: Any) -> ContractRequirements:
    defaults: dict[str, Any] = {
        "scheme": "x490", "version": 1,
        "templateId": "tmpl-1",
        "templateUrl": "https://example.com/template/1",
        "templateHash": "deadbeef",
        "requiredPartyFields": ["name", "email"],
        "acceptEndpoint": "https://example.com/accept",
        "expiresIn": 3600,
        "resource": "/data",
        "description": "Test contract",
        "negotiable": False,
    }
    defaults.update(overrides)
    return ContractRequirements.from_dict(defaults)


class SequentialTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: list[httpx.Response]) -> None:
        self._responses = list(responses)
        self._index = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        r = self._responses[self._index]
        self._index += 1
        return httpx.Response(status_code=r.status_code, headers=r.headers, content=r.content)


import contextlib

@contextlib.contextmanager
def _patch_async_client(transport: SequentialTransport):
    class _Patched(httpx.AsyncClient):
        def __init__(self, **kwargs):
            kwargs["transport"] = transport
            super().__init__(**kwargs)
    with patch("httpx.AsyncClient", _Patched):
        yield


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_make_x490_tools_returns_list():
    client = ContractClient(party_data={"name": "Agent", "email": "a@example.com"})
    tools = make_x490_tools(client)
    assert len(tools) == 2
    names = {t.name for t in tools}
    assert "contract_fetch" in names
    assert "inspect_x490_requirements" in names


def test_make_x490_tools_with_x402_client():
    from x490 import X402Client, PaymentProof, PaymentAuthorization
    from x490.langchain import make_x490_tools

    client = ContractClient(party_data={"name": "Agent", "email": "a@example.com"})

    async def pay(req: Any) -> PaymentProof:  # pragma: no cover
        raise NotImplementedError

    x402 = X402Client(pay=pay)
    tools = make_x490_tools(client, x402_client=x402)
    assert len(tools) == 3
    assert any(t.name == "x402_fetch" for t in tools)


@pytest.mark.asyncio
async def test_contract_fetch_tool_200():
    """Tool returns JSON body on plain 200."""
    client = ContractClient(party_data={"name": "Agent", "email": "a@example.com"})
    tool = _make_contract_fetch_tool(client)

    transport = SequentialTransport([
        httpx.Response(200, json={"hello": "world"}),
    ])
    with _patch_async_client(transport):
        result = await tool._arun(url="https://example.com/data")

    assert json.loads(result) == {"hello": "world"}


@pytest.mark.asyncio
async def test_contract_fetch_tool_490_negotiates():
    """Tool auto-negotiates a 490 and returns the final 200 body."""
    req = _make_requirements()
    transport = SequentialTransport([
        httpx.Response(490, headers={"X-490-Requirements": _requirements_header(req)},
                       json={"error": "contract required"}),
        httpx.Response(200, json={"status": "accepted", "contractId": "c1", "token": "tok"}),
        httpx.Response(200, json={"data": "secret"}),
    ])

    client = ContractClient(
        party_data={"name": "Agent", "email": "a@example.com"},
        skip_template_verification=True,
    )
    tool = _make_contract_fetch_tool(client)

    with _patch_async_client(transport):
        result = await tool._arun(url="https://example.com/data")

    assert json.loads(result) == {"data": "secret"}


@pytest.mark.asyncio
async def test_inspect_requirements_tool():
    """Tool decodes and returns contract requirements as JSON."""
    req = _make_requirements()
    tool = _make_inspect_requirements_tool()
    result = await tool._arun(header_value=_requirements_header(req))
    parsed = json.loads(result)
    assert parsed["templateId"] == "tmpl-1"
    assert parsed["resource"] == "/data"

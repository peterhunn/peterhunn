"""Tests for ContractClient using httpx mock transport."""

from __future__ import annotations

import base64
import json
from typing import Any

import httpx
import pytest

from x490 import ContractClient, ContractRequirements


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _make_requirements(**overrides: Any) -> ContractRequirements:
    defaults: dict[str, Any] = {
        "scheme": "x490",
        "version": 1,
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


def _requirements_header(req: ContractRequirements) -> str:
    payload = json.dumps(req.to_dict(), separators=(",", ":"))
    return _b64url_encode(payload.encode())


TOKEN = "test-token-xyz"
CONTRACT_ID = "contract-1"


def _accept_response_body() -> dict[str, Any]:
    return {
        "status": "accepted",
        "contractId": CONTRACT_ID,
        "token": TOKEN,
    }


# ---------------------------------------------------------------------------
# Mock transport
# ---------------------------------------------------------------------------

class SequentialTransport(httpx.AsyncBaseTransport):
    """
    Returns pre-programmed responses in order.  The first call gets
    responses[0], the second gets responses[1], etc.
    """

    def __init__(self, responses: list[httpx.Response]) -> None:
        self._responses = list(responses)
        self._index = 0
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        response = self._responses[self._index]
        self._index += 1
        # Attach a dummy stream so httpx does not complain
        return httpx.Response(
            status_code=response.status_code,
            headers=response.headers,
            content=response.content,
        )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_200_passthrough(monkeypatch):
    """A plain 200 response is returned without any contract negotiation."""
    requirements = _make_requirements()

    transport = SequentialTransport([
        httpx.Response(200, json={"hello": "world"}),
    ])

    async def _mock_client(*args, **kwargs):
        return MockClient(transport)

    client = ContractClient(party_data={"name": "Alice", "email": "alice@example.com"})

    with _patch_async_client(transport):
        response = await client.fetch("https://example.com/data")

    assert response.status_code == 200
    assert len(transport.requests) == 1


@pytest.mark.asyncio
async def test_490_auto_accept_200(monkeypatch):
    """
    Full flow: 490 challenge → POST accept → retry with token → 200.
    """
    requirements = _make_requirements()
    req_header = _requirements_header(requirements)

    transport = SequentialTransport([
        # First request: 490 challenge
        httpx.Response(
            490,
            headers={"X-490-Requirements": req_header},
            json={"error": "Contract required"},
        ),
        # Accept POST: returns token
        httpx.Response(200, json=_accept_response_body()),
        # Retry with token: 200
        httpx.Response(200, json={"data": "secret"}),
    ])

    client = ContractClient(
        party_data={"name": "Alice", "email": "alice@example.com"},
        skip_template_verification=True,
    )

    with _patch_async_client(transport):
        response = await client.fetch("https://example.com/data")

    assert response.status_code == 200
    assert response.json() == {"data": "secret"}

    # Verify the third request carried the contract token
    third_request = transport.requests[2]
    assert third_request.headers.get("x-490-contract") == TOKEN


@pytest.mark.asyncio
async def test_token_cached_on_second_request():
    """
    Second request to the same resource path uses cached token —
    no re-negotiation takes place (only 1 request sent).
    """
    requirements = _make_requirements()

    transport = SequentialTransport([
        httpx.Response(200, json={"data": "secret"}),
    ])

    cache = {"/data": TOKEN}
    client = ContractClient(
        party_data={"name": "Alice", "email": "alice@example.com"},
        cache=cache,
    )

    with _patch_async_client(transport):
        response = await client.fetch("https://example.com/data")

    assert response.status_code == 200
    assert len(transport.requests) == 1
    # Token was sent on the first (and only) request
    assert transport.requests[0].headers.get("x-490-contract") == TOKEN


@pytest.mark.asyncio
async def test_on_requirements_hook_called():
    """on_requirements hook is called with the parsed ContractRequirements."""
    requirements = _make_requirements()
    req_header = _requirements_header(requirements)

    transport = SequentialTransport([
        httpx.Response(
            490,
            headers={"X-490-Requirements": req_header},
            json={"error": "Contract required"},
        ),
        httpx.Response(200, json=_accept_response_body()),
        httpx.Response(200, json={"data": "ok"}),
    ])

    hook_calls: list[ContractRequirements] = []

    def on_req(req: ContractRequirements) -> None:
        hook_calls.append(req)

    client = ContractClient(
        party_data={"name": "Alice", "email": "alice@example.com"},
        on_requirements=on_req,
        skip_template_verification=True,
    )

    with _patch_async_client(transport):
        await client.fetch("https://example.com/data")

    assert len(hook_calls) == 1
    assert isinstance(hook_calls[0], ContractRequirements)
    assert hook_calls[0].templateId == "tmpl-1"


@pytest.mark.asyncio
async def test_template_hash_verified_on_accept():
    """Client fetches template and verifies SHA-256 before accepting."""
    import hashlib

    template_content = b"This is the contract template."
    correct_hash = hashlib.sha256(template_content).hexdigest()
    requirements = _make_requirements(templateHash=correct_hash)
    req_header = _requirements_header(requirements)

    transport = SequentialTransport([
        httpx.Response(490, headers={"X-490-Requirements": req_header}, json={"error": "required"}),
        httpx.Response(200, content=template_content),          # template fetch
        httpx.Response(200, json=_accept_response_body()),      # accept POST
        httpx.Response(200, json={"data": "ok"}),               # retry
    ])

    client = ContractClient(party_data={"name": "Alice", "email": "alice@example.com"})

    with _patch_async_client(transport):
        response = await client.fetch("https://example.com/data")

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_template_hash_mismatch_raises():
    """Client raises ValueError when template content does not match the declared hash."""
    requirements = _make_requirements(templateHash="a" * 64)
    req_header = _requirements_header(requirements)

    transport = SequentialTransport([
        httpx.Response(490, headers={"X-490-Requirements": req_header}, json={"error": "required"}),
        httpx.Response(200, content=b"tampered content"),
    ])

    client = ContractClient(party_data={"name": "Alice", "email": "alice@example.com"})

    with _patch_async_client(transport):
        with pytest.raises(ValueError, match="hash mismatch"):
            await client.fetch("https://example.com/data")


# ---------------------------------------------------------------------------
# Patching helper
# ---------------------------------------------------------------------------

import contextlib
from unittest.mock import AsyncMock, MagicMock, patch


@contextlib.contextmanager
def _patch_async_client(transport: SequentialTransport):
    """
    Patch httpx.AsyncClient so that all requests go through *transport*.
    """
    original_init = httpx.AsyncClient.__init__

    class _PatchedClient(httpx.AsyncClient):
        def __init__(self, **kwargs):
            kwargs["transport"] = transport
            super().__init__(**kwargs)

    with patch("httpx.AsyncClient", _PatchedClient):
        yield

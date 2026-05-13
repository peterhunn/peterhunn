"""Tests for the require_contract ASGI middleware."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from x490 import ContractRequirements, require_contract


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SECRET = "test-secret"


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64url_decode(s: str) -> bytes:
    padded = s + "=" * (4 - len(s) % 4) if len(s) % 4 else s
    return base64.urlsafe_b64decode(padded)


def _make_requirements(**overrides: Any) -> ContractRequirements:
    defaults: dict[str, Any] = {
        "scheme": "x490",
        "version": 1,
        "templateId": "tmpl-1",
        "templateUrl": "https://example.com/template/1",
        "templateHash": "deadbeef",
        "requiredPartyFields": ["name"],
        "acceptEndpoint": "https://example.com/accept",
        "expiresIn": 3600,
        "resource": "/data",
        "description": "Test contract",
        "negotiable": False,
    }
    defaults.update(overrides)
    return ContractRequirements.from_dict(defaults)


def _make_token(
    contract_id: str = "c1",
    party_id: str = "agent",
    resource: str = "/data",
    template_hash: str = "deadbeef",
    exp: int | None = None,
    secret: str = SECRET,
) -> str:
    """Build a valid HMAC-signed x490 token."""
    now = int(time.time())
    payload: dict[str, Any] = {
        "contractId": contract_id,
        "templateHash": template_hash,
        "partyId": party_id,
        "resource": resource,
        "iat": now,
        "exp": exp if exp is not None else now + 3600,
    }
    body = json.dumps(payload, separators=(",", ":"))
    sig = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    token_obj = {"scheme": "x490", "payload": payload, "signature": sig}
    return _b64url_encode(json.dumps(token_obj).encode())


# ---------------------------------------------------------------------------
# Starlette app fixture
# ---------------------------------------------------------------------------

def _make_app(requirements: ContractRequirements) -> Starlette:
    async def data_endpoint(request: Request):
        return JSONResponse(
            {
                "contract_id": request.state.x490_contract_id,
                "party_id": request.state.x490_party_id,
            }
        )

    app = Starlette(routes=[Route("/data", data_endpoint)])
    app.add_middleware(require_contract, requirements=requirements, secret=SECRET)
    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_no_token_returns_490():
    """A request without X-490-Contract header triggers a 490 response."""
    requirements = _make_requirements()
    app = _make_app(requirements)
    client = TestClient(app, raise_server_exceptions=False)

    response = client.get("/data")

    assert response.status_code == 490
    assert "X-490-Requirements" in response.headers

    # The header must be a valid base64url-encoded ContractRequirements JSON
    raw = response.headers["X-490-Requirements"]
    decoded = json.loads(_b64url_decode(raw))
    assert decoded["scheme"] == "x490"
    assert decoded["templateId"] == "tmpl-1"

    # Body should contain requirements as well
    body = response.json()
    assert body["error"] == "Contract required"


def test_valid_token_proceeds():
    """A valid HMAC-signed token allows the request through."""
    requirements = _make_requirements()
    app = _make_app(requirements)
    client = TestClient(app, raise_server_exceptions=False)

    token = _make_token()
    response = client.get("/data", headers={"X-490-Contract": token})

    assert response.status_code == 200
    body = response.json()
    assert body["contract_id"] == "c1"
    assert body["party_id"] == "agent"


def test_invalid_token_returns_490():
    """A tampered or garbage token results in a 490 response."""
    requirements = _make_requirements()
    app = _make_app(requirements)
    client = TestClient(app, raise_server_exceptions=False)

    response = client.get("/data", headers={"X-490-Contract": "not-a-valid-token"})

    assert response.status_code == 490


def test_expired_token_returns_490():
    """An expired token is rejected with 490."""
    requirements = _make_requirements()
    app = _make_app(requirements)
    client = TestClient(app, raise_server_exceptions=False)

    expired_token = _make_token(exp=int(time.time()) - 1)
    response = client.get("/data", headers={"X-490-Contract": expired_token})

    assert response.status_code == 490


def test_wrong_secret_returns_490():
    """A token signed with a different secret is rejected."""
    requirements = _make_requirements()
    app = _make_app(requirements)
    client = TestClient(app, raise_server_exceptions=False)

    token = _make_token(secret="wrong-secret")
    response = client.get("/data", headers={"X-490-Contract": token})

    assert response.status_code == 490


def test_request_state_set_on_valid_token():
    """Middleware stores x490_contract_id and x490_party_id in request.state."""
    requirements = _make_requirements()
    app = _make_app(requirements)
    client = TestClient(app, raise_server_exceptions=False)

    token = _make_token(contract_id="contract-99", party_id="party-42")
    response = client.get("/data", headers={"X-490-Contract": token})

    assert response.status_code == 200
    assert response.json()["contract_id"] == "contract-99"
    assert response.json()["party_id"] == "party-42"

"""Tests for the x402 payment protocol client."""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
import pytest

from x490 import (
    PaymentRequirements,
    PaymentAuthorization,
    PaymentProof,
    X402Client,
    encode_requirements,
    decode_requirements,
    encode_proof,
    decode_proof,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_requirements(**overrides: Any) -> PaymentRequirements:
    defaults: dict[str, Any] = {
        "version": 1,
        "scheme": "exact",
        "network": "base",
        "maxAmountRequired": "1000000",
        "resource": "/api/data",
        "description": "Pay 1 USDC to access this resource",
        "payTo": "0xRecipient",
        "maxTimeoutSeconds": 300,
        "asset": "0xUSDC",
        "extra": {"name": "USDC", "decimals": 6},
    }
    defaults.update(overrides)
    return PaymentRequirements.from_dict(defaults)


def _make_proof(**overrides: Any) -> PaymentProof:
    valid_before = str(int(time.time()) + 3600)
    defaults: dict[str, Any] = {
        "x402Version": 1,
        "scheme": "exact",
        "network": "base",
        "payload": {
            "signature": "0x" + "ab" * 65,
            "authorization": {
                "from": "0xPayer",
                "to": "0xRecipient",
                "value": "1000000",
                "validAfter": "0",
                "validBefore": valid_before,
                "nonce": "0x" + "00" * 32,
            },
        },
    }
    defaults.update(overrides)
    return PaymentProof.from_dict(defaults)


# ---------------------------------------------------------------------------
# Transport mock
# ---------------------------------------------------------------------------

class SequentialTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: list[httpx.Response]) -> None:
        self._responses = list(responses)
        self._index = 0
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        r = self._responses[self._index]
        self._index += 1
        return httpx.Response(
            status_code=r.status_code,
            headers=r.headers,
            content=r.content,
        )


import contextlib
from unittest.mock import patch


@contextlib.contextmanager
def _patch_async_client(transport: SequentialTransport):
    class _Patched(httpx.AsyncClient):
        def __init__(self, **kwargs):
            kwargs["transport"] = transport
            super().__init__(**kwargs)

    with patch("httpx.AsyncClient", _Patched):
        yield


# ---------------------------------------------------------------------------
# Codec tests
# ---------------------------------------------------------------------------

def test_requirements_round_trip():
    req = _make_requirements()
    assert decode_requirements(encode_requirements(req)).to_dict() == req.to_dict()


def test_proof_round_trip():
    proof = _make_proof()
    assert decode_proof(encode_proof(proof)).to_dict() == proof.to_dict()


# ---------------------------------------------------------------------------
# X402Client tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_200_passthrough():
    """Plain 200 is returned without calling pay()."""
    transport = SequentialTransport([
        httpx.Response(200, json={"ok": True}),
    ])

    async def pay(req: PaymentRequirements) -> PaymentProof:  # pragma: no cover
        raise AssertionError("pay() should not be called on 200")

    client = X402Client(pay=pay)
    with _patch_async_client(transport):
        response = await client.fetch("https://example.com/api/data")

    assert response.status_code == 200
    assert len(transport.requests) == 1


@pytest.mark.asyncio
async def test_402_pay_retry_200():
    """402 → pay() → retry with X-Payment → 200."""
    req = _make_requirements()
    proof = _make_proof()

    transport = SequentialTransport([
        httpx.Response(402, headers={"X-Payment-Required": encode_requirements(req)},
                       json={"error": "payment_required"}),
        httpx.Response(200, json={"data": "secret"}),
    ])

    async def pay(r: PaymentRequirements) -> PaymentProof:
        assert r.network == "base"
        return proof

    client = X402Client(pay=pay)
    with _patch_async_client(transport):
        response = await client.fetch("https://example.com/api/data")

    assert response.status_code == 200
    assert response.json() == {"data": "secret"}
    # Second request carries X-Payment header
    second = transport.requests[1]
    assert "x-payment" in dict(second.headers)
    decoded = decode_proof(second.headers["x-payment"])
    assert decoded.network == "base"


@pytest.mark.asyncio
async def test_402_missing_header_raises():
    """402 with no X-Payment-Required header raises ValueError."""
    transport = SequentialTransport([
        httpx.Response(402, json={"error": "payment_required"}),
    ])

    async def pay(r: PaymentRequirements) -> PaymentProof:  # pragma: no cover
        raise AssertionError("should not reach pay()")

    client = X402Client(pay=pay)
    with _patch_async_client(transport):
        with pytest.raises(ValueError, match="X-Payment-Required"):
            await client.fetch("https://example.com/api/data")


@pytest.mark.asyncio
async def test_402_exhausted_raises():
    """Still 402 after max_retries raises RuntimeError."""
    req = _make_requirements()
    proof = _make_proof()

    transport = SequentialTransport([
        httpx.Response(402, headers={"X-Payment-Required": encode_requirements(req)},
                       json={"error": "payment_required"}),
        httpx.Response(402, headers={"X-Payment-Required": encode_requirements(req)},
                       json={"error": "payment_invalid"}),
    ])

    async def pay(r: PaymentRequirements) -> PaymentProof:
        return proof

    client = X402Client(pay=pay, max_retries=1)
    with _patch_async_client(transport):
        with pytest.raises(RuntimeError, match="rejected after 1"):
            await client.fetch("https://example.com/api/data")


@pytest.mark.asyncio
async def test_pay_receives_correct_requirements():
    """pay() is called with fully parsed PaymentRequirements."""
    req = _make_requirements(network="base-sepolia", maxAmountRequired="500000")
    proof = _make_proof(network="base-sepolia")

    transport = SequentialTransport([
        httpx.Response(402, headers={"X-Payment-Required": encode_requirements(req)},
                       json={"error": "payment_required"}),
        httpx.Response(200, json={"ok": True}),
    ])

    received: list[PaymentRequirements] = []

    async def pay(r: PaymentRequirements) -> PaymentProof:
        received.append(r)
        return proof

    client = X402Client(pay=pay)
    with _patch_async_client(transport):
        await client.fetch("https://example.com/api/data")

    assert len(received) == 1
    assert received[0].network == "base-sepolia"
    assert received[0].maxAmountRequired == "500000"

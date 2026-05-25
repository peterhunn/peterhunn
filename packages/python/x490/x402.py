"""x402 HTTP payment protocol — client for handling 402 Payment Required responses."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx


# ---------------------------------------------------------------------------
# Wire types
# ---------------------------------------------------------------------------

@dataclass
class PaymentRequirements:
    version: int
    scheme: str
    network: str
    maxAmountRequired: str
    resource: str
    description: str
    payTo: str
    maxTimeoutSeconds: int
    asset: str
    mimeType: str | None = None
    extra: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PaymentRequirements":
        return cls(
            version=data["version"],
            scheme=data["scheme"],
            network=data["network"],
            maxAmountRequired=data["maxAmountRequired"],
            resource=data["resource"],
            description=data["description"],
            payTo=data["payTo"],
            maxTimeoutSeconds=data["maxTimeoutSeconds"],
            asset=data["asset"],
            mimeType=data.get("mimeType"),
            extra=data.get("extra"),
        )

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "version": self.version,
            "scheme": self.scheme,
            "network": self.network,
            "maxAmountRequired": self.maxAmountRequired,
            "resource": self.resource,
            "description": self.description,
            "payTo": self.payTo,
            "maxTimeoutSeconds": self.maxTimeoutSeconds,
            "asset": self.asset,
        }
        if self.mimeType is not None:
            d["mimeType"] = self.mimeType
        if self.extra is not None:
            d["extra"] = self.extra
        return d


@dataclass
class PaymentAuthorization:
    from_address: str   # 'from' is a Python keyword — exposed as from_address
    to: str
    value: str
    validAfter: str
    validBefore: str
    nonce: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PaymentAuthorization":
        return cls(
            from_address=data["from"],
            to=data["to"],
            value=data["value"],
            validAfter=data["validAfter"],
            validBefore=data["validBefore"],
            nonce=data["nonce"],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "from": self.from_address,
            "to": self.to,
            "value": self.value,
            "validAfter": self.validAfter,
            "validBefore": self.validBefore,
            "nonce": self.nonce,
        }


@dataclass
class PaymentProof:
    x402Version: int
    scheme: str
    network: str
    signature: str
    authorization: PaymentAuthorization

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PaymentProof":
        payload = data["payload"]
        return cls(
            x402Version=data["x402Version"],
            scheme=data["scheme"],
            network=data["network"],
            signature=payload["signature"],
            authorization=PaymentAuthorization.from_dict(payload["authorization"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "x402Version": self.x402Version,
            "scheme": self.scheme,
            "network": self.network,
            "payload": {
                "signature": self.signature,
                "authorization": self.authorization.to_dict(),
            },
        }


# ---------------------------------------------------------------------------
# Codec helpers
# ---------------------------------------------------------------------------

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64url_decode(s: str) -> bytes:
    padded = s + "=" * (4 - len(s) % 4) if len(s) % 4 else s
    return base64.urlsafe_b64decode(padded)


def encode_requirements(req: PaymentRequirements) -> str:
    return _b64url_encode(json.dumps(req.to_dict(), separators=(",", ":")).encode())


def decode_requirements(encoded: str) -> PaymentRequirements:
    return PaymentRequirements.from_dict(json.loads(_b64url_decode(encoded)))


def encode_proof(proof: PaymentProof) -> str:
    return _b64url_encode(json.dumps(proof.to_dict(), separators=(",", ":")).encode())


def decode_proof(encoded: str) -> PaymentProof:
    return PaymentProof.from_dict(json.loads(_b64url_decode(encoded)))


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class X402Client:
    """
    Async HTTP client that transparently handles x402 payment challenges.

    Parameters
    ----------
    pay:
        Async callable invoked with :class:`PaymentRequirements` when a 402
        is received. Must return a :class:`PaymentProof`. In production this
        signs an EIP-3009 authorization with the payer's wallet.
    max_retries:
        Maximum number of payment attempts per request. Default ``1``.
    """

    def __init__(
        self,
        pay: Callable[[PaymentRequirements], Awaitable[PaymentProof]],
        max_retries: int = 1,
    ) -> None:
        self._pay = pay
        self._max_retries = max_retries

    async def fetch(self, url: str, **kwargs: Any) -> httpx.Response:
        """
        Perform an async HTTP request, automatically paying any 402 challenge.

        All keyword arguments are forwarded to :func:`httpx.AsyncClient.request`.
        The default method is ``GET`` when no ``method`` kwarg is given.

        Raises
        ------
        ValueError
            If the 402 response is missing ``X-Payment-Required`` or the
            header is malformed.
        RuntimeError
            If payment is still rejected after ``max_retries`` attempts.
        """
        method: str = kwargs.pop("method", "GET")
        headers: dict[str, str] = dict(kwargs.pop("headers", {}) or {})

        async with httpx.AsyncClient() as client:
            response = await client.request(method, url, headers=headers, **kwargs)

            if response.status_code != 402:
                return response

            for attempt in range(self._max_retries):
                raw = response.headers.get("X-Payment-Required", "")
                if not raw:
                    raise ValueError("402 response missing X-Payment-Required header")

                try:
                    requirements = decode_requirements(raw)
                except Exception as exc:
                    raise ValueError(f"Malformed X-Payment-Required header: {exc}") from exc

                proof = await self._pay(requirements)
                retry_headers = dict(headers)
                retry_headers["X-Payment"] = encode_proof(proof)

                response = await client.request(
                    method, url, headers=retry_headers, **kwargs
                )
                if response.status_code != 402:
                    return response

            raise RuntimeError(
                f"Payment rejected after {self._max_retries} attempt(s)"
            )

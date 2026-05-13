"""
ASGI middleware that enforces x490 contract requirements on protected routes.

Usage (Starlette / FastAPI)::

    from x490 import require_contract

    # Local HMAC mode
    app.add_middleware(require_contract, requirements=my_requirements, secret="hmac-secret")

    # Facilitated / remote-verify mode
    app.add_middleware(require_contract, requirements=my_requirements, facilitated=True)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

try:
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request
    from starlette.responses import JSONResponse, Response
    from starlette.types import ASGIApp
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "The x490 ASGI middleware requires 'starlette'. "
        "Install it with: pip install x490[starlette]"
    ) from exc

import httpx

from .types import ContractRequirements


def _b64url_decode(s: str) -> bytes:
    padded = s + "=" * (4 - len(s) % 4) if len(s) % 4 else s
    return base64.urlsafe_b64decode(padded)


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _requirements_header(requirements: ContractRequirements) -> str:
    """Encode a ContractRequirements object as a base64url JSON string."""
    payload = json.dumps(requirements.to_dict(), separators=(",", ":"))
    return _b64url_encode(payload.encode())


class require_contract(BaseHTTPMiddleware):  # noqa: N801 — intentional lower-case for API
    """
    ASGI middleware that verifies x490 contract tokens.

    Parameters
    ----------
    app:
        The wrapped ASGI application.
    requirements:
        A :class:`~x490.types.ContractRequirements` instance describing the
        contract that clients must accept.
    secret:
        HMAC-SHA256 secret used to verify tokens in local mode.
        Mutually exclusive with ``facilitated=True``.
    facilitated:
        When ``True`` tokens are verified by calling
        ``requirements.verifyEndpoint`` instead of local HMAC.
    """

    def __init__(
        self,
        app: ASGIApp,
        requirements: ContractRequirements,
        secret: str | None = None,
        facilitated: bool = False,
    ) -> None:
        super().__init__(app)
        self._requirements = requirements
        self._secret = secret
        self._facilitated = facilitated

        if not facilitated and secret is None:
            raise ValueError(
                "Either 'secret' (HMAC mode) or 'facilitated=True' must be provided."
            )
        if facilitated and requirements.verifyEndpoint is None:
            raise ValueError(
                "facilitated=True requires requirements.verifyEndpoint to be set."
            )

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        raw_token = request.headers.get("X-490-Contract")

        if raw_token is None:
            return self._challenge_response()

        # Verify token
        try:
            if self._facilitated:
                contract_id, party_id = await self._verify_facilitated(
                    raw_token, request
                )
            else:
                contract_id, party_id = self._verify_hmac(raw_token)
        except _TokenError:
            return self._challenge_response()

        # Store verified info in request state
        request.state.x490_contract_id = contract_id
        request.state.x490_party_id = party_id

        return await call_next(request)

    # ------------------------------------------------------------------
    # Verification helpers
    # ------------------------------------------------------------------

    def _verify_hmac(self, raw_token: str) -> tuple[str, str]:
        """
        Verify an HMAC-signed token.

        Token format (base64url-encoded JSON)::

            {
              "scheme": "x490",
              "payload": { "contractId": ..., "partyId": ..., "resource": ...,
                           "templateHash": ..., "iat": ..., "exp": ... },
              "signature": "<hex(HMAC-SHA256(secret, json(payload)))>"
            }

        The signature covers ``json.dumps(payload, separators=(',', ':'))``.
        """
        assert self._secret is not None
        try:
            token_bytes = _b64url_decode(raw_token)
            token_obj: dict[str, Any] = json.loads(token_bytes)
        except Exception:
            raise _TokenError("malformed token")

        if token_obj.get("scheme") != "x490":
            raise _TokenError("wrong scheme")

        payload: dict[str, Any] = token_obj.get("payload", {})
        signature: str = token_obj.get("signature", "")

        # Reconstruct the canonical body and verify HMAC
        body = json.dumps(payload, separators=(",", ":"))
        expected_sig = hmac.new(
            self._secret.encode(), body.encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(expected_sig, signature):
            raise _TokenError("invalid signature")

        # Check expiry
        exp = payload.get("exp")
        if exp is not None and time.time() > exp:
            raise _TokenError("token expired")

        # Validate resource matches (if present in requirements)
        resource = payload.get("resource", "")
        if self._requirements.resource and resource != self._requirements.resource:
            raise _TokenError("resource mismatch")

        contract_id: str = payload.get("contractId", "")
        party_id: str = payload.get("partyId", "")
        return contract_id, party_id

    async def _verify_facilitated(
        self, raw_token: str, request: Request
    ) -> tuple[str, str]:
        """Verify token by calling the remote verifyEndpoint."""
        verify_url = self._requirements.verifyEndpoint
        assert verify_url is not None
        resource = self._requirements.resource

        async with httpx.AsyncClient() as client:
            resp = await client.get(
                verify_url,
                params={"token": raw_token, "resource": resource},
            )

        if resp.status_code != 200:
            raise _TokenError("remote verification failed")

        data = resp.json()
        if data.get("status") != "valid":
            raise _TokenError("token not valid per verify endpoint")

        contract_id: str = data.get("contractId", "")
        party_id: str = data.get("partyId", "")
        return contract_id, party_id

    # ------------------------------------------------------------------
    # Response builders
    # ------------------------------------------------------------------

    def _challenge_response(self) -> Response:
        header_value = _requirements_header(self._requirements)
        return JSONResponse(
            status_code=490,
            content={
                "error": "Contract required",
                "requirements": self._requirements.to_dict(),
            },
            headers={"X-490-Requirements": header_value},
        )


class _TokenError(Exception):
    """Internal exception for token verification failures."""

"""Async HTTP client that automatically handles x490 contract negotiation."""

from __future__ import annotations

import base64
import json
from typing import Any, Callable

import httpx

from .types import AcceptResponse, ContractRequirements


def _b64url_decode(s: str) -> bytes:
    """Decode a base64url string, adding missing padding as needed."""
    # Add padding so that len is a multiple of 4
    padded = s + "=" * (4 - len(s) % 4) if len(s) % 4 else s
    return base64.urlsafe_b64decode(padded)


class ContractClient:
    """
    Async HTTP client that transparently handles x490 contract negotiation.

    Parameters
    ----------
    party_data:
        Key/value pairs that identify this party and will be submitted to
        every accept endpoint.
    on_requirements:
        Optional async or sync callable invoked with a
        :class:`ContractRequirements` instance whenever a 490 challenge is
        encountered, *before* the accept POST is made.
    cache:
        Optional dict-like mapping resource path → token string.  If not
        provided an in-process ``dict`` is used.
    """

    def __init__(
        self,
        party_data: dict[str, str],
        on_requirements: Callable[[ContractRequirements], Any] | None = None,
        cache: dict[str, str] | None = None,
    ) -> None:
        self._party_data = party_data
        self._on_requirements = on_requirements
        self._cache: dict[str, str] = cache if cache is not None else {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def fetch(self, url: str, **kwargs: Any) -> httpx.Response:
        """
        Perform an async HTTP request, automatically resolving any 490
        challenge before returning the final response.

        All keyword arguments are forwarded to :func:`httpx.AsyncClient.request`.
        The default method is ``GET`` when no ``method`` kwarg is given.
        """
        method: str = kwargs.pop("method", "GET")
        headers: dict[str, str] = dict(kwargs.pop("headers", {}) or {})

        # Determine resource path for cache key
        resource_path = _resource_path(url)

        # If we already hold a token for this resource, attach it now
        if resource_path in self._cache:
            headers["X-490-Contract"] = self._cache[resource_path]

        async with httpx.AsyncClient() as client:
            response = await client.request(method, url, headers=headers, **kwargs)

            if response.status_code != 490:
                return response

            # --- 490 handling ---
            requirements = self._parse_requirements(response)

            if self._on_requirements is not None:
                result = self._on_requirements(requirements)
                # Support both sync and async callables
                if hasattr(result, "__await__"):
                    await result

            token = await self._accept(client, requirements)

            # Cache token under the resource path declared in requirements
            cache_key = requirements.resource or resource_path
            self._cache[cache_key] = token

            # Retry the original request with the contract token
            retry_headers = dict(headers)
            retry_headers["X-490-Contract"] = token
            response = await client.request(
                method, url, headers=retry_headers, **kwargs
            )
            return response

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_requirements(response: httpx.Response) -> ContractRequirements:
        raw_header = response.headers.get("X-490-Requirements", "")
        if not raw_header:
            raise ValueError("490 response missing X-490-Requirements header")
        decoded = _b64url_decode(raw_header)
        data = json.loads(decoded)
        return ContractRequirements.from_dict(data)

    async def _accept(
        self,
        client: httpx.AsyncClient,
        requirements: ContractRequirements,
    ) -> str:
        """POST to the accept endpoint and return the token string."""
        body: dict[str, Any] = {
            "templateId": requirements.templateId,
            "templateHash": requirements.templateHash,
            "partyData": self._party_data,
        }
        accept_response = await client.post(
            requirements.acceptEndpoint,
            json=body,
        )
        accept_response.raise_for_status()
        data = accept_response.json()
        resp = AcceptResponse.from_dict(data)
        return resp.token


def _resource_path(url: str) -> str:
    """Return the path component of *url*, used as cache key."""
    try:
        from urllib.parse import urlparse

        return urlparse(url).path or "/"
    except Exception:
        return url

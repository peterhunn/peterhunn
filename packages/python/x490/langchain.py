"""
LangChain tool wrappers for the x490 contracting protocol.

Install the optional dependency:
    pip install x490[langchain]

Usage::

    from x490.langchain import ContractFetchTool, make_x490_tools
    from x490 import ContractClient

    client = ContractClient(party_data={"name": "My Agent", "email": "agent@example.com"})
    tools = make_x490_tools(client)

    # Use with any LangChain agent
    from langchain.agents import initialize_agent, AgentType
    from langchain_openai import ChatOpenAI

    agent = initialize_agent(tools, ChatOpenAI(), agent=AgentType.OPENAI_FUNCTIONS)
    agent.run("Fetch the resource at https://api.example.com/protected")
"""

from __future__ import annotations

from typing import Any, Type

try:
    from langchain_core.tools import BaseTool
    from pydantic import BaseModel, Field
    _LANGCHAIN_AVAILABLE = True
except ImportError:  # pragma: no cover
    _LANGCHAIN_AVAILABLE = False


def _require_langchain() -> None:  # pragma: no cover
    if not _LANGCHAIN_AVAILABLE:
        raise ImportError(
            "langchain-core is required for x490 LangChain tools. "
            "Install it with: pip install x490[langchain]"
        )


# ---------------------------------------------------------------------------
# Input schemas
# ---------------------------------------------------------------------------

if _LANGCHAIN_AVAILABLE:
    class _FetchInput(BaseModel):
        url: str = Field(description="The URL to fetch. If a 490 challenge is returned, "
                                     "the contract will be negotiated automatically.")
        method: str = Field(default="GET", description="HTTP method (GET, POST, etc.)")

    class _AcceptInput(BaseModel):
        accept_endpoint: str = Field(description="The acceptEndpoint from a ContractRequirements object")
        template_id: str = Field(description="The templateId from the requirements")
        template_hash: str = Field(description="The templateHash from the requirements")

    class _InspectInput(BaseModel):
        header_value: str = Field(description="The raw value of an X-490-Requirements header")
else:
    _FetchInput = Any  # type: ignore[assignment,misc]
    _AcceptInput = Any  # type: ignore[assignment,misc]
    _InspectInput = Any  # type: ignore[assignment,misc]


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

def _make_contract_fetch_tool(client: Any) -> Any:
    """Return a LangChain tool that fetches a URL with automatic x490 negotiation."""
    _require_langchain()

    class ContractFetchTool(BaseTool):
        name: str = "contract_fetch"
        description: str = (
            "Fetch a URL over HTTP. If the server returns a 490 Contract Required "
            "response, the tool automatically negotiates and accepts the contract "
            "before retrying the request. Returns the response body as a string."
        )
        args_schema: Type[BaseModel] = _FetchInput

        def _run(self, url: str, method: str = "GET") -> str:  # pragma: no cover
            raise NotImplementedError("Use async version")

        async def _arun(self, url: str, method: str = "GET") -> str:
            import json as _json
            response = await client.fetch(url, method=method)
            try:
                return _json.dumps(response.json())
            except Exception:
                return response.text

    return ContractFetchTool()


def _make_inspect_requirements_tool() -> Any:
    """Return a LangChain tool that parses an X-490-Requirements header."""
    _require_langchain()

    class InspectRequirementsTool(BaseTool):
        name: str = "inspect_x490_requirements"
        description: str = (
            "Parse the value of an X-490-Requirements header from a 490 response. "
            "Returns the contract requirements as a JSON string so the agent can "
            "inspect them before deciding whether to accept."
        )
        args_schema: Type[BaseModel] = _InspectInput

        def _run(self, header_value: str) -> str:  # pragma: no cover
            raise NotImplementedError("Use async version")

        async def _arun(self, header_value: str) -> str:
            import json as _json
            from .types import ContractRequirements
            import base64

            padded = header_value + "=" * (4 - len(header_value) % 4) if len(header_value) % 4 else header_value
            data = _json.loads(base64.urlsafe_b64decode(padded))
            req = ContractRequirements.from_dict(data)
            return _json.dumps(req.to_dict(), indent=2)

    return InspectRequirementsTool()


def _make_x402_fetch_tool(x402_client: Any) -> Any:
    """Return a LangChain tool that fetches a URL with automatic x402 payment."""
    _require_langchain()

    class X402FetchTool(BaseTool):
        name: str = "x402_fetch"
        description: str = (
            "Fetch a URL over HTTP. If the server returns a 402 Payment Required "
            "response, the tool automatically pays and retries. Returns the response "
            "body as a string."
        )
        args_schema: Type[BaseModel] = _FetchInput

        def _run(self, url: str, method: str = "GET") -> str:  # pragma: no cover
            raise NotImplementedError("Use async version")

        async def _arun(self, url: str, method: str = "GET") -> str:
            import json as _json
            response = await x402_client.fetch(url, method=method)
            try:
                return _json.dumps(response.json())
            except Exception:
                return response.text

    return X402FetchTool()


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def make_x490_tools(client: Any, x402_client: Any = None) -> list[Any]:
    """
    Return a list of LangChain tools for x490 contract negotiation.

    Parameters
    ----------
    client:
        A :class:`x490.ContractClient` instance configured with the agent's
        ``party_data``.
    x402_client:
        Optional :class:`x490.X402Client` instance. When provided, an
        ``x402_fetch`` tool is also included.

    Returns
    -------
    list
        LangChain tools ready to pass to an agent or toolkit.

    Example
    -------
    ::

        from x490 import ContractClient
        from x490.langchain import make_x490_tools

        client = ContractClient(party_data={"name": "Alice", "email": "alice@example.com"})
        tools = make_x490_tools(client)
    """
    _require_langchain()
    tools = [
        _make_contract_fetch_tool(client),
        _make_inspect_requirements_tool(),
    ]
    if x402_client is not None:
        tools.append(_make_x402_fetch_tool(x402_client))
    return tools


# Convenience re-export for direct import
ContractFetchTool = _make_contract_fetch_tool
InspectRequirementsTool = _make_inspect_requirements_tool
X402FetchTool = _make_x402_fetch_tool

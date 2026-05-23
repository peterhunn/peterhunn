# x490 Python SDK

Async HTTP client and ASGI middleware for Python applications participating in the x490 HTTP contracting protocol. Handles `490` challenges automatically: fetches requirements, verifies the template hash, POSTs acceptance, and retries the original request with the issued token.

## Install

```bash
pip install x490              # client only
pip install x490[starlette]   # client + middleware
```

## Client

```python
from x490 import ContractClient

client = ContractClient(
    party_data={"name": "Alice Corp", "email": "legal@alice.example"},
)

# Transparent 490 handling — fetch works like httpx.AsyncClient.get()
response = await client.fetch("https://api.example.com/protected-resource")
```

### Options

| Parameter | Type | Description |
|-----------|------|-------------|
| `party_data` | `dict` | Fields sent during contract acceptance |
| `on_requirements` | `callable` | Hook called with `ContractRequirements` before acceptance |
| `cache` | `dict` | Token cache keyed by resource path (default: in-process dict) |
| `skip_template_verification` | `bool` | Skip SHA-256 template hash check (default: `False`) |

### Token caching

Tokens are cached by resource path. Pass a shared `dict` (or any mutable mapping) to share the cache across client instances:

```python
shared_cache = {}
client_a = ContractClient(party_data={...}, cache=shared_cache)
client_b = ContractClient(party_data={...}, cache=shared_cache)
```

## Middleware (Starlette / FastAPI)

```python
from starlette.applications import Starlette
from x490 import ContractRequirements, require_contract

requirements = ContractRequirements.from_dict({
    "scheme": "x490",
    "version": 1,
    "templateId": "tmpl-nda-v1",
    "templateUrl": "https://facilitator.example.com/templates/abc123",
    "templateHash": "abc123...",
    "requiredPartyFields": ["name", "email"],
    "acceptEndpoint": "https://facilitator.example.com/v1/my-tenant/accept",
    "expiresIn": 3600,
    "resource": "/api/data",
    "description": "Access requires signing the data-sharing NDA",
    "negotiable": False,
})

app = Starlette()
app.add_middleware(
    require_contract,
    requirements=requirements,
    secret="hmac-secret-from-facilitator",  # local HMAC verification
)
```

For facilitated verification (remote verify endpoint instead of local HMAC):

```python
app.add_middleware(
    require_contract,
    requirements=requirements,
    facilitated=True,
)
```

## Dev

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

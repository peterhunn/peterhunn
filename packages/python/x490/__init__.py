"""x490 — Python SDK for the x490 HTTP contracting protocol."""

from .client import ContractClient
from .middleware import require_contract
from .types import AcceptRequest, AcceptResponse, ContractRequirements
from .x402 import (
    PaymentRequirements,
    PaymentAuthorization,
    PaymentProof,
    X402Client,
    encode_requirements,
    decode_requirements,
    encode_proof,
    decode_proof,
)

__all__ = [
    "ContractClient",
    "ContractRequirements",
    "AcceptRequest",
    "AcceptResponse",
    "require_contract",
    "PaymentRequirements",
    "PaymentAuthorization",
    "PaymentProof",
    "X402Client",
    "encode_requirements",
    "decode_requirements",
    "encode_proof",
    "decode_proof",
]

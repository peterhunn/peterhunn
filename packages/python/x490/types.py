"""Wire types for the x490 HTTP contracting protocol."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class NegotiableField:
    """A field that can be negotiated in a contract."""

    name: str
    description: str
    options: list[str] | None = None


@dataclass
class ContractRequirements:
    """Requirements returned in a 490 response header."""

    scheme: str
    version: int
    templateId: str
    templateUrl: str
    templateHash: str
    requiredPartyFields: list[str]
    acceptEndpoint: str
    expiresIn: int
    resource: str
    description: str
    negotiable: bool
    jurisdiction: str | None = None
    governingLaw: str | None = None
    verifyEndpoint: str | None = None
    revokeEndpoint: str | None = None
    negotiableFields: list[NegotiableField] | None = None
    requiredParties: int | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ContractRequirements":
        """Construct from a raw dict (e.g. parsed JSON)."""
        negotiable_fields: list[NegotiableField] | None = None
        if data.get("negotiableFields"):
            negotiable_fields = [
                NegotiableField(
                    name=nf["name"],
                    description=nf["description"],
                    options=nf.get("options"),
                )
                for nf in data["negotiableFields"]
            ]
        return cls(
            scheme=data["scheme"],
            version=data["version"],
            templateId=data["templateId"],
            templateUrl=data["templateUrl"],
            templateHash=data["templateHash"],
            requiredPartyFields=data["requiredPartyFields"],
            acceptEndpoint=data["acceptEndpoint"],
            expiresIn=data["expiresIn"],
            resource=data["resource"],
            description=data["description"],
            negotiable=data["negotiable"],
            jurisdiction=data.get("jurisdiction"),
            governingLaw=data.get("governingLaw"),
            verifyEndpoint=data.get("verifyEndpoint"),
            revokeEndpoint=data.get("revokeEndpoint"),
            negotiableFields=negotiable_fields,
            requiredParties=data.get("requiredParties"),
        )

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a plain dict suitable for JSON encoding."""
        d: dict[str, Any] = {
            "scheme": self.scheme,
            "version": self.version,
            "templateId": self.templateId,
            "templateUrl": self.templateUrl,
            "templateHash": self.templateHash,
            "requiredPartyFields": self.requiredPartyFields,
            "acceptEndpoint": self.acceptEndpoint,
            "expiresIn": self.expiresIn,
            "resource": self.resource,
            "description": self.description,
            "negotiable": self.negotiable,
        }
        if self.jurisdiction is not None:
            d["jurisdiction"] = self.jurisdiction
        if self.governingLaw is not None:
            d["governingLaw"] = self.governingLaw
        if self.verifyEndpoint is not None:
            d["verifyEndpoint"] = self.verifyEndpoint
        if self.revokeEndpoint is not None:
            d["revokeEndpoint"] = self.revokeEndpoint
        if self.negotiableFields is not None:
            d["negotiableFields"] = [
                {
                    "name": nf.name,
                    "description": nf.description,
                    **({"options": nf.options} if nf.options is not None else {}),
                }
                for nf in self.negotiableFields
            ]
        if self.requiredParties is not None:
            d["requiredParties"] = self.requiredParties
        return d


@dataclass
class AcceptRequest:
    """Body sent to the accept endpoint."""

    templateId: str
    templateHash: str
    partyData: dict[str, str]
    negotiationTerms: dict[str, Any] | None = None
    pendingContractId: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "templateId": self.templateId,
            "templateHash": self.templateHash,
            "partyData": self.partyData,
        }
        if self.negotiationTerms is not None:
            d["negotiationTerms"] = self.negotiationTerms
        if self.pendingContractId is not None:
            d["pendingContractId"] = self.pendingContractId
        return d


@dataclass
class AcceptResponse:
    """Response from the accept endpoint."""

    status: str  # "accepted" | "pending" | "counter_offer"
    contractId: str
    token: str  # base64url(JSON(AgreementToken))
    counterOffer: ContractRequirements | None = None
    pendingAcceptances: int | None = None
    requiredAcceptances: int | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AcceptResponse":
        counter_offer: ContractRequirements | None = None
        if data.get("counterOffer"):
            counter_offer = ContractRequirements.from_dict(data["counterOffer"])
        return cls(
            status=data["status"],
            contractId=data["contractId"],
            token=data["token"],
            counterOffer=counter_offer,
            pendingAcceptances=data.get("pendingAcceptances"),
            requiredAcceptances=data.get("requiredAcceptances"),
        )

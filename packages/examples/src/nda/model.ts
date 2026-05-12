import type { ContractData, Party } from "@x490/core";
import { defineModel } from "@x490/core";

/**
 * NDA data model — TypeScript equivalent of a Concerto .cto file.
 *
 * Concerto original:
 *   namespace org.accordproject.nda
 *   concept NDAContract extends AccordContract {
 *     o Party disclosingParty
 *     o Party receivingParty
 *     o DateTime effectiveDate
 *     o Duration duration
 *     o String jurisdiction
 *   }
 */
export interface NDAData extends ContractData {
  $class: "org.accordproject.nda.NDAContract";
  disclosingParty: Party;
  receivingParty: Party;
  effectiveDate: string;     // ISO 8601 date
  durationMonths: number;    // confidentiality period in months
  jurisdiction: string;      // e.g. "California, USA"
  governingLaw: string;      // e.g. "laws of the State of California"
  confidentialInfo: string;  // description of what constitutes confidential info
  mutual: boolean;           // whether obligations flow both ways
}

function isParty(v: unknown): v is Party {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Party).partyId === "string" &&
    typeof (v as Party).name === "string"
  );
}

function isNDAData(v: unknown): v is NDAData {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    d["$class"] === "org.accordproject.nda.NDAContract" &&
    isParty(d["disclosingParty"]) &&
    isParty(d["receivingParty"]) &&
    typeof d["effectiveDate"] === "string" &&
    typeof d["durationMonths"] === "number" &&
    typeof d["jurisdiction"] === "string" &&
    typeof d["governingLaw"] === "string" &&
    typeof d["confidentialInfo"] === "string" &&
    typeof d["mutual"] === "boolean"
  );
}

export const ndaModel = defineModel<NDAData>(
  {
    namespace: "org.accordproject.nda",
    name: "NDAContract",
    version: "1.0.0",
    description: "Non-Disclosure Agreement",
  },
  isNDAData,
);

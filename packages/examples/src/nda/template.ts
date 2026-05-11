import { defineTemplate } from "@legal-agents/core";
import type { NDAData } from "./model.js";
import { ndaModel } from "./model.js";

/**
 * NDA contract template — Cicero-compatible Markdown with {{variable}} placeholders.
 *
 * Variable paths match the NDAData interface exactly, enabling both
 * human readability and AI agent parsing.
 */
const NDA_TEMPLATE_TEXT = `# Non-Disclosure Agreement

This Non-Disclosure Agreement (the "Agreement") is entered into as of {{effectiveDate}}
between {{disclosingParty.name}} ("Disclosing Party") and {{receivingParty.name}} ("Receiving Party").

## 1. Confidential Information

"Confidential Information" means {{confidentialInfo}}.

## 2. Obligations of Receiving Party

The Receiving Party agrees to:
(a) hold all Confidential Information in strict confidence;
(b) not disclose Confidential Information to any third party without prior written consent;
(c) use Confidential Information solely for the purpose of evaluating a potential business relationship.

## 3. Mutual Obligations

{{#if mutual}}
This Agreement is mutual. Each party may serve as both Disclosing Party and Receiving Party,
and each party's obligations under Section 2 apply to information received from the other.
{{else}}
This Agreement is one-directional. Only {{receivingParty.name}} is bound by the obligations in Section 2.
{{/if}}

## 4. Term

This Agreement commences on {{effectiveDate}} and the confidentiality obligations survive for
{{durationMonths}} months from the date of disclosure of each item of Confidential Information.

## 5. Governing Law

This Agreement shall be governed by the {{governingLaw}}.
Any disputes shall be resolved in the courts of {{jurisdiction}}.

## 6. Entire Agreement

This Agreement constitutes the entire agreement between the parties with respect to its subject matter.

IN WITNESS WHEREOF, the parties have executed this Agreement as of {{effectiveDate}}.

**{{disclosingParty.name}}**
Disclosing Party

**{{receivingParty.name}}**
Receiving Party
`;

export const ndaTemplate = defineTemplate<NDAData>(ndaModel, NDA_TEMPLATE_TEXT);

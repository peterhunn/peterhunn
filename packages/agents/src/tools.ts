/**
 * Tool definitions for LLM function calling.
 *
 * These follow the Anthropic tool_use schema (identical structure to OpenAI
 * function calling). They expose the contract stack as callable tools so any
 * code-capable LLM can operate on contracts without custom prompting.
 *
 * Each tool corresponds to a method on ContractAgent<T>.
 */

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

export interface Tool {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

export const CONTRACT_TOOLS = {
  PARSE_CONTRACT: "parse_contract",
  DRAFT_CONTRACT: "draft_contract",
  EXTRACT_OBLIGATIONS: "extract_obligations",
  CHECK_COMPLIANCE: "check_compliance",
  ANALYZE_CLAUSE: "analyze_clause",
  TRIGGER_EVENT: "trigger_event",
  COMPARE_CONTRACTS: "compare_contracts",
} as const;

export type ContractToolName =
  (typeof CONTRACT_TOOLS)[keyof typeof CONTRACT_TOOLS];

export const contractTools: Tool[] = [
  {
    name: CONTRACT_TOOLS.PARSE_CONTRACT,
    description:
      "Extract structured contract data from raw contract text. Returns typed JSON matching the contract's data model.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The full contract text to parse.",
        },
        modelNamespace: {
          type: "string",
          description:
            "The Accord Project namespace of the expected model, e.g. org.accordproject.nda.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: CONTRACT_TOOLS.DRAFT_CONTRACT,
    description:
      "Generate a contract text from structured data using the contract template.",
    input_schema: {
      type: "object",
      properties: {
        data: {
          type: "object",
          description: "Contract data matching the model schema.",
        },
      },
      required: ["data"],
    },
  },
  {
    name: CONTRACT_TOOLS.EXTRACT_OBLIGATIONS,
    description:
      "List all obligations in the contract for each party, including deadlines and triggering conditions.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The full contract text.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: CONTRACT_TOOLS.CHECK_COMPLIANCE,
    description:
      "Evaluate whether the contract terms satisfy a set of requirements. Returns a pass/fail result with explanations.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The contract text to evaluate.",
        },
        requirements: {
          type: "array",
          items: { type: "string" },
          description:
            "Plain-language requirements the contract must satisfy, e.g. ['NDA must be mutual', 'Duration must not exceed 2 years'].",
        },
      },
      required: ["text", "requirements"],
    },
  },
  {
    name: CONTRACT_TOOLS.ANALYZE_CLAUSE,
    description:
      "Explain a specific clause in plain language and identify potential risks or missing protections.",
    input_schema: {
      type: "object",
      properties: {
        clause: {
          type: "string",
          description: "The text of the clause to analyze.",
        },
        context: {
          type: "string",
          description:
            "Optional context about the contract type and parties to improve analysis.",
        },
      },
      required: ["clause"],
    },
  },
  {
    name: CONTRACT_TOOLS.TRIGGER_EVENT,
    description:
      "Submit a contract event (e.g. breach notification, payment, delivery) and return updated contract state with any new obligations.",
    input_schema: {
      type: "object",
      properties: {
        eventType: {
          type: "string",
          description:
            "The event type, e.g. PAYMENT_RECEIVED, BREACH_NOTIFIED, DELIVERY_CONFIRMED.",
        },
        party: {
          type: "string",
          description: "The partyId of the party submitting the event.",
        },
        payload: {
          type: "object",
          description: "Event-specific data.",
        },
      },
      required: ["eventType", "party"],
    },
  },
  {
    name: CONTRACT_TOOLS.COMPARE_CONTRACTS,
    description:
      "Compare two contract versions and summarize differences at the obligation level — not just text diffs.",
    input_schema: {
      type: "object",
      properties: {
        original: {
          type: "string",
          description: "The original contract text.",
        },
        revised: {
          type: "string",
          description: "The revised contract text.",
        },
      },
      required: ["original", "revised"],
    },
  },
];

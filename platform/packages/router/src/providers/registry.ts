import type { ProviderAdapter } from "./types.js";
import { anthropicAdapter } from "./anthropic.js";
import { openaiAdapter } from "./openai.js";
import { googleAdapter } from "./google.js";
import { openaiCompatibleAdapter } from "./openai-compatible.js";
import { mockAdapter } from "./mock.js";

// Provider name → adapter. Model rows carry a `provider` string that
// selects the adapter here. openai_compatible:<slug> falls through to
// the generic OpenAI-compatible adapter, which reads its base URL
// from ATELIER_LLM_<SLUG>_URL and its key from ATELIER_LLM_<SLUG>_KEY.
export const getAdapter = (providerName: string): ProviderAdapter => {
  if (providerName === "anthropic") return anthropicAdapter;
  if (providerName === "openai") return openaiAdapter;
  if (providerName === "google") return googleAdapter;
  if (providerName.startsWith("openai_compatible:")) return openaiCompatibleAdapter;
  if (providerName === "self_hosted") return mockAdapter;
  if (providerName === "mock") return mockAdapter;
  return mockAdapter;
};

export const KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openai_compatible:ollama",
  "openai_compatible:together",
  "openai_compatible:groq",
  "openai_compatible:vllm",
  "openai_compatible:fireworks",
  "self_hosted",
  "mock",
] as const;

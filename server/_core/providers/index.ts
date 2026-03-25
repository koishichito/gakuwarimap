import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { OllamaProvider } from "./ollama";
import { OpenAIProvider } from "./openai";
import type { LLMProvider, LLMProviderName, ResolvedLLMConfig } from "./types";

const DEFAULT_PROVIDER: LLMProviderName = "ollama";

const isNonEmptyString = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeProviderName = (
  value: string | undefined
): LLMProviderName | undefined => {
  if (!value) return undefined;

  switch (value.trim().toLowerCase()) {
    case "openai":
      return "openai";
    case "anthropic":
    case "claude":
      return "anthropic";
    case "gemini":
    case "google":
      return "gemini";
    case "ollama":
      return "ollama";
    default:
      throw new Error(
        `Unsupported LLM_PROVIDER "${value}". Expected one of: openai, anthropic, gemini, ollama`
      );
  }
};

export const resolveLLMConfig = (
  env: NodeJS.ProcessEnv = process.env
): ResolvedLLMConfig => {
  const provider = normalizeProviderName(env.LLM_PROVIDER) ?? DEFAULT_PROVIDER;

  if (provider === "ollama") {
    return {
      provider,
      baseUrl:
        env.LLM_BASE_URL ||
        env.OLLAMA_BASE_URL ||
        env.OLLAMA_AGENT_URL ||
        "https://ollama.gitpullpull.me",
      apiKey: env.LLM_API_KEY || env.OLLAMA_API_KEY || "",
      model: env.LLM_MODEL || env.OLLAMA_MODEL || "Qwen3.5:35b-a3b",
      timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 180_000),
    };
  }

  if (provider === "openai") {
    const apiKey =
      env.LLM_API_KEY || env.OPENAI_API_KEY || env.BUILT_IN_FORGE_API_KEY || "";
    if (!isNonEmptyString(apiKey)) {
      throw new Error(
        "Missing API key for openai provider. Set LLM_API_KEY or OPENAI_API_KEY."
      );
    }

    return {
      provider,
      baseUrl:
        env.LLM_BASE_URL ||
        env.OPENAI_BASE_URL ||
        env.BUILT_IN_FORGE_API_URL ||
        "https://api.openai.com",
      apiKey,
      model:
        env.LLM_MODEL ||
        env.OPENAI_MODEL ||
        (env.BUILT_IN_FORGE_API_KEY ? "gemini-2.5-flash" : "gpt-4o-mini"),
      timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60_000),
    };
  }

  if (provider === "anthropic") {
    const apiKey = env.LLM_API_KEY || env.ANTHROPIC_API_KEY || "";
    if (!isNonEmptyString(apiKey)) {
      throw new Error(
        "Missing API key for anthropic provider. Set LLM_API_KEY or ANTHROPIC_API_KEY."
      );
    }

    return {
      provider,
      baseUrl:
        env.LLM_BASE_URL || env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      apiKey,
      model:
        env.LLM_MODEL || env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
      timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60_000),
    };
  }

  const apiKey = env.LLM_API_KEY || env.GEMINI_API_KEY || "";
  if (!isNonEmptyString(apiKey)) {
    throw new Error(
      "Missing API key for gemini provider. Set LLM_API_KEY or GEMINI_API_KEY."
    );
  }

  return {
    provider,
    baseUrl:
      env.LLM_BASE_URL ||
      env.GEMINI_BASE_URL ||
      "https://generativelanguage.googleapis.com",
    apiKey,
    model: env.LLM_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash",
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60_000),
  };
};

export const createLLMProvider = (
  env: NodeJS.ProcessEnv = process.env
): LLMProvider => {
  const config = resolveLLMConfig(env);

  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    case "gemini":
      return new GeminiProvider(config);
    case "ollama":
      return new OllamaProvider(config);
  }
};

export type { LLMProvider, LLMProviderName, ResolvedLLMConfig } from "./types";

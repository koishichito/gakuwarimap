import type { InvokeParams, InvokeResult, Message } from "../llmTypes";
import type { LLMProvider, ResolvedLLMConfig } from "./types";
import {
  assertSupportedMessageContent,
  getErrorText,
  joinUrl,
  normalizeToolCalls,
  parseToolArguments,
  resolveInvocationOptions,
  stringifyMessageContent,
} from "./shared";

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id?: string;
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
};

type OllamaResponse = {
  model?: string;
  message?: {
    role?: "assistant";
    content?: string;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: Record<string, unknown>;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

const toOllamaMessage = (message: Message): OllamaMessage => {
  const base: OllamaMessage = {
    role:
      message.role === "function"
        ? "tool"
        : (message.role as OllamaMessage["role"]),
    content: stringifyMessageContent(message.content),
  };

  if (message.tool_calls && message.tool_calls.length > 0) {
    base.tool_calls = message.tool_calls.map((toolCall) => ({
      id: toolCall.id,
      function: {
        name: toolCall.function.name,
        arguments: parseToolArguments(toolCall.function.arguments),
      },
    }));
  }

  return base;
};

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama" as const;

  constructor(private readonly config: ResolvedLLMConfig) {}

  async invoke(params: InvokeParams): Promise<InvokeResult> {
    assertSupportedMessageContent(this.name, params.messages);

    const { tools, toolChoice, responseFormat } = resolveInvocationOptions(params);

    const numBatch = Number(process.env.OLLAMA_NUM_BATCH ?? 2048);

    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages: params.messages.map(toOllamaMessage),
      stream: false,
      keep_alive: -1,
      think: false,
      options: {
        num_batch: numBatch,
      },
    };

    if (tools && toolChoice !== "none") {
      payload.tools = tools;
    }

    if (toolChoice && toolChoice !== "none") {
      payload.tool_choice = toolChoice;
    }

    if (responseFormat?.type === "json_object") {
      payload.format = "json";
    }

    if (responseFormat?.type === "json_schema") {
      payload.format = responseFormat.json_schema.schema;
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(joinUrl(this.config.baseUrl, "api/chat"), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      const errorText = await getErrorText(response);
      throw new Error(
        `LLM invoke failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = (await response.json()) as OllamaResponse;
    const toolCalls = normalizeToolCalls(data.message?.tool_calls);
    const promptTokens = Number(data.prompt_eval_count ?? 0);
    const completionTokens = Number(data.eval_count ?? 0);

    return {
      id: `ollama_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      model:
        typeof data.model === "string" && data.model.length > 0
          ? data.model
          : this.config.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: data.message?.content ?? "",
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason:
            data.done_reason ??
            (toolCalls && toolCalls.length > 0 ? "tool_calls" : data.done ? "stop" : null) ??
            null,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }
}

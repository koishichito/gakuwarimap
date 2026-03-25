import {
  makeRequest,
  type PlaceDetailsResult,
  type PlacesSearchResult,
} from "./_core/map";
import { resolveMapsMode } from "./_core/platform";
import { createLLMProvider } from "./_core/providers";

export interface AgentShop {
  name: string;
  address: string;
  place_id: string;
  website?: string;
  lat: number;
  lng: number;
  rating?: number;
  types?: string[];
}

export interface AgentResultItem {
  place_id: string;
  name: string;
  has_gakuwari: boolean;
  discount_info: string;
  source_url: string;
  confidence: "high" | "medium" | "low";
}

export interface GakuwariSearchResult {
  place_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating?: number;
  website?: string;
  types?: string[];
  has_gakuwari: boolean;
  discount_info: string;
  source_url: string;
  confidence: "high" | "medium" | "low";
}

interface SearXNGResult {
  title: string;
  url: string;
  content: string;
}

interface SearXNGResponse {
  results: SearXNGResult[];
}

type AgentConfidence = AgentResultItem["confidence"];

type AgentMessageRole = "system" | "user" | "assistant" | "tool";

type AgentToolCall = {
  id?: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type AgentMessage = {
  role: AgentMessageRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
};

type AgentTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<
        string,
        {
          type: string;
          description?: string;
        }
      >;
      required?: string[];
    };
  };
};

type GeminiChatCompletionResponse = {
  choices?: Array<{
    index: number;
    finish_reason?: string | null;
    message?: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: AgentToolCall[];
    };
  }>;
};

type ParsedAgentResult = Omit<AgentResultItem, "place_id" | "name">;

const DEFAULT_SEARXNG_URL = "https://searxng.gitpullpull.me";
const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
const DEFAULT_GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const MAX_SHOPS = 20;
const BATCH_SIZE = 6;
const AGENT_CACHE_TTL_MS = 1000 * 60 * 60 * 6;

const SYSTEM_PROMPT = [
  "You verify whether a place offers a student discount.",
  "Use only the provided store info and evidence snippets.",
  "Do not make up discounts that are not supported by the evidence.",
  "Treat category-specific student pricing such as 学生カット, 学割U24, U24, 学生限定クーポン, and 高校生 or 大学生料金 as valid student discounts.",
  "Return a JSON object only with these keys:",
  '{"has_gakuwari":true,"discount_info":"string","source_url":"string","confidence":"high|medium|low"}',
  "Use an empty string when discount details or source_url are unavailable.",
  "confidence should be high only when the discount is explicitly confirmed by a reliable source.",
].join("\n");

const DEFAULT_PARSED_RESULT: ParsedAgentResult = {
  has_gakuwari: false,
  discount_info: "",
  source_url: "",
  confidence: "low",
};

const agentResultCache = new Map<
  string,
  {
    expiresAt: number;
    result: ParsedAgentResult;
  }
>();

const createDefaultResult = (shop: AgentShop): AgentResultItem => ({
  place_id: shop.place_id,
  name: shop.name,
  ...DEFAULT_PARSED_RESULT,
});

function getMapsConfigurationError(): string {
  try {
    const mapsMode = resolveMapsMode();
    return mapsMode === "forge"
      ? "Forge maps credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
      : "Google Maps server credentials missing: set GOOGLE_MAPS_SERVER_API_KEY";
  } catch (error) {
    return error instanceof Error ? error.message : "Maps configuration missing";
  }
}

function getSearxngUrl(): string {
  return process.env.SEARXNG_URL?.trim() || DEFAULT_SEARXNG_URL;
}

function getGeminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }

  return {
    apiKey,
    model: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    baseUrl: (
      process.env.GEMINI_OPENAI_BASE_URL?.trim() ||
      DEFAULT_GEMINI_OPENAI_BASE_URL
    ).replace(/\/+$/, ""),
  };
}

function normalizeConfidence(value: unknown): AgentConfidence {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "high" ||
      normalized === "medium" ||
      normalized === "low"
    ) {
      return normalized;
    }
  }

  return "low";
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  if (typeof value === "number") return value !== 0;
  return false;
}

function extractFencedJson(text: string): string | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return codeBlockMatch?.[1]?.trim() || null;
}

function extractFirstJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function extractUrl(text: string): string {
  const match = text.match(/https?:\/\/[^\s)]+/i);
  return match?.[0] ?? "";
}

function normalizeParsedAgentResult(
  parsed: Record<string, unknown>
): ParsedAgentResult {
  return {
    has_gakuwari: toBoolean(parsed.has_gakuwari),
    discount_info:
      typeof parsed.discount_info === "string" ? parsed.discount_info : "",
    source_url:
      typeof parsed.source_url === "string" ? parsed.source_url : "",
    confidence: normalizeConfidence(parsed.confidence),
  };
}

export function parseAgentResultContent(content: string): ParsedAgentResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return DEFAULT_PARSED_RESULT;
  }

  const candidates = [
    trimmed,
    extractFencedJson(trimmed),
    extractFirstJsonObject(trimmed),
    extractFencedJson(trimmed)
      ? extractFirstJsonObject(extractFencedJson(trimmed)!)
      : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const parsed = parseJsonRecord(candidate);
    if (parsed) {
      return normalizeParsedAgentResult(parsed);
    }
  }

  const hasGakuwari =
    /student.?discount|gakuwari|学割|学生カット|学割U24|学生限定|高校生|大学生料金/i.test(
      trimmed
    ) &&
    !/not found|no student discount|unable to confirm|確認できません|見つかりません|学生向けの割引は確認できません/i.test(
      trimmed
    );

  return {
    has_gakuwari: hasGakuwari,
    discount_info: hasGakuwari ? trimmed.slice(0, 200) : "",
    source_url: extractUrl(trimmed),
    confidence: "low",
  };
}

export function parseAgentResult(
  shop: AgentShop,
  content: string
): AgentResultItem {
  return {
    place_id: shop.place_id,
    name: shop.name,
    ...parseAgentResultContent(content),
  };
}

export type LLMProviderMode = "gemini" | "ollama";

/**
 * Unified LLM call that supports Gemini (default) and Ollama.
 * Returns the assistant message content as a string.
 */
async function callLLMForAgent(
  messages: AgentMessage[],
  provider: LLMProviderMode = "gemini"
): Promise<string> {
  if (provider === "ollama") {
    const llm = createLLMProvider({
      ...process.env,
      LLM_PROVIDER: "ollama",
    });
    console.log(`[Agent][Ollama] Requesting chat completion model=${process.env.OLLAMA_MODEL ?? process.env.LLM_MODEL ?? "qwen3.5:27b"}`);
    const result = await llm.invoke({
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
    });
    const raw = result.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Ollama returned no message");
    return typeof raw === "string"
      ? raw
      : raw.map((c) => (c.type === "text" ? c.text : "")).join("");
  }

  // Default: Gemini via OpenAI-compatible endpoint
  const geminiResult = await callGeminiChatCompletion(messages);
  const content = geminiResult.choices?.[0]?.message?.content;
  if (!content) throw new Error("Gemini returned no message");
  return content;
}

async function callGeminiChatCompletion(
  messages: AgentMessage[],
  tools: AgentTool[] = []
): Promise<GeminiChatCompletionResponse> {
  const { apiKey, model, baseUrl } = getGeminiConfig();
  const url = `${baseUrl}/chat/completions`;

  console.log(`[Agent][Gemini] Requesting chat completion with model=${model}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(
      tools.length > 0
        ? {
            model,
            messages,
            tools,
            tool_choice: "auto",
            reasoning_effort: "low",
            stream: false,
          }
        : {
            model,
            messages,
            reasoning_effort: "low",
            stream: false,
          }
    ),
    signal: AbortSignal.timeout(30_000),
  });

  const rawBody = await response.text();

  if (!response.ok) {
    console.error(
      `[Agent][Gemini] Request failed: status=${response.status}, body=${rawBody.slice(
        0,
        500
      )}`
    );
    throw new Error(`Gemini request failed (${response.status})`);
  }

  try {
    return JSON.parse(rawBody) as GeminiChatCompletionResponse;
  } catch (error) {
    console.error("[Agent][Gemini] Non-JSON response body received");
    throw new Error(
      error instanceof Error ? error.message : "Failed to parse Gemini response"
    );
  }
}

async function searxngSearch(query: string): Promise<string> {
  try {
    const params = new URLSearchParams({ q: query, format: "json" });
    const response = await fetch(
      `${getSearxngUrl()}/search?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!response.ok) {
      console.warn(
        `[Agent][Tool] web_search failed (${response.status}): query="${query}"`
      );
      return `Search error: status ${response.status}`;
    }

    const data = (await response.json()) as SearXNGResponse;
    const results = data.results || [];

    if (results.length === 0) {
      return "No search results found.";
    }

    return results
      .slice(0, 5)
      .map(
        (result, index) =>
          `[${index + 1}] ${result.title}\nURL: ${result.url}\n${
            result.content || "(no summary)"
          }`
      )
      .join("\n\n");
  } catch (error) {
    console.error("[Agent][Tool] web_search error:", error);
    return `Search error: ${
      error instanceof Error ? error.message : "unknown error"
    }`;
  }
}

function getCachedAgentResult(shop: AgentShop): AgentResultItem | null {
  const cached = agentResultCache.get(shop.place_id);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    agentResultCache.delete(shop.place_id);
    return null;
  }

  return {
    place_id: shop.place_id,
    name: shop.name,
    ...cached.result,
  };
}

function cacheAgentResult(result: AgentResultItem): void {
  agentResultCache.set(result.place_id, {
    expiresAt: Date.now() + AGENT_CACHE_TTL_MS,
    result: {
      has_gakuwari: result.has_gakuwari,
      discount_info: result.discount_info,
      source_url: result.source_url,
      confidence: result.confidence,
    },
  });
}

function getWebsiteHost(website?: string): string | null {
  if (!website) {
    return null;
  }

  try {
    return new URL(website).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isBeautySalon(shop: AgentShop): boolean {
  const types = shop.types ?? [];
  if (types.includes("hair_care") || types.includes("beauty_salon")) {
    return true;
  }

  return /ヘア|美容|理容|サロン|barber|beauty|hair|カット|カラー|パーマ/i.test(
    shop.name
  );
}

function isKaraoke(shop: AgentShop): boolean {
  const types = shop.types ?? [];
  if (types.some((t) => t.toLowerCase().includes("karaoke"))) return true;
  return /カラオケ|まねきねこ|ビッグエコー|ジャンカラ|コート・ダジュール|シダックス/i.test(
    shop.name
  );
}

/**
 * ブランチ名（例: "京橋店"）を除いたチェーン名を返す。
 * "カラオケまねきねこ 京橋店" → "まねきねこ"
 * "ビッグエコー 渋谷店"      → "ビッグエコー"
 */
function extractChainName(name: string): string {
  // 末尾の「XX店」「XX号店」などを除去
  const stripped = name.replace(/\s+\S*[店号館舗]\s*$/, "").trim();
  // 先頭のカテゴリ語（"カラオケ"など、スペースなしでも除去）を除去
  const withoutPrefix = stripped
    .replace(/^(カラオケ|美容室|理容室|ヘアサロン)\s*/, "")
    .trim();
  return withoutPrefix.length >= 2 ? withoutPrefix : name;
}

function buildEvidenceSearchQuery(shop: AgentShop): string {
  const chainName = extractChainName(shop.name);
  const host = getWebsiteHost(shop.website);

  const searchTerms = ["学割", "学生"];

  if (isBeautySalon(shop)) {
    searchTerms.push(
      "学生カット",
      "学割U24",
      "U24",
      "高校生",
      "大学生",
      "ホットペッパー",
      "minimo"
    );
    if (host) searchTerms.push(host);
  } else if (isKaraoke(shop)) {
    searchTerms.push("学割フリータイム", "学生フリータイム", "学生限定");
  } else {
    searchTerms.push("学生割引");
    if (host) searchTerms.push(host);
  }

  return `${chainName} ${searchTerms.join(" ")}`;
}

function buildEvidenceReviewMessage(
  shop: AgentShop,
  searchQuery: string,
  evidence: string
): string {
  const lines = [
    `Store: ${shop.name}`,
    `Address: ${shop.address || "unknown"}`,
    `Search query: ${searchQuery}`,
  ];

  if (shop.website) {
    lines.push(`Website: ${shop.website}`);
  }

  lines.push("Evidence snippets:");
  lines.push(evidence);
  lines.push("Check whether the store offers a student discount.");
  lines.push(
    "If the evidence does not explicitly support a student discount, return has_gakuwari=false."
  );
  lines.push(
    "Treat 学生カット, 学割U24, U24, 学生限定クーポン, 高校生料金, and 大学生料金 as valid student discounts."
  );
  lines.push("Return JSON only.");

  return lines.join("\n");
}

async function runAgentForShop(
  shop: AgentShop,
  llmProvider: LLMProviderMode = "gemini"
): Promise<AgentResultItem> {
  const startedAt = performance.now();
  const cached = getCachedAgentResult(shop);
  if (cached) {
    console.log(`[Agent][Cache] Using cached result for "${shop.name}"`);
    return cached;
  }

  const searchQuery = buildEvidenceSearchQuery(shop);
  console.log(`[Agent][Tool] web_search query="${searchQuery}"`);

  try {
    const evidenceStartedAt = performance.now();
    const evidence = await searxngSearch(searchQuery);
    const evidenceMs = Math.round(performance.now() - evidenceStartedAt);
    const llmStartedAt = performance.now();

    const content = await callLLMForAgent(
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: buildEvidenceReviewMessage(shop, searchQuery, evidence),
        },
      ],
      llmProvider
    );

    const llmMs = Math.round(performance.now() - llmStartedAt);
    const parsed = parseAgentResult(shop, content);
    cacheAgentResult(parsed);
    console.log(
      `[Agent][Timing][${llmProvider}] Shop="${shop.name}" evidenceMs=${evidenceMs} llmMs=${llmMs} totalMs=${Math.round(
        performance.now() - startedAt
      )}`
    );
    return parsed;
  } catch (error) {
    console.error(`[Agent][${llmProvider}] Shop="${shop.name}" failed:`, error);
    return createDefaultResult(shop);
  }
}

async function enrichShopsWithPlaceDetails(
  shops: AgentShop[]
): Promise<AgentShop[]> {
  if (shops.length === 0) {
    return shops;
  }

  const enrichedShops = await Promise.all(
    shops.slice(0, MAX_SHOPS).map(async (shop) => {
      console.log(`[Agent][Places] details lookup for "${shop.name}"`);

      try {
        const details = await makeRequest<PlaceDetailsResult>(
          "/maps/api/place/details/json",
          {
            place_id: shop.place_id,
            fields: "website,formatted_address",
            language: "ja",
          }
        );

        if (details.status !== "OK" || !details.result) {
          return shop;
        }

        return {
          ...shop,
          address: details.result.formatted_address ?? shop.address,
          website: details.result.website ?? shop.website,
        };
      } catch (error) {
        console.warn(
          `[Agent][Places] details lookup failed for "${shop.name}"`,
          error
        );
        return shop;
      }
    })
  );

  const enrichedMap = new Map(
    enrichedShops.map((shop) => [shop.place_id, shop] as const)
  );

  return shops.map((shop) => enrichedMap.get(shop.place_id) ?? shop);
}

async function searchNearbyPlacesBase(
  lat: number,
  lng: number,
  radius: number = 500,
  keyword?: string,
  type?: string
): Promise<AgentShop[]> {
  try {
    resolveMapsMode();
  } catch {
    throw new Error(getMapsConfigurationError());
  }

  console.log(
    `[Agent][Places] nearby search lat=${lat} lng=${lng} radius=${radius}`
  );

  const params: Record<string, unknown> = {
    location: `${lat},${lng}`,
    radius,
    language: "ja",
  };

  if (keyword) params.keyword = keyword;
  if (type) params.type = type;

  const result = await makeRequest<PlacesSearchResult>(
    "/maps/api/place/nearbysearch/json",
    params
  );

  if (result.status !== "OK" && result.status !== "ZERO_RESULTS") {
    throw new Error(`Places API error: ${result.status}`);
  }

  const shops: AgentShop[] = (result.results || []).map((place) => ({
    name: place.name,
    address: place.formatted_address ?? place.vicinity ?? "",
    place_id: place.place_id,
    lat: place.geometry.location.lat,
    lng: place.geometry.location.lng,
    rating: place.rating,
    types: place.types,
  }));

  return shops;
}

export async function searchNearbyPlaces(
  lat: number,
  lng: number,
  radius: number = 500,
  keyword?: string,
  type?: string
): Promise<AgentShop[]> {
  const shops = await searchNearbyPlacesBase(lat, lng, radius, keyword, type);
  return enrichShopsWithPlaceDetails(shops);
}

export async function searchGakuwariSpots(
  lat: number,
  lng: number,
  radius: number = 500,
  keyword?: string,
  llmProvider: LLMProviderMode = "gemini"
): Promise<GakuwariSearchResult[]> {
  const startedAt = performance.now();
  const shops = (await searchNearbyPlacesBase(lat, lng, radius, keyword)).slice(
    0,
    MAX_SHOPS
  );

  if (shops.length === 0) {
    console.log("[Agent][Places] No shops found nearby");
    return [];
  }

  console.log(
    `[Agent][${llmProvider}] Investigating ${shops.length} nearby shops for discounts`
  );

  const enrichedShopsPromise = enrichShopsWithPlaceDetails(shops);
  const allResults: AgentResultItem[] = [];

  for (let index = 0; index < shops.length; index += BATCH_SIZE) {
    const batch = shops.slice(index, index + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((shop) => runAgentForShop(shop, llmProvider))
    );
    allResults.push(...batchResults);
    console.log(
      `[Agent][${llmProvider}] Completed ${Math.min(index + BATCH_SIZE, shops.length)}/${shops.length} shops`
    );
  }

  const enrichedShops = await enrichedShopsPromise;
  const agentMap = new Map(
    allResults.map((result) => [result.place_id, result] as const)
  );

  console.log(
    `[Agent][Timing] searchGakuwariSpots shops=${shops.length} totalMs=${Math.round(
      performance.now() - startedAt
    )}`
  );

  return enrichedShops.map((shop) => {
    const agentResult = agentMap.get(shop.place_id);
    return {
      place_id: shop.place_id,
      name: agentResult?.name || shop.name,
      address: shop.address,
      lat: shop.lat,
      lng: shop.lng,
      rating: shop.rating,
      website: shop.website,
      types: shop.types,
      has_gakuwari: agentResult?.has_gakuwari ?? false,
      discount_info: agentResult?.discount_info ?? "",
      source_url: agentResult?.source_url ?? "",
      confidence: agentResult?.confidence ?? "low",
    };
  });
}

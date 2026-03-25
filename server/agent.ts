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

type InvestigationCategory =
  | "beauty"
  | "movie"
  | "karaoke"
  | "food"
  | "book"
  | "fashion"
  | "fitness"
  | "generic";

interface SearchProfileDefinition {
  id: string;
  label: string;
  bias: number;
  type?: string;
  defaultKeyword?: string;
  matcher: RegExp;
}

interface SearchProfile {
  id: string;
  label: string;
  priority: number;
  scout: "Scout/Ranker";
  type?: string;
  keyword?: string;
}

interface SearchContext {
  lat: number;
  lng: number;
  radius: number;
  keyword?: string;
  normalizedKeyword: string;
  preferredProfileIds: Set<string>;
}

interface CandidateAccumulator {
  shop: AgentShop;
  matchedProfileIds: Set<string>;
  preferredMatch: boolean;
  keywordMatch: boolean;
}

interface CandidateSeed extends AgentShop {
  matchedProfileIds: string[];
  preferredMatch: boolean;
  keywordMatch: boolean;
}

interface RankedCandidate extends CandidateSeed {
  rank: number;
  scoutScore: number;
  distanceMeters: number;
  scout: "Scout/Ranker";
}

interface EvidenceSnippet extends SearXNGResult {
  query: string;
}

interface EvidenceBundle {
  shop: AgentShop;
  retriever: "Retriever";
  queries: string[];
  snippets: EvidenceSnippet[];
  sourceUrls: string[];
  summary: string;
}

interface InvestigationOutcome {
  shop: RankedCandidate;
  evidence: EvidenceBundle;
  result: AgentResultItem;
  rank: number;
  reviewed: boolean;
  reviewerTriggered: boolean;
  verifier: "Verifier";
  reviewer?: "Reviewer";
}

const DEFAULT_SEARXNG_URL = "https://searxng.gitpullpull.me";
const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
const DEFAULT_GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const SEARCH_STRATEGY_VERSION = "agent-team-v1";
const MAX_SHOPS = 20;
const BATCH_SIZE = 6;
const MAX_CANDIDATES = 60;
const MAX_DETAILS_SHOPS = 24;
const MAX_PROFILE_NEXT_PAGES = 2;
const MAX_SEARCH_RESULTS_PER_QUERY = 4;
const MAX_EVIDENCE_SNIPPETS = 6;
const WAVE_ONE_SIZE = 8;
const WAVE_TWO_SIZE = 8;
const MAX_INVESTIGATED_AFTER_HIT = 12;
const INVESTIGATION_BATCH_SIZE = 4;
const AGENT_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const GENERIC_STUDENT_EVIDENCE_KEYWORDS = [
  "学割",
  "学生割引",
  "学生料金",
  "学生価格",
  "学生プラン",
  "学生証",
  "学生証提示",
  "高校生料金",
  "大学生料金",
];
const STUDENT_POSITIVE_PATTERNS = [
  /student.?discount/i,
  /student.?price/i,
  /student.?rate/i,
  /student.?plan/i,
  /学割/i,
  /学生割引/i,
  /学生料金/i,
  /学生価格/i,
  /学生プラン/i,
  /学生限定/i,
  /学生証(?:提示|持参|ご提示|の提示)?/i,
  /学生カット/i,
  /学割U\d+/i,
  /高校生(?:料金|割引|価格)?/i,
  /大学生(?:料金|割引|価格)?/i,
  /専門学生(?:料金|割引|価格)?/i,
  /中高生(?:料金|割引|価格)?/i,
  /学生フリータイム/i,
  /学生パック/i,
  /学割パック/i,
  /学生チケット/i,
  /学生入場料/i,
  /学生鑑賞券/i,
  /学生会員/i,
  /学生コース/i,
];
const STUDENT_NEGATIVE_PATTERNS = [
  /not found/i,
  /no student discount/i,
  /no student pricing/i,
  /unable to confirm/i,
  /学割なし/i,
  /学生割引なし/i,
  /学生料金なし/i,
  /学生価格なし/i,
  /学生プランなし/i,
  /学生向け(?:料金|割引|特典).{0,8}なし/i,
  /確認できません/i,
  /見つかりません/i,
];

const SYSTEM_PROMPT = [
  "You verify whether a place offers any student-oriented pricing or benefit.",
  "Use only the provided store info and evidence snippets.",
  "Do not make up discounts that are not supported by the evidence.",
  "Treat category-specific student pricing such as 学生カット, 学割U24, U24, 学生限定クーポン, and 高校生 or 大学生料金 as valid student discounts.",
  "Treat explicit student rates, student plans, student-ID offers, student-only coupons, and category-specific student menus or tickets as valid student discounts.",
  "Examples include 学生料金, 学生価格, 学生プラン, 学生証提示, 学生限定, 学生フリータイム, 学生パック, 学生チケット, 学生入場料, 学生カット, 学割U24, 高校生料金, 大学生料金, and 専門学生料金.",
  "Return a JSON object only with these keys:",
  '{"has_gakuwari":true,"discount_info":"string","source_url":"string","confidence":"high|medium|low"}',
  "Use an empty string when discount details or source_url are unavailable.",
  "confidence should be high only when the discount is explicitly confirmed by a reliable source.",
  "Use confidence=low when the evidence is missing, ambiguous, indirect, or only weakly suggests a student offer.",
  "Use has_gakuwari=false with medium or high confidence only when the evidence explicitly says student pricing is unavailable or not applicable.",
].join("\n");

const DEFAULT_PARSED_RESULT: ParsedAgentResult = {
  has_gakuwari: false,
  discount_info: "",
  source_url: "",
  confidence: "low",
};

const REVIEW_SYSTEM_PROMPT = [
  "You are the reviewer in a student discount agent team.",
  "Re-check a high-priority store that previously looked negative or low-confidence.",
  "Use only the provided store info and evidence snippets.",
  "If the evidence still does not explicitly support a student discount, return has_gakuwari=false.",
  "Treat 学生カット, 学割U24, U24, 学生限定クーポン, 高校生料金, and 大学生料金 as valid student discounts.",
  "Return a JSON object only with these keys:",
  '{"has_gakuwari":true,"discount_info":"string","source_url":"string","confidence":"high|medium|low"}',
].join("\n");

const SEARCH_PROFILE_DEFINITIONS: SearchProfileDefinition[] = [
  { id: "cafe", label: "Cafe", type: "cafe", bias: 18, matcher: /cafe|coffee|カフェ|喫茶|コーヒー/i },
  { id: "restaurant", label: "Restaurant", type: "restaurant", bias: 16, matcher: /restaurant|food|lunch|dinner|ラーメン|うどん|レストラン|ランチ|ごはん|定食/i },
  { id: "movie_theater", label: "Movie Theater", type: "movie_theater", bias: 24, matcher: /movie|cinema|theater|映画|シネマ|劇場/i },
  { id: "karaoke", label: "Karaoke", defaultKeyword: "カラオケ", bias: 24, matcher: /karaoke|カラオケ|まねきねこ/i },
  { id: "hair_care", label: "Hair Care", type: "hair_care", bias: 26, matcher: /hair|beauty|salon|barber|美容|理容|ヘア|サロン|カラー|カット|パーマ/i },
  { id: "book_store", label: "Book Store", type: "book_store", bias: 14, matcher: /book|books|書店|本|文具|参考書/i },
  { id: "clothing_store", label: "Clothing Store", type: "clothing_store", bias: 12, matcher: /clothing|fashion|apparel|服|ファッション|アパレル/i },
  { id: "gym", label: "Gym", type: "gym", bias: 12, matcher: /gym|fitness|ジム|フィットネス|トレーニング/i },
];

const CATEGORY_SPECIFIC_TERMS: Record<InvestigationCategory, string[]> = {
  beauty: ["学割U24", "学生カット", "学生限定", "ホットペッパー", "minimo"],
  movie: ["学生料金", "大学生料金", "高校生料金", "シネマ", "学割"],
  karaoke: ["学生料金", "大学生料金", "学生フリータイム", "中高生料金", "カラオケ"],
  food: ["学割", "学生割引", "学生証", "学生限定", "クーポン"],
  book: ["学割", "学生応援", "学生証", "参考書", "教科書"],
  fashion: ["学割", "学生限定", "学生応援", "アプリ", "クーポン"],
  fitness: ["学割", "学生プラン", "学生会員", "学生証", "キャンペーン"],
  generic: ["学割", "学生割引", "学生証", "学生限定"],
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

function confidenceToScore(confidence: AgentConfidence): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
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

function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
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

  const fallbackHasGakuwari =
    matchesAnyPattern(trimmed, STUDENT_POSITIVE_PATTERNS) &&
    !matchesAnyPattern(trimmed, STUDENT_NEGATIVE_PATTERNS);

  const hasGakuwari =
    /student.?discount|gakuwari|学割|学生カット|学割U24|学生限定|高校生|大学生料金/i.test(
      trimmed
    ) &&
    !/not found|no student discount|unable to confirm|確認できません|見つかりません|学生向けの割引は確認できません/i.test(
      trimmed
    );

  return {
    has_gakuwari: fallbackHasGakuwari,
    discount_info: fallbackHasGakuwari ? trimmed.slice(0, 200) : "",
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

async function callLLMForAgent(
  messages: AgentMessage[],
  provider: LLMProviderMode = "gemini"
): Promise<string> {
  if (provider === "ollama") {
    const llm = createLLMProvider({
      ...process.env,
      LLM_PROVIDER: "ollama",
    });
    const result = await llm.invoke({
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      })),
    });
    const raw = result.choices?.[0]?.message?.content;

    if (!raw) {
      throw new Error("Ollama returned no message");
    }

    return typeof raw === "string"
      ? raw
      : raw.map((chunk) => (chunk.type === "text" ? chunk.text : "")).join("");
  }

  const result = await callGeminiChatCompletion(messages);
  const content = result.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Gemini returned no message");
  }

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

function getAgentCacheKey(shop: AgentShop, searchQuery: string): string {
  return `${SEARCH_STRATEGY_VERSION}::${shop.place_id}::${searchQuery
    .trim()
    .toLowerCase()}`;
}

export function getAgentCacheKeyForPlace(placeId: string): string {
  return `${SEARCH_STRATEGY_VERSION}::${placeId}`;
}

function getCachedAgentResult(
  cacheKey: string,
  shop: AgentShop
): AgentResultItem | null {
  const cached = agentResultCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    agentResultCache.delete(cacheKey);
    return null;
  }

  return {
    place_id: shop.place_id,
    name: shop.name,
    ...cached.result,
  };
}

function cacheAgentResult(cacheKey: string, result: AgentResultItem): void {
  agentResultCache.set(cacheKey, {
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

function buildEvidenceSearchQuery(shop: AgentShop): string {
  const host = getWebsiteHost(shop.website);

  const searchTerms = ["学割", "学生割引", "学生"];
  if (isBeautySalon(shop)) {
    searchTerms.push(
      "学生カット",
      "学割U24",
      "U24",
      "学生限定",
      "高校生",
      "大学生",
      "ホットペッパー",
      "minimo"
    );
  }

  if (host) {
    searchTerms.push(host);
  }

  const addressHint =
    typeof shop.address === "string" && shop.address.trim().length > 0
      ? ` ${shop.address.trim().slice(0, 40)}`
      : "";

  return `"${shop.name}"${addressHint} ${searchTerms.join(" ")}`;
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
  lines.push("Check whether the store offers any student-oriented pricing or benefit.");
  lines.push(
    "If the evidence does not explicitly support a student discount, return has_gakuwari=false with low confidence."
  );
  lines.push(
    "Treat 学生カット, 学割U24, U24, 学生限定クーポン, 高校生料金, and 大学生料金 as valid student discounts."
  );
  lines.push(
    "Check whether the store offers any student-oriented pricing or benefit."
  );
  lines.push(
    "Student discounts include student pricing, student plans, student-ID benefits, student-only coupons, and category-specific student menus, passes, or tickets."
  );
  lines.push(
    "If the evidence does not explicitly support a student discount, return has_gakuwari=false with low confidence."
  );
  lines.push("Return JSON only.");

  return lines.join("\n");
}

function hasAnyPlaceType(shop: AgentShop, ...types: string[]): boolean {
  const shopTypes = shop.types ?? [];
  return types.some((type) => shopTypes.includes(type));
}

function getShopSearchText(shop: AgentShop): string {
  return `${shop.name} ${shop.address} ${(shop.types ?? []).join(" ")}`;
}

function isBeautySalonLike(shop: AgentShop): boolean {
  if (hasAnyPlaceType(shop, "hair_care", "beauty_salon")) {
    return true;
  }

  return /ヘア|美容|理容|サロン|barber|beauty|hair|カット|カラー|パーマ/i.test(
    getShopSearchText(shop)
  );
}

function isKaraokeOrAmusementShop(shop: AgentShop): boolean {
  if (hasAnyPlaceType(shop, "karaoke", "bowling_alley", "amusement_center")) {
    return true;
  }

  return /カラオケ|まねきねこ|ビッグエコー|ジャンカラ|コート・ダジュール|ラウンドワン|round1/i.test(
    getShopSearchText(shop)
  );
}

function isCinemaOrTicketedVenue(shop: AgentShop): boolean {
  if (
    hasAnyPlaceType(
      shop,
      "movie_theater",
      "museum",
      "art_gallery",
      "tourist_attraction",
      "amusement_park",
      "aquarium",
      "zoo"
    )
  ) {
    return true;
  }

  return /映画|シネマ|劇場|博物館|美術館|水族館|動物園|テーマパーク|展望台/i.test(
    getShopSearchText(shop)
  );
}

function isFitnessOrActivityShop(shop: AgentShop): boolean {
  if (hasAnyPlaceType(shop, "gym", "spa", "stadium")) {
    return true;
  }

  return /ジム|フィットネス|ヨガ|ピラティス|ボルダリング|スイミング|テニス/i.test(
    getShopSearchText(shop)
  );
}

function isFoodOrCafeShop(shop: AgentShop): boolean {
  if (hasAnyPlaceType(shop, "restaurant", "cafe", "bakery", "meal_takeaway")) {
    return true;
  }

  return /カフェ|喫茶|レストラン|食堂|ランチ|定食|ラーメン|居酒屋|バーガー/i.test(
    getShopSearchText(shop)
  );
}

function isRetailOrStudyShop(shop: AgentShop): boolean {
  if (hasAnyPlaceType(shop, "book_store", "clothing_store", "store", "library")) {
    return true;
  }

  return /書店|本屋|古本|アパレル|服|メガネ|携帯|スマホ|塾|予備校|自習室|コワーキング|ネットカフェ|漫画喫茶/i.test(
    getShopSearchText(shop)
  );
}

function getAdaptiveStudentEvidenceKeywords(
  shop: AgentShop,
  userKeyword?: string
): string[] {
  const searchTerms = [...GENERIC_STUDENT_EVIDENCE_KEYWORDS];

  if (userKeyword?.trim()) {
    searchTerms.push(userKeyword.trim());
  }

  if (isBeautySalonLike(shop)) {
    searchTerms.push(
      "学生カット",
      "学割U24",
      "U24",
      "学生限定",
      "ホットペッパー",
      "minimo"
    );
  }

  if (isKaraokeOrAmusementShop(shop)) {
    searchTerms.push(
      "学生フリータイム",
      "学生パック",
      "学割パック",
      "中高生料金",
      "大学生料金",
      "ルーム料金"
    );
  }

  if (isCinemaOrTicketedVenue(shop)) {
    searchTerms.push(
      "学生チケット",
      "学生入場料",
      "学生鑑賞券",
      "高校生料金",
      "大学生料金"
    );
  }

  if (isFitnessOrActivityShop(shop)) {
    searchTerms.push("学生会員", "学生コース", "学生プラン", "学生料金");
  }

  if (isFoodOrCafeShop(shop)) {
    searchTerms.push("学生証", "学生限定", "学生セット", "学生応援");
  }

  if (isRetailOrStudyShop(shop)) {
    searchTerms.push("学生応援", "学生価格", "キャンペーン", "学生限定");
  }

  const host = getWebsiteHost(shop.website);
  if (host) {
    searchTerms.push(host);
  }

  return searchTerms
    .filter(Boolean)
    .filter((term, index, list) => list.indexOf(term) === index)
    .slice(0, 16);
}

function buildAdaptiveEvidenceSearchQuery(
  shop: AgentShop,
  userKeyword?: string
): string {
  const searchTerms = getAdaptiveStudentEvidenceKeywords(shop, userKeyword);
  const addressHint =
    typeof shop.address === "string" && shop.address.trim().length > 0
      ? ` ${shop.address.trim().slice(0, 40)}`
      : "";

  return `"${shop.name}"${addressHint} ${searchTerms.join(" ")}`;
}

function buildAdaptiveEvidenceReviewMessage(
  shop: AgentShop,
  searchQuery: string,
  evidence: string,
  userKeyword?: string
): string {
  const lines = [
    `Store: ${shop.name}`,
    `Address: ${shop.address || "unknown"}`,
    `Search query: ${searchQuery}`,
  ];

  if (shop.website) {
    lines.push(`Website: ${shop.website}`);
  }

  if (userKeyword?.trim()) {
    lines.push(`User intent keyword: ${userKeyword.trim()}`);
  }

  lines.push("Evidence snippets:");
  lines.push(evidence);
  lines.push("Check whether the store offers a student discount.");
  lines.push(
    "Student discounts include student pricing, student plans, student-ID benefits, student-only coupons, and category-specific student menus or passes."
  );
  lines.push(
    "Examples include 学生料金, 学生価格, 学生プラン, 学生証提示, 学生限定, 学生フリータイム, 学生パック, 学生チケット, 学生入場料, 学生カット, 学割U24, 高校生料金, 大学生料金, and 専門学生料金."
  );
  lines.push(
    "If the evidence is ambiguous or missing, return has_gakuwari=false with confidence=low."
  );
  lines.push(
    "Re-check this high-priority candidate. If evidence explicitly supports any student-oriented pricing or benefit, set has_gakuwari=true."
  );
  lines.push(
    "If evidence is still insufficient, keep has_gakuwari=false and use low or medium confidence."
  );
  lines.push("Return JSON only.");

  return lines.join("\n");
}

async function runAgentForShop(
  shop: AgentShop,
  userKeyword?: string,
  llmProvider: LLMProviderMode = "gemini"
): Promise<AgentResultItem> {
  const startedAt = performance.now();
  const searchQuery = buildAdaptiveEvidenceSearchQuery(shop, userKeyword);
  const cacheKey = getAgentCacheKey(shop, searchQuery);
  const cached = getCachedAgentResult(cacheKey, shop);
  if (cached) {
    console.log(`[Agent][Cache] Using cached result for "${shop.name}"`);
    return cached;
  }

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
          content: buildAdaptiveEvidenceReviewMessage(
            shop,
            searchQuery,
            evidence,
            userKeyword
          ),
        },
      ],
      llmProvider
    );
    const llmMs = Math.round(performance.now() - llmStartedAt);

    const parsed = parseAgentResult(shop, content);
    cacheAgentResult(cacheKey, parsed);
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

function normalizeSearchKeyword(keyword?: string): string {
  return keyword?.trim().toLowerCase() ?? "";
}

function createSearchContext(
  lat: number,
  lng: number,
  radius: number,
  keyword?: string
): SearchContext {
  const normalizedKeyword = normalizeSearchKeyword(keyword);
  return {
    lat,
    lng,
    radius,
    keyword: keyword?.trim() || undefined,
    normalizedKeyword,
    preferredProfileIds: new Set(
      SEARCH_PROFILE_DEFINITIONS.filter(
        (definition) => normalizedKeyword && definition.matcher.test(normalizedKeyword)
      ).map((definition) => definition.id)
    ),
  };
}

function buildAgentTeamProfiles(keyword?: string): SearchProfile[] {
  const normalizedKeyword = normalizeSearchKeyword(keyword);
  const preferredProfileIds = new Set(
    SEARCH_PROFILE_DEFINITIONS.filter(
      (definition) => normalizedKeyword && definition.matcher.test(normalizedKeyword)
    ).map((definition) => definition.id)
  );

  const profiles: SearchProfile[] = [
    {
      id: "broad",
      label: "Broad Nearby",
      priority: normalizedKeyword ? 500 : 420,
      scout: "Scout/Ranker",
      keyword: keyword?.trim() || undefined,
    },
    ...SEARCH_PROFILE_DEFINITIONS.map((definition) => {
      const preferred = preferredProfileIds.has(definition.id);
      return {
        id: definition.id,
        label: definition.label,
        scout: "Scout/Ranker" as const,
        type: definition.type,
        keyword: preferred
          ? keyword?.trim() || undefined
          : definition.defaultKeyword,
        priority: (preferred ? 380 : 220) + definition.bias,
      };
    }),
  ];

  return profiles.sort((left, right) => right.priority - left.priority);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getNextPageDelayMs(): number {
  return 1_500;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function getDistanceMeters(
  from: Pick<SearchContext, "lat" | "lng">,
  to: Pick<AgentShop, "lat" | "lng">
): number {
  const earthRadiusMeters = 6_371_000;
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(h));
}

function toAgentShop(place: PlacesSearchResult["results"][number]): AgentShop {
  return {
    name: place.name,
    address: place.formatted_address ?? place.vicinity ?? "",
    place_id: place.place_id,
    lat: place.geometry.location.lat,
    lng: place.geometry.location.lng,
    rating: place.rating,
    types: place.types,
  };
}

function mergeShop(existing: AgentShop, incoming: AgentShop): AgentShop {
  return {
    ...existing,
    ...incoming,
    address:
      incoming.address.length > existing.address.length
        ? incoming.address
        : existing.address,
    website: incoming.website ?? existing.website,
    rating: incoming.rating ?? existing.rating,
    types: Array.from(
      new Set([...(existing.types ?? []), ...(incoming.types ?? [])])
    ),
  };
}

function getCandidateCategoryBias(shop: AgentShop): number {
  if (isBeautySalonLike(shop)) return 26;
  if (isCinemaOrTicketedVenue(shop) || isKaraokeOrAmusementShop(shop)) return 22;
  if (isFoodOrCafeShop(shop)) return 16;
  if (isRetailOrStudyShop(shop)) return 14;
  if (isFitnessOrActivityShop(shop)) return 12;
  return 0;
}

function getStudentSignalScore(shop: AgentShop): number {
  if (matchesAnyPattern(getShopSearchText(shop), STUDENT_POSITIVE_PATTERNS)) {
    return 12;
  }

  if (isBeautySalonLike(shop)) return 10;
  if (isCinemaOrTicketedVenue(shop) || isKaraokeOrAmusementShop(shop)) return 8;
  if (
    isFoodOrCafeShop(shop) ||
    isRetailOrStudyShop(shop) ||
    isFitnessOrActivityShop(shop)
  ) {
    return 4;
  }

  return 0;
}

function computeCandidateScore(
  candidate: CandidateSeed,
  context: SearchContext,
  withDetailBonuses: boolean
): number {
  const distanceMeters = getDistanceMeters(context, candidate);
  const distanceRatio =
    1 - Math.min(distanceMeters / Math.max(context.radius, 1), 1);

  let score = 0;
  score += candidate.preferredMatch ? 28 : 0;
  score += candidate.keywordMatch ? 18 : 0;
  score += Math.min(candidate.matchedProfileIds.length, 4) * 4;
  score += getCandidateCategoryBias(candidate);
  score += getStudentSignalScore(candidate);
  score += distanceRatio * 22;
  score += Math.min(candidate.rating ?? 0, 5) * 2;

  if (withDetailBonuses) {
    score += candidate.website ? 6 : 0;
    score += candidate.address.trim().length > 8 ? 2 : 0;
  }

  return Number(score.toFixed(2));
}

function rankCandidateSeeds(
  seeds: CandidateSeed[],
  context: SearchContext,
  withDetailBonuses: boolean
): RankedCandidate[] {
  return seeds
    .map((seed) => ({
      ...seed,
      scout: "Scout/Ranker" as const,
      scoutScore: computeCandidateScore(seed, context, withDetailBonuses),
      distanceMeters: getDistanceMeters(context, seed),
    }))
    .sort((left, right) => {
      if (right.scoutScore !== left.scoutScore) {
        return right.scoutScore - left.scoutScore;
      }

      if (left.distanceMeters !== right.distanceMeters) {
        return left.distanceMeters - right.distanceMeters;
      }

      return left.name.localeCompare(right.name, "ja");
    })
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }));
}

function upsertCandidate(
  candidates: Map<string, CandidateAccumulator>,
  shop: AgentShop,
  profile: SearchProfile,
  context: SearchContext
): void {
  const distanceMeters = getDistanceMeters(context, shop);
  if (distanceMeters > context.radius) {
    return;
  }

  const keywordMatch = context.normalizedKeyword
    ? getShopSearchText(shop).toLowerCase().includes(context.normalizedKeyword)
    : false;
  const preferredMatch =
    context.preferredProfileIds.has(profile.id) || keywordMatch;
  const existing = candidates.get(shop.place_id);

  if (existing) {
    existing.shop = mergeShop(existing.shop, shop);
    existing.matchedProfileIds.add(profile.id);
    existing.preferredMatch ||= preferredMatch;
    existing.keywordMatch ||= keywordMatch;
    return;
  }

  candidates.set(shop.place_id, {
    shop,
    matchedProfileIds: new Set([profile.id]),
    preferredMatch,
    keywordMatch,
  });
}

async function searchNearbyPlacesProfilePage(
  context: SearchContext,
  profile: SearchProfile,
  nextPageToken?: string
): Promise<PlacesSearchResult> {
  const params: Record<string, unknown> = nextPageToken
    ? {
        pagetoken: nextPageToken,
        language: "ja",
      }
    : {
        location: `${context.lat},${context.lng}`,
        radius: context.radius,
        language: "ja",
      };

  if (!nextPageToken) {
    if (profile.type) params.type = profile.type;
    if (profile.keyword) params.keyword = profile.keyword;
  } else {
    await delay(getNextPageDelayMs());
  }

  const result = await makeRequest<PlacesSearchResult>(
    "/maps/api/place/nearbysearch/json",
    params
  );

  if (result.status !== "OK" && result.status !== "ZERO_RESULTS") {
    throw new Error(`Places API error: ${result.status}`);
  }

  return result;
}

async function collectCandidateSeeds(
  context: SearchContext,
  profiles: SearchProfile[]
): Promise<CandidateSeed[]> {
  const candidates = new Map<string, CandidateAccumulator>();
  const pagingState = new Map<
    string,
    { profile: SearchProfile; nextPageToken?: string; fetchedNextPages: number }
  >();

  const firstPages = await Promise.all(
    profiles.map(async (profile) => {
      try {
        const result = await searchNearbyPlacesProfilePage(context, profile);
        return { profile, result };
      } catch (error) {
        console.warn(
          `[Agent][Scout] profile=${profile.id} failed during first page`,
          error
        );
        return {
          profile,
          result: { status: "ZERO_RESULTS", results: [] } as PlacesSearchResult,
        };
      }
    })
  );

  for (const { profile, result } of firstPages) {
    for (const place of result.results || []) {
      upsertCandidate(candidates, toAgentShop(place), profile, context);
    }

    if (result.next_page_token) {
      pagingState.set(profile.id, {
        profile,
        nextPageToken: result.next_page_token,
        fetchedNextPages: 0,
      });
    }
  }

  while (candidates.size < MAX_CANDIDATES && pagingState.size > 0) {
    let progressed = false;

    for (const profile of profiles) {
      const state = pagingState.get(profile.id);
      if (!state || !state.nextPageToken) {
        continue;
      }

      if (state.fetchedNextPages >= MAX_PROFILE_NEXT_PAGES) {
        pagingState.delete(profile.id);
        continue;
      }

      try {
        const result = await searchNearbyPlacesProfilePage(
          context,
          profile,
          state.nextPageToken
        );

        for (const place of result.results || []) {
          upsertCandidate(candidates, toAgentShop(place), profile, context);
        }

        state.fetchedNextPages += 1;
        state.nextPageToken = result.next_page_token;
        progressed = true;

        if (!state.nextPageToken || state.fetchedNextPages >= MAX_PROFILE_NEXT_PAGES) {
          pagingState.delete(profile.id);
        }

        if (candidates.size >= MAX_CANDIDATES) {
          break;
        }
      } catch (error) {
        console.warn(
          `[Agent][Scout] profile=${profile.id} failed during pagination`,
          error
        );
        pagingState.delete(profile.id);
      }
    }

    if (!progressed) {
      break;
    }
  }

  return Array.from(candidates.values()).map((entry) => ({
    ...entry.shop,
    matchedProfileIds: Array.from(entry.matchedProfileIds),
    preferredMatch: entry.preferredMatch,
    keywordMatch: entry.keywordMatch,
  }));
}

export async function collectCandidateShops(
  lat: number,
  lng: number,
  radius: number = 500,
  keyword?: string
): Promise<RankedCandidate[]> {
  try {
    resolveMapsMode();
  } catch {
    throw new Error(getMapsConfigurationError());
  }

  const context = createSearchContext(lat, lng, radius, keyword);
  const profiles = buildAgentTeamProfiles(keyword);
  const seeds = await collectCandidateSeeds(context, profiles);

  return rankCandidateSeeds(seeds, context, false).slice(0, MAX_CANDIDATES);
}

async function prepareCandidatesForInvestigation(
  lat: number,
  lng: number,
  radius: number,
  keyword?: string
): Promise<RankedCandidate[]> {
  const context = createSearchContext(lat, lng, radius, keyword);
  const rankedCandidates = await collectCandidateShops(lat, lng, radius, keyword);
  const topCandidates = rankedCandidates.slice(0, MAX_DETAILS_SHOPS);

  if (topCandidates.length === 0) {
    return [];
  }

  const enriched = await enrichShopsWithPlaceDetails(topCandidates);
  const rankingMetadata = new Map(
    topCandidates.map((candidate) => [candidate.place_id, candidate] as const)
  );
  const enrichedSeeds: CandidateSeed[] = enriched.map((candidate) => {
    const rankedCandidate = rankingMetadata.get(candidate.place_id);

    return {
      name: candidate.name,
      address: candidate.address,
      place_id: candidate.place_id,
      website: candidate.website,
      lat: candidate.lat,
      lng: candidate.lng,
      rating: candidate.rating,
      types: candidate.types,
      matchedProfileIds: rankedCandidate?.matchedProfileIds ?? [],
      preferredMatch: rankedCandidate?.preferredMatch ?? false,
      keywordMatch: rankedCandidate?.keywordMatch ?? false,
    };
  });

  return rankCandidateSeeds(enrichedSeeds, context, true);
}

function getInvestigationCategory(shop: AgentShop): InvestigationCategory {
  if (isBeautySalonLike(shop)) return "beauty";
  if (isCinemaOrTicketedVenue(shop)) return "movie";
  if (isKaraokeOrAmusementShop(shop)) return "karaoke";
  if (isFoodOrCafeShop(shop)) return "food";
  if (isRetailOrStudyShop(shop)) {
    const types = shop.types ?? [];
    if (types.includes("book_store")) return "book";
    if (types.includes("clothing_store")) return "fashion";
    return "book";
  }
  if (isFitnessOrActivityShop(shop)) return "fitness";
  return "generic";
}

function buildEvidenceSearchQueries(shop: AgentShop, userKeyword?: string): string[] {
  const addressHint =
    typeof shop.address === "string" && shop.address.trim().length > 0
      ? ` ${shop.address.trim().slice(0, 40)}`
      : "";
  const host = getWebsiteHost(shop.website);
  const categoryTerms =
    CATEGORY_SPECIFIC_TERMS[getInvestigationCategory(shop)] ??
    CATEGORY_SPECIFIC_TERMS.generic;
  const genericTerms = GENERIC_STUDENT_EVIDENCE_KEYWORDS.slice(0, 6);
  const highPriorityTerms = Array.from(
    new Set([...categoryTerms, ...genericTerms])
  ).slice(0, 6);
  const optionalUserKeyword = userKeyword?.trim();
  const queries = [
    host
      ? `"${shop.name}" ${host} ${highPriorityTerms.slice(0, 3).join(" ")}`
      : null,
    `"${shop.name}"${addressHint} ${highPriorityTerms.join(" ")} ${
      optionalUserKeyword ?? ""
    }`.trim(),
    `"${shop.name}"${addressHint} 学割 学生割引 学生 ${
      optionalUserKeyword ?? ""
    }`.trim(),
    `"${shop.name}"${addressHint} ${categoryTerms.join(" ")} ${
      optionalUserKeyword ?? ""
    }`.trim(),
  ].filter((query): query is string => Boolean(query));

  return queries.filter((query, index, list) => list.indexOf(query) === index).slice(0, 3);
}

async function searxngSearchResults(query: string): Promise<SearXNGResult[]> {
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
        `[Agent][Retriever] web_search failed (${response.status}): query="${query}"`
      );
      return [];
    }

    const data = (await response.json()) as SearXNGResponse;
    return (data.results || []).slice(0, MAX_SEARCH_RESULTS_PER_QUERY);
  } catch (error) {
    console.error("[Agent][Retriever] web_search error:", error);
    return [];
  }
}

function formatEvidenceSnippets(snippets: EvidenceSnippet[]): string {
  if (snippets.length === 0) {
    return "No search results found.";
  }

  return snippets
    .slice(0, MAX_EVIDENCE_SNIPPETS)
    .map(
      (snippet, index) =>
        `[${index + 1}] Query: ${snippet.query}\nTitle: ${snippet.title}\nURL: ${
          snippet.url
        }\n${snippet.content || "(no summary)"}`
    )
    .join("\n\n");
}

async function collectEvidenceBundle(
  shop: AgentShop,
  userKeyword?: string
): Promise<EvidenceBundle> {
  const queries = buildEvidenceSearchQueries(shop, userKeyword);
  const queryResults = await Promise.all(
    queries.map(async (query) => ({
      query,
      results: await searxngSearchResults(query),
    }))
  );

  const snippets: EvidenceSnippet[] = [];
  const seenSnippetKeys = new Set<string>();
  const sourceUrls: string[] = [];

  for (const { query, results } of queryResults) {
    for (const result of results) {
      const snippetKey = `${result.url}::${result.title}`;
      if (seenSnippetKeys.has(snippetKey)) {
        continue;
      }

      seenSnippetKeys.add(snippetKey);
      snippets.push({
        ...result,
        query,
      });

      if (result.url && !sourceUrls.includes(result.url)) {
        sourceUrls.push(result.url);
      }
    }
  }

  return {
    shop,
    retriever: "Retriever",
    queries,
    snippets: snippets.slice(0, MAX_EVIDENCE_SNIPPETS),
    sourceUrls,
    summary: formatEvidenceSnippets(snippets),
  };
}

function buildVerifierMessage(
  shop: AgentShop,
  evidence: EvidenceBundle,
  userKeyword?: string
): string {
  const lines = [
    "Team role: Verifier",
    `Store: ${shop.name}`,
    `Address: ${shop.address || "unknown"}`,
    `Queries used: ${evidence.queries.join(" | ") || "(none)"}`,
  ];

  if (shop.website) {
    lines.push(`Website: ${shop.website}`);
  }

  if (userKeyword?.trim()) {
    lines.push(`User intent keyword: ${userKeyword.trim()}`);
  }

  lines.push("Evidence snippets:");
  lines.push(evidence.summary);
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

function buildReviewerMessage(
  shop: AgentShop,
  evidence: EvidenceBundle,
  current: AgentResultItem,
  userKeyword?: string
): string {
  const lines = [
    "Team role: Reviewer",
    `Store: ${shop.name}`,
    `Address: ${shop.address || "unknown"}`,
    `Previous verification: ${JSON.stringify({
      has_gakuwari: current.has_gakuwari,
      discount_info: current.discount_info,
      source_url: current.source_url,
      confidence: current.confidence,
    })}`,
    `Queries used: ${evidence.queries.join(" | ") || "(none)"}`,
  ];

  if (shop.website) {
    lines.push(`Website: ${shop.website}`);
  }

  if (userKeyword?.trim()) {
    lines.push(`User intent keyword: ${userKeyword.trim()}`);
  }

  lines.push("Evidence snippets:");
  lines.push(evidence.summary);
  lines.push(
    "Re-check this high-priority candidate. If evidence explicitly supports any student-oriented pricing or benefit, set has_gakuwari=true."
  );
  lines.push(
    "If evidence is still insufficient, keep has_gakuwari=false and use low or medium confidence."
  );
  lines.push("Return JSON only.");

  return lines.join("\n");
}

function normalizeResultWithEvidence(
  result: AgentResultItem,
  evidence: EvidenceBundle
): AgentResultItem {
  if (result.has_gakuwari && !result.source_url && evidence.sourceUrls.length > 0) {
    return {
      ...result,
      source_url: evidence.sourceUrls[0] ?? "",
    };
  }

  return result;
}

async function runVerifier(
  shop: AgentShop,
  evidence: EvidenceBundle,
  userKeyword?: string,
  llmProvider: LLMProviderMode = "gemini"
): Promise<AgentResultItem> {
  const content = await callLLMForAgent(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: buildVerifierMessage(shop, evidence, userKeyword),
      },
    ],
    llmProvider
  );

  return normalizeResultWithEvidence(parseAgentResult(shop, content), evidence);
}

async function runReviewer(
  shop: AgentShop,
  evidence: EvidenceBundle,
  current: AgentResultItem,
  userKeyword?: string,
  llmProvider: LLMProviderMode = "gemini"
): Promise<AgentResultItem> {
  const content = await callLLMForAgent(
    [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildReviewerMessage(shop, evidence, current, userKeyword),
      },
    ],
    llmProvider
  );

  return normalizeResultWithEvidence(parseAgentResult(shop, content), evidence);
}

function shouldReviewOutcome(outcome: InvestigationOutcome): boolean {
  return (
    !outcome.result.has_gakuwari &&
    outcome.result.confidence === "low" &&
    outcome.rank <= 4 &&
    outcome.evidence.snippets.length > 0
  );
}

function mergeReviewedResult(
  current: AgentResultItem,
  reviewed: AgentResultItem
): AgentResultItem {
  if (reviewed.has_gakuwari) {
    return reviewed;
  }

  if (confidenceToScore(reviewed.confidence) > confidenceToScore(current.confidence)) {
    return reviewed;
  }

  return current;
}

async function applyReviewerPass(
  outcomes: InvestigationOutcome[],
  userKeyword?: string,
  forcedPlaceIds: string[] = [],
  llmProvider: LLMProviderMode = "gemini"
): Promise<InvestigationOutcome[]> {
  const forcedSet = new Set(forcedPlaceIds);
  const targets = outcomes.filter(
    (outcome) =>
      !outcome.reviewed &&
      !outcome.result.has_gakuwari &&
      outcome.evidence.snippets.length > 0 &&
      (shouldReviewOutcome(outcome) || forcedSet.has(outcome.shop.place_id))
  );

  if (targets.length === 0) {
    return outcomes;
  }

  const reviewed = await Promise.all(
    targets.map(async (outcome) => {
      try {
        const reviewedResult = await runReviewer(
          outcome.shop,
          outcome.evidence,
          outcome.result,
          userKeyword,
          llmProvider
        );
        return {
          placeId: outcome.shop.place_id,
          result: mergeReviewedResult(outcome.result, reviewedResult),
        };
      } catch (error) {
        console.warn(
          `[Agent][Reviewer] Failed to review "${outcome.shop.name}"`,
          error
        );
        return {
          placeId: outcome.shop.place_id,
          result: outcome.result,
        };
      }
    })
  );

  const reviewedMap = new Map(reviewed.map((entry) => [entry.placeId, entry.result]));

  return outcomes.map((outcome) => {
    const reviewedResult = reviewedMap.get(outcome.shop.place_id);
    if (!reviewedResult) {
      return outcome;
    }

    cacheAgentResult(
      getAgentCacheKey(outcome.shop, buildAdaptiveEvidenceSearchQuery(outcome.shop, userKeyword)),
      reviewedResult
    );
    return {
      ...outcome,
      result: reviewedResult,
      reviewed: true,
      reviewerTriggered: true,
      reviewer: "Reviewer",
    };
  });
}

async function investigateRankedCandidate(
  candidate: RankedCandidate,
  userKeyword?: string,
  llmProvider: LLMProviderMode = "gemini"
): Promise<InvestigationOutcome> {
  const startedAt = performance.now();
  const cacheKey = getAgentCacheKey(
    candidate,
    buildAdaptiveEvidenceSearchQuery(candidate, userKeyword)
  );
  const cached = getCachedAgentResult(cacheKey, candidate);

  if (cached) {
    return {
      shop: candidate,
      rank: candidate.rank,
      verifier: "Verifier",
      reviewed: false,
      reviewerTriggered: false,
      evidence: {
        shop: candidate,
        retriever: "Retriever",
        queries: [],
        snippets: [],
        sourceUrls: cached.source_url ? [cached.source_url] : [],
        summary: "Cached student discount verification result.",
      },
      result: cached,
    };
  }

  try {
    const evidenceStartedAt = performance.now();
    const evidence = await collectEvidenceBundle(candidate, userKeyword);
    const evidenceMs = Math.round(performance.now() - evidenceStartedAt);
    const verifierStartedAt = performance.now();
    const result = await runVerifier(
      candidate,
      evidence,
      userKeyword,
      llmProvider
    );
    const verifierMs = Math.round(performance.now() - verifierStartedAt);
    cacheAgentResult(cacheKey, result);

    console.log(
      `[Agent][Verifier][${llmProvider}] Shop="${candidate.name}" rank=${candidate.rank} queries=${evidence.queries.length} snippets=${evidence.snippets.length} evidenceMs=${evidenceMs} verifierMs=${verifierMs} totalMs=${Math.round(
        performance.now() - startedAt
      )}`
    );

    return {
      shop: candidate,
      rank: candidate.rank,
      verifier: "Verifier",
      reviewed: false,
      reviewerTriggered: false,
      evidence,
      result,
    };
  } catch (error) {
    console.error(
      `[Agent][Verifier][${llmProvider}] Shop="${candidate.name}" failed:`,
      error
    );
    return {
      shop: candidate,
      rank: candidate.rank,
      verifier: "Verifier",
      reviewed: false,
      reviewerTriggered: false,
      evidence: {
        shop: candidate,
        retriever: "Retriever",
        queries: buildEvidenceSearchQueries(candidate, userKeyword),
        snippets: [],
        sourceUrls: [],
        summary: "Search failed before evidence could be collected.",
      },
      result: createDefaultResult(candidate),
    };
  }
}

async function investigateCandidates(
  candidates: RankedCandidate[],
  userKeyword?: string,
  llmProvider: LLMProviderMode = "gemini"
): Promise<InvestigationOutcome[]> {
  const outcomes: InvestigationOutcome[] = [];

  for (
    let index = 0;
    index < candidates.length;
    index += INVESTIGATION_BATCH_SIZE
  ) {
    const batch = candidates.slice(index, index + INVESTIGATION_BATCH_SIZE);
    const batchOutcomes = await Promise.all(
      batch.map((candidate) =>
        investigateRankedCandidate(candidate, userKeyword, llmProvider)
      )
    );
    outcomes.push(...batchOutcomes);
  }

  return outcomes;
}

function sortInvestigationOutcomes(
  outcomes: InvestigationOutcome[]
): InvestigationOutcome[] {
  return [...outcomes].sort((left, right) => {
    if (left.result.has_gakuwari !== right.result.has_gakuwari) {
      return left.result.has_gakuwari ? -1 : 1;
    }

    const confidenceDiff =
      confidenceToScore(right.result.confidence) -
      confidenceToScore(left.result.confidence);
    if (confidenceDiff !== 0) {
      return confidenceDiff;
    }

    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }

    return left.shop.distanceMeters - right.shop.distanceMeters;
  });
}

function toGakuwariSearchResult(
  shop: RankedCandidate,
  result: AgentResultItem
): GakuwariSearchResult {
  return {
    place_id: shop.place_id,
    name: result.name || shop.name,
    address: shop.address,
    lat: shop.lat,
    lng: shop.lng,
    rating: shop.rating,
    website: shop.website,
    types: shop.types,
    has_gakuwari: result.has_gakuwari,
    discount_info: result.discount_info,
    source_url: result.source_url,
    confidence: result.confidence,
  };
}

async function enrichShopsWithPlaceDetails(
  shops: AgentShop[]
): Promise<AgentShop[]> {
  if (shops.length === 0) {
    return shops;
  }

  const enrichedShops = await Promise.all(
    shops.map(async (shop) => {
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
  const rankedCandidates = await prepareCandidatesForInvestigation(
    lat,
    lng,
    radius,
    keyword
  );

  if (rankedCandidates.length === 0) {
    console.log("[Agent][Scout] No candidate shops found within the radius");
    return [];
  }

  console.log(
    `[Agent][Scout][${llmProvider}] Prepared ${rankedCandidates.length} ranked candidates within radius=${radius}`
  );

  const waveOneCandidates = rankedCandidates.slice(0, WAVE_ONE_SIZE);
  let outcomes = await investigateCandidates(
    waveOneCandidates,
    keyword,
    llmProvider
  );
  outcomes = await applyReviewerPass(outcomes, keyword, [], llmProvider);

  if (!outcomes.some((outcome) => outcome.result.has_gakuwari)) {
    const forcedReviewerIds = outcomes
      .slice(0, 3)
      .map((outcome) => outcome.shop.place_id);
    outcomes = await applyReviewerPass(
      outcomes,
      keyword,
      forcedReviewerIds,
      llmProvider
    );
  }

  if (outcomes.some((outcome) => outcome.result.has_gakuwari)) {
    const additionalCandidates = rankedCandidates.slice(
      WAVE_ONE_SIZE,
      Math.min(MAX_INVESTIGATED_AFTER_HIT, rankedCandidates.length)
    );

    if (additionalCandidates.length > 0) {
      const extraOutcomes = await investigateCandidates(
        additionalCandidates,
        keyword,
        llmProvider
      );
      outcomes = outcomes.concat(
        await applyReviewerPass(extraOutcomes, keyword, [], llmProvider)
      );
    }
  } else {
    const waveTwoCandidates = rankedCandidates.slice(
      WAVE_ONE_SIZE,
      WAVE_ONE_SIZE + WAVE_TWO_SIZE
    );

    if (waveTwoCandidates.length > 0) {
      const waveTwoOutcomes = await investigateCandidates(
        waveTwoCandidates,
        keyword,
        llmProvider
      );
      outcomes = outcomes.concat(
        await applyReviewerPass(waveTwoOutcomes, keyword, [], llmProvider)
      );
    }
  }

  const sortedOutcomes = sortInvestigationOutcomes(outcomes);

  console.log(
    `[Agent][Timing][${llmProvider}] searchGakuwariSpots candidates=${rankedCandidates.length} investigated=${sortedOutcomes.length} totalMs=${Math.round(
      performance.now() - startedAt
    )}`
  );

  return sortedOutcomes.map((outcome) =>
    toGakuwariSearchResult(outcome.shop, outcome.result)
  );
}

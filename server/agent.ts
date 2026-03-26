import {
  makeRequest,
  type PlaceDetailsResult,
  type PlacesSearchResult,
} from "./_core/map";
import {
  categorizeShop,
  getDefaultSpecialtyProfiles,
  selectCategorySearchProfiles,
  type CategoryBudgetPolicy,
  type PreparedSearchProfile,
  type ShopCategoryMatch,
  type StudentDiscountCategoryId,
} from "./_core/studentDiscountCategoryCatalog";
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

interface BraveSearchResult {
  title: string;
  url: string;
  content: string;
}

interface BraveSearchApiResult {
  title?: string;
  url?: string;
  description?: string;
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchApiResult[];
  };
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
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
  matchedCategoryIds: StudentDiscountCategoryId[];
  matchedAliases: string[];
  apiBoostEnabled: boolean;
  budgetPolicy: Record<string, CategoryBudgetPolicy>;
  broadOnlyReason?: string;
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

interface EvidenceSnippet extends BraveSearchResult {
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

type StepProvider = "nearby" | "details" | "brave" | "gemini";

type StepStage =
  | "candidate_search"
  | "pagination"
  | "details"
  | "retriever"
  | "verifier"
  | "reviewer";

type CandidateHaltStage = "details" | "retriever" | "verifier";

type CandidateHaltReason =
  | "details_unusable_context"
  | "brave_request_failed"
  | "brave_no_evidence"
  | "gemini_failed";

interface ProviderFailure {
  provider: StepProvider;
  stage: StepStage;
  reason: string;
  message: string;
  httpStatus?: number;
  providerStatus?: string;
  query?: string;
  retryable: boolean;
  attempt?: number;
  bodyPreview?: string;
}

interface StepDiagnostics {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

interface SearchRunDiagnostics {
  profiles: string[];
  matchedCategoryIds: StudentDiscountCategoryId[];
  matchedAliases: string[];
  apiBoostEnabled: boolean;
  budgetPolicy: Record<string, CategoryBudgetPolicy>;
  broadOnlyReason?: string;
  candidatesPrepared: number;
  candidatesInvestigated: number;
  candidatesHalted: number;
  nearby: StepDiagnostics;
  details: StepDiagnostics;
  brave: StepDiagnostics;
  gemini: StepDiagnostics;
}

interface InvestigationCandidate extends RankedCandidate {
  providerFailures: ProviderFailure[];
  haltedAt?: CandidateHaltStage;
  haltReason?: CandidateHaltReason;
}

interface InvestigationOutcome {
  shop: InvestigationCandidate;
  evidence: EvidenceBundle;
  result: AgentResultItem;
  rank: number;
  reviewed: boolean;
  reviewerTriggered: boolean;
  verifierCompleted: boolean;
  haltedAt?: CandidateHaltStage;
  haltReason?: CandidateHaltReason;
  providerFailures: ProviderFailure[];
  verifier: "Verifier";
  reviewer?: "Reviewer";
}

const DEFAULT_BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
const DEFAULT_GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const SEARCH_STRATEGY_VERSION = "agent-team-v2";
const MAX_SHOPS = 20;
const BATCH_SIZE = 6;
const MAX_CANDIDATES = 60;
const MAX_DETAILS_SHOPS = 12;
const MAX_SPECIALTY_PROFILES_WITHOUT_KEYWORD = 2;
const MAX_PREFERRED_SPECIALTY_PROFILES = 2;
const MAX_BROAD_NEXT_PAGES = 1;
const MAX_SEARCH_RESULTS_PER_QUERY = 4;
const MAX_EVIDENCE_SNIPPETS = 6;
const MAX_EVIDENCE_QUERIES = 2;
const WAVE_ONE_SIZE = 8;
const WAVE_TWO_SIZE = 8;
const MAX_INVESTIGATED_AFTER_HIT = 12;
const INVESTIGATION_BATCH_SIZE = 4;
const MAX_REVIEW_TARGETS = 2;
const AGENT_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const CANDIDATE_CACHE_TTL_MS = 1000 * 60 * 10;
const PLACE_DETAILS_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const BRAVE_MAX_ATTEMPTS = 2;
const BRAVE_MAX_FAILURE_BODY_CHARS = 300;
const PAGINATION_RETRY_DELAYS_MS = [2_000, 3_000, 4_000] as const;
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
  "あなたは学割・学生向け特典を調査するエージェントです。",
  "提供された店舗情報とエビデンスのみを使用してください。エビデンスにない割引を作らないでください。",
  "学生カット、学割U24、U24、学生限定クーポン、高校生料金、大学生料金はすべて有効な学割として扱ってください。",
  "学生料金、学生価格、学生プラン、学生証提示、学生限定、学生フリータイム、学生パック、学生チケット、学生入場料、専門学生料金なども有効です。",
  "学割が確認できた場合は、discount_infoに以下を含めてください:",
  "  - 割引の具体的な内容（例：学生証提示で入場料20%引き、学生フリータイム3時間550円、ライス無料サービスなど）",
  "  - 割引率・割引額・無料サービスがわかる場合はその数値",
  "  - 条件（学生証提示、アプリ提示、平日限定など）",
  "  - discount_infoは日本語で記述すること。",
  "Return a JSON object only with these keys:",
  '{"has_gakuwari":true,"discount_info":"日本語で割引の具体的内容","source_url":"string","confidence":"high|medium|low"}',
  "discount_infoが不明な場合のみ空文字列を使用する。source_urlが不明な場合は空文字列。",
  "confidenceはエビデンスで明示的に確認できた場合のみhigh。",
  "エビデンスが曖昧・断片的・間接的な場合はconfidence=low。",
  "エビデンスが学割なしと明示している場合のみhas_gakuwari=falseかつconfidence=mediumまたはhigh。",
].join("\n");

const DEFAULT_PARSED_RESULT: ParsedAgentResult = {
  has_gakuwari: false,
  discount_info: "",
  source_url: "",
  confidence: "low",
};

const REVIEW_SYSTEM_PROMPT = [
  "あなたは学割調査チームのレビュワーです。",
  "以前の判定が否定的または低確信度だった高優先店舗を再確認してください。",
  "提供されたエビデンスのみを使用してください。",
  "学生カット、学割U24、U24、学生限定クーポン、高校生料金、大学生料金はすべて有効な学割として扱ってください。",
  "学割が確認できた場合は、discount_infoに割引の具体的な内容を日本語で記述してください。",
  "  例：「学生証提示でフリータイム料金550円（通常880円）」「ライス無料サービス（学生証提示）」「入場料20%引き」",
  "エビデンスが依然として学割を明示的に支持していない場合はhas_gakuwari=falseを返してください。",
  "Return a JSON object only with these keys:",
  '{"has_gakuwari":true,"discount_info":"日本語で割引の具体的内容","source_url":"string","confidence":"high|medium|low"}',
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
const candidateSearchCache = new Map<
  string,
  {
    expiresAt: number;
    candidates: RankedCandidate[];
  }
>();
const placeDetailsCache = new Map<
  string,
  {
    expiresAt: number;
    address: string;
    website?: string;
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

function getBraveSearchApiUrl(): string {
  return process.env.BRAVE_SEARCH_API_URL?.trim() || DEFAULT_BRAVE_SEARCH_API_URL;
}

function getBraveSearchApiKey(): string {
  return (
    process.env.BRAVE_SEARCH_API_KEY?.trim() ||
    process.env.BRAVE_API_KEY?.trim() ||
    ""
  );
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

function createStepDiagnostics(): StepDiagnostics {
  return {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
}

function createSearchRunDiagnostics(): SearchRunDiagnostics {
  return {
    profiles: [],
    matchedCategoryIds: [],
    matchedAliases: [],
    apiBoostEnabled: false,
    budgetPolicy: {},
    candidatesPrepared: 0,
    candidatesInvestigated: 0,
    candidatesHalted: 0,
    nearby: createStepDiagnostics(),
    details: createStepDiagnostics(),
    brave: createStepDiagnostics(),
    gemini: createStepDiagnostics(),
  };
}

function getStepDiagnostics(
  diagnostics: SearchRunDiagnostics,
  provider: StepProvider
): StepDiagnostics {
  return diagnostics[provider];
}

function logAgentEvent(
  level: "log" | "warn" | "error",
  event: Record<string, unknown>
): void {
  const line = `[Agent][Diag] ${JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
  })}`;
  if (level === "warn") {
    console.warn(line);
    return;
  }
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

function logApiEvent(
  level: "log" | "warn" | "error",
  event: {
    stage: StepStage;
    provider: StepProvider;
    action: "abort_candidate" | "abort_profile" | "retry" | "continue";
    shop?: string;
    placeId?: string;
    profileId?: string;
    query?: string;
    httpStatus?: number;
    providerStatus?: string;
    attempt?: number;
    durationMs?: number;
    retryable?: boolean;
    bodyPreview?: string;
    message?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  }
): void {
  logAgentEvent(level, {
    event: "api_call",
    ...event,
  });
}

function logCandidateHalt(
  shop: Pick<AgentShop, "name" | "place_id">,
  haltedAt: CandidateHaltStage,
  haltReason: CandidateHaltReason,
  skipped: string[],
  providerFailures: ProviderFailure[]
): void {
  logAgentEvent("warn", {
    event: "candidate_halt",
    shop: shop.name,
    placeId: shop.place_id,
    haltedAt,
    haltReason,
    skipped,
    providerFailures,
  });
}

function isUsableAddress(address?: string): boolean {
  return typeof address === "string" && address.trim().length > 0;
}

function shouldLookupPlaceDetails(shop: AgentShop): boolean {
  return !shop.website || !isUsableAddress(shop.address);
}

function hasUsableInvestigationContext(shop: AgentShop): boolean {
  return isUsableAddress(shop.address) || Boolean(shop.website?.trim());
}

function createEmptyEvidenceBundle(
  shop: AgentShop,
  queries: string[],
  summary: string
): EvidenceBundle {
  return {
    shop,
    retriever: "Retriever",
    queries,
    snippets: [],
    sourceUrls: [],
    summary,
  };
}

function createInvestigationCandidate(candidate: RankedCandidate): InvestigationCandidate {
  return {
    ...candidate,
    matchedProfileIds: [...candidate.matchedProfileIds],
    types: candidate.types ? [...candidate.types] : undefined,
    providerFailures: [],
  };
}

function appendProviderFailure<T extends AgentShop>(
  shop: T,
  failure: ProviderFailure
): T {
  if (!("providerFailures" in shop)) {
    return shop;
  }

  const candidate = shop as T & InvestigationCandidate;
  return {
    ...candidate,
    providerFailures: [...candidate.providerFailures, failure],
  } as T;
}

function haltPreparedCandidate<T extends AgentShop>(
  shop: T,
  haltReason: CandidateHaltReason,
  failure: ProviderFailure
): T {
  if (!("providerFailures" in shop)) {
    return shop;
  }

  const candidate = shop as T & InvestigationCandidate;
  return {
    ...candidate,
    providerFailures: [...candidate.providerFailures, failure],
    haltedAt: "details",
    haltReason,
  } as T;
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

type AgentLLMInvocation = {
  content: string;
  usage?: GeminiChatCompletionResponse["usage"];
};

async function callLLMForAgentDetailed(
  messages: AgentMessage[],
  provider: LLMProviderMode = "gemini"
): Promise<AgentLLMInvocation> {
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

    return {
      content:
        typeof raw === "string"
          ? raw
          : raw.map((chunk) => (chunk.type === "text" ? chunk.text : "")).join(""),
    };
  }

  const result = await callGeminiChatCompletion(messages);
  const content = result.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Gemini returned no message");
  }

  return {
    content,
    usage: result.usage,
  };
}

async function callLLMForAgent(
  messages: AgentMessage[],
  provider: LLMProviderMode = "gemini"
): Promise<string> {
  return (await callLLMForAgentDetailed(messages, provider)).content;
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

function normalizeBraveSearchResults(
  response: BraveSearchResponse
): BraveSearchResult[] {
  return (response.web?.results || [])
    .map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      content: [result.description ?? "", ...(result.extra_snippets ?? [])]
        .filter(Boolean)
        .join("\n"),
    }))
    .filter((result) => Boolean(result.title || result.url || result.content));
}

type BraveRequestSuccess = {
  ok: true;
  status: number;
  durationMs: number;
  results: BraveSearchResult[];
};

type BraveRequestFailure = {
  ok: false;
  status?: number;
  durationMs: number;
  retryable: boolean;
  message: string;
  bodyPreview?: string;
};

type BraveRequestResult = BraveRequestSuccess | BraveRequestFailure;

function buildBraveSearchParams(query: string, count: number): URLSearchParams {
  return new URLSearchParams({
    q: query,
    count: String(count),
    country: "JP",
    extra_snippets: "true",
  });
}

function isRetryableBraveStatus(status?: number): boolean {
  return status === 429 || Boolean(status && status >= 500 && status < 600);
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      /timed? out/i.test(error.message))
  );
}

async function executeBraveSearchRequest(
  query: string,
  count: number
): Promise<BraveRequestResult> {
  const apiKey = getBraveSearchApiKey();
  if (!apiKey) {
    return {
      ok: false,
      durationMs: 0,
      retryable: false,
      message: "BRAVE_SEARCH_API_KEY or BRAVE_API_KEY is not configured",
    };
  }

  const startedAt = performance.now();

  try {
    const response = await fetch(
      `${getBraveSearchApiUrl()}?${buildBraveSearchParams(query, count).toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(15_000),
      }
    );

    const rawBody = await response.text();
    const durationMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        durationMs,
        retryable: isRetryableBraveStatus(response.status),
        message: `Brave Search request failed (${response.status})`,
        bodyPreview: rawBody.slice(0, BRAVE_MAX_FAILURE_BODY_CHARS),
      };
    }

    try {
      const data = JSON.parse(rawBody) as BraveSearchResponse;
      return {
        ok: true,
        status: response.status,
        durationMs,
        results: normalizeBraveSearchResults(data).slice(0, count),
      };
    } catch (error) {
      return {
        ok: false,
        status: response.status,
        durationMs,
        retryable: false,
        message:
          error instanceof Error ? error.message : "Failed to parse Brave response",
        bodyPreview: rawBody.slice(0, BRAVE_MAX_FAILURE_BODY_CHARS),
      };
    }
  } catch (error) {
    return {
      ok: false,
      durationMs: Math.round(performance.now() - startedAt),
      retryable: isTimeoutError(error),
      message: error instanceof Error ? error.message : "unknown error",
    };
  }
}

async function braveSearch(query: string): Promise<string> {
  const response = await executeBraveSearchRequest(query, 5);
  if (!response.ok) {
    console.warn(
      `[Agent][Tool] web_search failed (${response.status ?? "no-status"}): query="${query}"`
    );
    return `Search error: ${response.message}`;
  }

  if (response.results.length === 0) {
    return "No search results found.";
  }

  return response.results
    .slice(0, 5)
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title}\nURL: ${result.url}\n${
          result.content || "(no summary)"
        }`
    )
    .join("\n\n");
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

function cloneRankedCandidate(candidate: RankedCandidate): RankedCandidate {
  return {
    ...candidate,
    matchedProfileIds: [...candidate.matchedProfileIds],
    types: candidate.types ? [...candidate.types] : undefined,
  };
}

function getCandidateSearchCacheKey(context: SearchContext): string {
  return [
    context.lat.toFixed(5),
    context.lng.toFixed(5),
    String(context.radius),
    context.normalizedKeyword,
  ].join("::");
}

function getCachedCandidateSearch(cacheKey: string): RankedCandidate[] | null {
  const cached = candidateSearchCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    candidateSearchCache.delete(cacheKey);
    return null;
  }

  return cached.candidates.map(cloneRankedCandidate);
}

function cacheCandidateSearch(
  cacheKey: string,
  candidates: RankedCandidate[]
): void {
  candidateSearchCache.set(cacheKey, {
    expiresAt: Date.now() + CANDIDATE_CACHE_TTL_MS,
    candidates: candidates.map(cloneRankedCandidate),
  });
}

function getCachedPlaceDetails(
  placeId: string
): { address: string; website?: string } | null {
  const cached = placeDetailsCache.get(placeId);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    placeDetailsCache.delete(placeId);
    return null;
  }

  return {
    address: cached.address,
    website: cached.website,
  };
}

function cachePlaceDetails(
  placeId: string,
  details: { address: string; website?: string }
): void {
  placeDetailsCache.set(placeId, {
    expiresAt: Date.now() + PLACE_DETAILS_CACHE_TTL_MS,
    address: details.address,
    website: details.website,
  });
}

export function resetAgentCaches(): void {
  agentResultCache.clear();
  candidateSearchCache.clear();
  placeDetailsCache.clear();
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

  lines.push("エビデンス:");
  lines.push(evidence);
  lines.push("この店舗に学割・学生向け特典があるか調査してください。");
  lines.push(
    "学割が確認できた場合、discount_infoに割引の具体的な内容を日本語で記述してください。"
  );
  lines.push(
    "例：「学生証提示でフリータイム550円」「ライス無料サービス」「入場料20%引き」「学生プラン月額980円」など。"
  );
  lines.push(
    "割引率・割引額・無料特典・条件（平日限定、アプリ提示など）がわかる場合は含めてください。"
  );
  lines.push(
    "エビデンスが学割を明示的に支持しない場合はhas_gakuwari=false、confidence=lowを返してください。"
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

function getShopCategoryMatches(shop: AgentShop): ShopCategoryMatch[] {
  return categorizeShop({
    name: shop.name,
    address: shop.address,
    types: shop.types,
  });
}

function hasCategoryMatch(
  shop: AgentShop,
  ...categoryIds: StudentDiscountCategoryId[]
): boolean {
  const matches = getShopCategoryMatches(shop);
  return categoryIds.some((categoryId) =>
    matches.some((match) => match.category.id === categoryId)
  );
}

function getPrimaryCategoryMatch(shop: AgentShop): ShopCategoryMatch | undefined {
  return getShopCategoryMatches(shop)[0];
}

function getCategoryPromptExamples(shop: AgentShop): string[] {
  return getPrimaryCategoryMatch(shop)?.category.promptExamples ?? [];
}

function isBeautySalonLike(shop: AgentShop): boolean {
  return hasCategoryMatch(shop, "hair_care", "beauty_services");
}

function isKaraokeOrAmusementShop(shop: AgentShop): boolean {
  return hasCategoryMatch(shop, "karaoke_amusement");
}

function isCinemaOrTicketedVenue(shop: AgentShop): boolean {
  return hasCategoryMatch(shop, "movie_theater", "ticketed_venue");
}

function isFitnessOrActivityShop(shop: AgentShop): boolean {
  return hasCategoryMatch(shop, "fitness");
}

function isFoodOrCafeShop(shop: AgentShop): boolean {
  return hasCategoryMatch(shop, "food_drink");
}

function isRetailOrStudyShop(shop: AgentShop): boolean {
  return hasCategoryMatch(shop, "study_retail", "study_space", "fashion");
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

  lines.push("エビデンス:");
  lines.push(evidence);
  lines.push("この店舗に学割・学生向け特典があるか調査してください。");
  lines.push(
    "学割が確認できた場合、discount_infoに割引の具体的な内容を日本語で記述してください。"
  );
  lines.push(
    "例：「学生証提示でフリータイム550円（通常880円）」「ライス無料サービス（学生証提示）」「入場料20%引き」「学生カット3,300円」など。"
  );
  lines.push(
    "割引率・割引額・無料特典・条件（平日限定、アプリ提示など）がわかる場合は含めてください。"
  );
  lines.push(
    "エビデンスが曖昧または不足している場合はhas_gakuwari=false、confidence=lowを返してください。"
  );
  lines.push(
    "高優先候補の再確認です。エビデンスが学生向け料金・特典を明示的に支持する場合はhas_gakuwari=trueにしてください。"
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
    const evidence = await braveSearch(searchQuery);
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

function toSearchProfile(
  profile: PreparedSearchProfile,
  keyword?: string
): SearchProfile {
  return {
    id: profile.id,
    label: profile.label,
    priority: 220 + profile.bias,
    scout: "Scout/Ranker",
    type: profile.type,
    keyword: keyword?.trim() || profile.defaultKeyword,
  };
}

function createSearchContext(
  lat: number,
  lng: number,
  radius: number,
  keyword?: string
): SearchContext {
  const normalizedKeyword = normalizeSearchKeyword(keyword);
  const selection = selectCategorySearchProfiles(keyword);
  return {
    lat,
    lng,
    radius,
    keyword: keyword?.trim() || undefined,
    normalizedKeyword,
    preferredProfileIds: new Set(selection.preferredProfileIds),
    matchedCategoryIds: selection.matchedCategoryIds,
    matchedAliases: selection.matchedAliases,
    apiBoostEnabled: selection.apiBoostEnabled,
    budgetPolicy: selection.budgetPolicy,
    broadOnlyReason: selection.broadOnlyReason,
  };
}

export function buildAgentTeamProfiles(keyword?: string): SearchProfile[] {
  const normalizedKeyword = normalizeSearchKeyword(keyword);
  const selection = selectCategorySearchProfiles(keyword);
  const preferredProfileIds = new Set(selection.preferredProfileIds);

  const profiles: SearchProfile[] = [
    {
      id: "broad",
      label: "Broad Nearby",
      priority: normalizedKeyword ? 500 : 420,
      scout: "Scout/Ranker",
      keyword: keyword?.trim() || undefined,
    },
  ];

  const [broadProfile] = profiles;

  if (!broadProfile) {
    return [];
  }

  if (preferredProfileIds.size > 0) {
    return [
      broadProfile,
      ...selection.matchedProfiles
        .map((profile) => ({
          ...toSearchProfile(profile, keyword),
          priority: 380 + profile.bias,
        }))
        .slice(0, MAX_PREFERRED_SPECIALTY_PROFILES),
    ];
  }

  if (normalizedKeyword) {
    return [broadProfile];
  }

  return [
    broadProfile,
    ...getDefaultSpecialtyProfiles()
      .map((profile) => toSearchProfile(profile, keyword))
      .slice(0, MAX_SPECIALTY_PROFILES_WITHOUT_KEYWORD),
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getNextPageDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === "test") {
    return 0;
  }
  return PAGINATION_RETRY_DELAYS_MS[Math.max(0, attempt - 1)] ?? 4_000;
}

function getMaxNextPagesForProfile(profile: SearchProfile): number {
  return profile.id === "broad" ? MAX_BROAD_NEXT_PAGES : 0;
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
  return getPrimaryCategoryMatch(shop)?.category.candidateBias ?? 0;
}

function getStudentSignalScore(shop: AgentShop): number {
  if (matchesAnyPattern(getShopSearchText(shop), STUDENT_POSITIVE_PATTERNS)) {
    return 12;
  }

  return getPrimaryCategoryMatch(shop)?.category.studentSignalScore ?? 0;
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
  nextPageToken?: string,
  paginationAttempt: number = 1
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
    await delay(getNextPageDelayMs(paginationAttempt));
  }

  return makeRequest<PlacesSearchResult>("/maps/api/place/nearbysearch/json", params);
}

async function searchNearbyPlacesPaginationWithRetry(
  context: SearchContext,
  profile: SearchProfile,
  nextPageToken: string,
  diagnostics?: SearchRunDiagnostics
): Promise<PlacesSearchResult> {
  for (let attempt = 1; attempt <= PAGINATION_RETRY_DELAYS_MS.length; attempt += 1) {
    const nearbyDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "nearby") : null;
    nearbyDiagnostics && (nearbyDiagnostics.attempted += 1);
    const startedAt = performance.now();

    try {
      const result = await searchNearbyPlacesProfilePage(
        context,
        profile,
        nextPageToken,
        attempt
      );

      if (result.status === "OK" || result.status === "ZERO_RESULTS") {
        nearbyDiagnostics && (nearbyDiagnostics.succeeded += 1);
        logApiEvent("log", {
          stage: "pagination",
          provider: "nearby",
          action: "continue",
          profileId: profile.id,
          providerStatus: result.status,
          attempt,
          durationMs: Math.round(performance.now() - startedAt),
          retryable: false,
        });
        return result;
      }

      nearbyDiagnostics && (nearbyDiagnostics.failed += 1);
      const retryable =
        result.status === "INVALID_REQUEST" && attempt < PAGINATION_RETRY_DELAYS_MS.length;
      logApiEvent(retryable ? "warn" : "error", {
        stage: "pagination",
        provider: "nearby",
        action: retryable ? "retry" : "abort_profile",
        profileId: profile.id,
        providerStatus: result.status,
        attempt,
        durationMs: Math.round(performance.now() - startedAt),
        retryable,
        message: `Places API error: ${result.status}`,
      });
      if (retryable) {
        continue;
      }
      return { status: "ZERO_RESULTS", results: [] } as PlacesSearchResult;
    } catch (error) {
      nearbyDiagnostics && (nearbyDiagnostics.failed += 1);
      logApiEvent("error", {
        stage: "pagination",
        provider: "nearby",
        action: "abort_profile",
        profileId: profile.id,
        attempt,
        durationMs: Math.round(performance.now() - startedAt),
        retryable: false,
        message: error instanceof Error ? error.message : "Unknown nearby pagination error",
      });
      return { status: "ZERO_RESULTS", results: [] } as PlacesSearchResult;
    }
  }

  return { status: "ZERO_RESULTS", results: [] } as PlacesSearchResult;
}

async function collectCandidateSeeds(
  context: SearchContext,
  profiles: SearchProfile[],
  diagnostics?: SearchRunDiagnostics
): Promise<CandidateSeed[]> {
  const candidates = new Map<string, CandidateAccumulator>();
  const pagingState = new Map<
    string,
    { profile: SearchProfile; nextPageToken?: string; fetchedNextPages: number }
  >();

  const firstPages = await Promise.all(
    profiles.map(async (profile) => {
      const nearbyDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "nearby") : null;
      nearbyDiagnostics && (nearbyDiagnostics.attempted += 1);
      const startedAt = performance.now();
      try {
        const result = await searchNearbyPlacesProfilePage(context, profile);
        if (result.status !== "OK" && result.status !== "ZERO_RESULTS") {
          nearbyDiagnostics && (nearbyDiagnostics.failed += 1);
          logApiEvent("error", {
            stage: "candidate_search",
            provider: "nearby",
            action: "abort_profile",
            profileId: profile.id,
            providerStatus: result.status,
            durationMs: Math.round(performance.now() - startedAt),
            retryable: false,
            message: `Places API error: ${result.status}`,
          });
          return {
            profile,
            result: { status: "ZERO_RESULTS", results: [] } as PlacesSearchResult,
          };
        }
        nearbyDiagnostics && (nearbyDiagnostics.succeeded += 1);
        logApiEvent("log", {
          stage: "candidate_search",
          provider: "nearby",
          action: "continue",
          profileId: profile.id,
          providerStatus: result.status,
          durationMs: Math.round(performance.now() - startedAt),
          retryable: false,
        });
        return { profile, result };
      } catch (error) {
        nearbyDiagnostics && (nearbyDiagnostics.failed += 1);
        logApiEvent("error", {
          stage: "candidate_search",
          provider: "nearby",
          action: "abort_profile",
          profileId: profile.id,
          durationMs: Math.round(performance.now() - startedAt),
          retryable: false,
          message: error instanceof Error ? error.message : "Unknown nearby search error",
        });
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

    if (result.next_page_token && getMaxNextPagesForProfile(profile) > 0) {
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

      if (state.fetchedNextPages >= getMaxNextPagesForProfile(profile)) {
        pagingState.delete(profile.id);
        continue;
      }

      try {
        const result = await searchNearbyPlacesPaginationWithRetry(
          context,
          profile,
          state.nextPageToken,
          diagnostics
        );

        for (const place of result.results || []) {
          upsertCandidate(candidates, toAgentShop(place), profile, context);
        }

        state.fetchedNextPages += 1;
        state.nextPageToken = result.next_page_token;
        progressed = true;

        if (
          !state.nextPageToken ||
          state.fetchedNextPages >= getMaxNextPagesForProfile(profile)
        ) {
          pagingState.delete(profile.id);
        }

        if (candidates.size >= MAX_CANDIDATES) {
          break;
        }
      } catch (error) {
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
  keyword?: string,
  diagnostics?: SearchRunDiagnostics
): Promise<RankedCandidate[]> {
  try {
    resolveMapsMode();
  } catch {
    throw new Error(getMapsConfigurationError());
  }

  const context = createSearchContext(lat, lng, radius, keyword);
  const cacheKey = getCandidateSearchCacheKey(context);
  const profiles = buildAgentTeamProfiles(keyword);
  if (diagnostics) {
    diagnostics.profiles = profiles.map((profile) => profile.id);
    diagnostics.matchedCategoryIds = [...context.matchedCategoryIds];
    diagnostics.matchedAliases = [...context.matchedAliases];
    diagnostics.apiBoostEnabled = context.apiBoostEnabled;
    diagnostics.budgetPolicy = { ...context.budgetPolicy };
    diagnostics.broadOnlyReason = context.broadOnlyReason;
  }
  const cached = getCachedCandidateSearch(cacheKey);
  if (cached) {
    return cached;
  }

  const seeds = await collectCandidateSeeds(context, profiles, diagnostics);
  const rankedCandidates = rankCandidateSeeds(seeds, context, false).slice(
    0,
    MAX_CANDIDATES
  );
  cacheCandidateSearch(cacheKey, rankedCandidates);
  return rankedCandidates;
}

async function prepareCandidatesForInvestigation(
  lat: number,
  lng: number,
  radius: number,
  keyword?: string,
  diagnostics?: SearchRunDiagnostics
): Promise<InvestigationCandidate[]> {
  const context = createSearchContext(lat, lng, radius, keyword);
  const rankedCandidates = await collectCandidateShops(
    lat,
    lng,
    radius,
    keyword,
    diagnostics
  );
  const topCandidates = rankedCandidates.slice(0, MAX_DETAILS_SHOPS);

  if (topCandidates.length === 0) {
    return [];
  }

  const preparedCandidates = topCandidates.map((candidate) =>
    createInvestigationCandidate(candidate)
  );
  const enriched = await enrichShopsWithPlaceDetails(preparedCandidates, diagnostics);
  const reranked = rankCandidateSeeds(enriched, context, true);
  const rerankedMap = new Map(reranked.map((candidate) => [candidate.place_id, candidate] as const));

  return enriched
    .map((candidate) => {
      const rerankedCandidate = rerankedMap.get(candidate.place_id);
      return {
        ...candidate,
        rank: rerankedCandidate?.rank ?? candidate.rank,
        scoutScore: rerankedCandidate?.scoutScore ?? candidate.scoutScore,
        distanceMeters: rerankedCandidate?.distanceMeters ?? candidate.distanceMeters,
        providerFailures: [...candidate.providerFailures],
        types: candidate.types ? [...candidate.types] : undefined,
        matchedProfileIds: [...candidate.matchedProfileIds],
      };
    })
    .sort((left, right) => left.rank - right.rank);
}

function getInvestigationCategory(
  shop: AgentShop
): StudentDiscountCategoryId | "generic" {
  return getPrimaryCategoryMatch(shop)?.category.id ?? "generic";
}

export function buildEvidenceSearchQueries(
  shop: AgentShop,
  userKeyword?: string
): string[] {
  const addressHint =
    typeof shop.address === "string" && shop.address.trim().length > 0
      ? ` ${shop.address.trim().slice(0, 40)}`
      : "";
  const host = getWebsiteHost(shop.website);
  const categoryMatch = getPrimaryCategoryMatch(shop);
  const categoryTerms = categoryMatch?.category.evidenceTerms ?? [];
  const matchedAliases = categoryMatch?.matchedAliases ?? [];
  const genericTerms = GENERIC_STUDENT_EVIDENCE_KEYWORDS.slice(0, 6);
  const highPriorityTerms = Array.from(
    new Set([...matchedAliases, ...categoryTerms, ...genericTerms])
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

  return queries
    .filter((query, index, list) => list.indexOf(query) === index)
    .slice(0, MAX_EVIDENCE_QUERIES);
}

async function braveSearchResults(query: string): Promise<BraveSearchResult[]> {
  const response = await executeBraveSearchRequest(query, MAX_SEARCH_RESULTS_PER_QUERY);
  if (!response.ok) {
    console.error("[Agent][Retriever] web_search error:", response.message);
    return [];
  }
  return response.results;
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
  userKeyword?: string,
  diagnostics?: SearchRunDiagnostics
): Promise<{
  evidence: EvidenceBundle;
  haltedAt?: CandidateHaltStage;
  haltReason?: CandidateHaltReason;
  providerFailures: ProviderFailure[];
}> {
  const queries = buildEvidenceSearchQueries(shop, userKeyword);
  const snippets: EvidenceSnippet[] = [];
  const seenSnippetKeys = new Set<string>();
  const sourceUrls: string[] = [];
  const providerFailures: ProviderFailure[] = [];
  const braveDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "brave") : null;

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex];
    let results: BraveSearchResult[] = [];
    let requestFailed = false;

    for (let attempt = 1; attempt <= BRAVE_MAX_ATTEMPTS; attempt += 1) {
      braveDiagnostics && (braveDiagnostics.attempted += 1);
      const response = await executeBraveSearchRequest(query, MAX_SEARCH_RESULTS_PER_QUERY);
      if (response.ok) {
        braveDiagnostics && (braveDiagnostics.succeeded += 1);
        logApiEvent("log", {
          stage: "retriever",
          provider: "brave",
          action: "continue",
          shop: shop.name,
          placeId: shop.place_id,
          query,
          httpStatus: response.status,
          attempt,
          durationMs: response.durationMs,
          retryable: false,
        });
        results = response.results;
        break;
      }

      braveDiagnostics && (braveDiagnostics.failed += 1);
      const failure: ProviderFailure = {
        provider: "brave",
        stage: "retriever",
        reason: response.status ? `http_${response.status}` : "request_failed",
        message: response.message,
        httpStatus: response.status,
        query,
        retryable: response.retryable,
        attempt,
        bodyPreview: response.bodyPreview,
      };
      const shouldRetry = response.retryable && attempt < BRAVE_MAX_ATTEMPTS;
      logApiEvent(shouldRetry ? "warn" : "error", {
        stage: "retriever",
        provider: "brave",
        action: shouldRetry ? "retry" : "abort_candidate",
        shop: shop.name,
        placeId: shop.place_id,
        query,
        httpStatus: response.status,
        attempt,
        durationMs: response.durationMs,
        retryable: response.retryable,
        bodyPreview: response.bodyPreview,
        message: response.message,
      });
      if (shouldRetry) {
        continue;
      }

      providerFailures.push(failure);
      const skippedQueries = queries.length - queryIndex - 1;
      braveDiagnostics && (braveDiagnostics.skipped += skippedQueries);
      requestFailed = true;
      break;
    }

    if (requestFailed) {
      return {
        evidence: createEmptyEvidenceBundle(
          shop,
          queries,
          "Search failed before evidence could be collected."
        ),
        haltedAt: "retriever",
        haltReason: "brave_request_failed",
        providerFailures,
      };
    }

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

  const evidence: EvidenceBundle = {
    shop,
    retriever: "Retriever",
    queries,
    snippets: snippets.slice(0, MAX_EVIDENCE_SNIPPETS),
    sourceUrls,
    summary: formatEvidenceSnippets(snippets),
  };
  if (evidence.snippets.length === 0) {
    return {
      evidence,
      haltedAt: "retriever",
      haltReason: "brave_no_evidence",
      providerFailures,
    };
  }

  return {
    evidence,
    providerFailures,
  };
}

function buildVerifierMessage(
  shop: AgentShop,
  evidence: EvidenceBundle,
  userKeyword?: string
): string {
  const categoryExamples = getCategoryPromptExamples(shop);
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

  lines.push("エビデンス:");
  lines.push(evidence.summary);
  lines.push("この店舗に学割・学生向け特典があるか調査してください。");
  lines.push(
    "学割が確認できた場合、discount_infoに割引の具体的な内容を日本語で記述してください。"
  );
  lines.push(
    "例：「学生証提示でフリータイム550円（通常880円）」「ライス無料サービス（学生証提示）」「入場料20%引き」など。"
  );
  lines.push(
    "割引率・割引額・無料特典・条件（平日限定、アプリ提示など）がわかる場合は含めてください。"
  );
  if (categoryExamples.length > 0) {
    lines.push(`カテゴリ別の例: ${categoryExamples.join("、")}`);
  }
  lines.push(
    "エビデンスが学割を明示的に支持しない場合はhas_gakuwari=falseを返してください。"
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
  const categoryExamples = getCategoryPromptExamples(shop);
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

  lines.push("エビデンス:");
  lines.push(evidence.summary);
  lines.push(
    "高優先候補の再確認です。エビデンスが学生向け料金・特典を明示的に支持する場合はhas_gakuwari=trueにしてください。"
  );
  lines.push(
    "学割が確認できた場合、discount_infoに割引の具体的な内容を日本語で記述してください。"
  );
  lines.push(
    "例：「学生証提示でフリータイム550円（通常880円）」「ライス無料サービス（学生証提示）」「入場料20%引き」など。"
  );
  lines.push(
    "割引率・割引額・無料特典・条件がわかる場合は含めてください。"
  );
  if (categoryExamples.length > 0) {
    lines.push(`カテゴリ別の例: ${categoryExamples.join("、")}`);
  }
  lines.push(
    "エビデンスが依然として不十分な場合はhas_gakuwari=falseのままにし、confidence=lowまたはmediumを使用してください。"
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
): Promise<{
  result: AgentResultItem;
  usage?: GeminiChatCompletionResponse["usage"];
}> {
  const invocation = await callLLMForAgentDetailed(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: buildVerifierMessage(shop, evidence, userKeyword),
      },
    ],
    llmProvider
  );

  return {
    result: normalizeResultWithEvidence(parseAgentResult(shop, invocation.content), evidence),
    usage: invocation.usage,
  };
}

async function runReviewer(
  shop: AgentShop,
  evidence: EvidenceBundle,
  current: AgentResultItem,
  userKeyword?: string,
  llmProvider: LLMProviderMode = "gemini"
): Promise<{
  result: AgentResultItem;
  usage?: GeminiChatCompletionResponse["usage"];
}> {
  const invocation = await callLLMForAgentDetailed(
    [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildReviewerMessage(shop, evidence, current, userKeyword),
      },
    ],
    llmProvider
  );

  return {
    result: normalizeResultWithEvidence(parseAgentResult(shop, invocation.content), evidence),
    usage: invocation.usage,
  };
}

function hasPositiveReviewerSignal(evidence: EvidenceBundle): boolean {
  return evidence.snippets.some((snippet) =>
    matchesAnyPattern(
      `${snippet.title}\n${snippet.content}\n${snippet.url}`,
      STUDENT_POSITIVE_PATTERNS
    )
  );
}

function shouldReviewOutcome(outcome: InvestigationOutcome): boolean {
  return (
    outcome.verifierCompleted &&
    !outcome.result.has_gakuwari &&
    outcome.result.confidence === "low" &&
    outcome.rank <= 4 &&
    outcome.evidence.snippets.length > 0 &&
    hasPositiveReviewerSignal(outcome.evidence)
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
  llmProvider: LLMProviderMode = "gemini",
  diagnostics?: SearchRunDiagnostics
): Promise<InvestigationOutcome[]> {
  const forcedSet = new Set(forcedPlaceIds);
  const targets = outcomes
  .filter(
      (outcome) =>
        !outcome.reviewed &&
        outcome.verifierCompleted &&
        !outcome.result.has_gakuwari &&
        outcome.evidence.snippets.length > 0 &&
        (shouldReviewOutcome(outcome) || forcedSet.has(outcome.shop.place_id))
    )
    .sort((left, right) => left.rank - right.rank)
    .slice(0, MAX_REVIEW_TARGETS);

  if (targets.length === 0) {
    return outcomes;
  }

  const reviewed = await Promise.all(
    targets.map(async (outcome) => {
      const geminiDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "gemini") : null;
      const startedAt = performance.now();
      geminiDiagnostics && (geminiDiagnostics.attempted += 1);
      try {
        const reviewedResult = await runReviewer(
          outcome.shop,
          outcome.evidence,
          outcome.result,
          userKeyword,
          llmProvider
        );
        geminiDiagnostics && (geminiDiagnostics.succeeded += 1);
        logApiEvent("log", {
          stage: "reviewer",
          provider: "gemini",
          action: "continue",
          shop: outcome.shop.name,
          placeId: outcome.shop.place_id,
          attempt: 1,
          durationMs: Math.round(performance.now() - startedAt),
          retryable: false,
          prompt_tokens: reviewedResult.usage?.prompt_tokens,
          completion_tokens: reviewedResult.usage?.completion_tokens,
          total_tokens: reviewedResult.usage?.total_tokens,
        });
        return {
          placeId: outcome.shop.place_id,
          result: mergeReviewedResult(outcome.result, reviewedResult.result),
        };
      } catch (error) {
        geminiDiagnostics && (geminiDiagnostics.failed += 1);
        logApiEvent("error", {
          stage: "reviewer",
          provider: "gemini",
          action: "continue",
          shop: outcome.shop.name,
          placeId: outcome.shop.place_id,
          attempt: 1,
          durationMs: Math.round(performance.now() - startedAt),
          retryable: false,
          message: error instanceof Error ? error.message : "Unknown reviewer error",
        });
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
      verifierCompleted: outcome.verifierCompleted,
      reviewer: "Reviewer",
    };
  });
}

async function investigateRankedCandidate(
  candidate: InvestigationCandidate,
  userKeyword?: string,
  llmProvider: LLMProviderMode = "gemini",
  diagnostics?: SearchRunDiagnostics
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
      verifierCompleted: false,
      providerFailures: [...candidate.providerFailures],
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

  const queries = buildEvidenceSearchQueries(candidate, userKeyword);
  if (candidate.haltedAt && candidate.haltReason) {
    const braveDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "brave") : null;
    const geminiDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "gemini") : null;
    braveDiagnostics && (braveDiagnostics.skipped += queries.length);
    geminiDiagnostics && (geminiDiagnostics.skipped += 1);
    logCandidateHalt(
      candidate,
      candidate.haltedAt,
      candidate.haltReason,
      ["brave_retriever", "gemini_verifier", "gemini_reviewer"],
      candidate.providerFailures
    );
    return {
      shop: candidate,
      rank: candidate.rank,
      verifier: "Verifier",
      reviewed: false,
      reviewerTriggered: false,
      verifierCompleted: false,
      haltedAt: candidate.haltedAt,
      haltReason: candidate.haltReason,
      providerFailures: [...candidate.providerFailures],
      evidence: createEmptyEvidenceBundle(
        candidate,
        queries,
        "Candidate halted before evidence collection due to missing investigation context."
      ),
      result: createDefaultResult(candidate),
    };
  }

  let evidenceResult: Awaited<ReturnType<typeof collectEvidenceBundle>>;
  let evidenceMs = 0;
  try {
    const evidenceStartedAt = performance.now();
    evidenceResult = await collectEvidenceBundle(candidate, userKeyword, diagnostics);
    evidenceMs = Math.round(performance.now() - evidenceStartedAt);
  } catch (error) {
    const braveDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "brave") : null;
    braveDiagnostics && (braveDiagnostics.failed += 1);
    const failure: ProviderFailure = {
      provider: "brave",
      stage: "retriever",
      reason: "retriever_failed",
      message: error instanceof Error ? error.message : "Unknown retriever error",
      retryable: false,
    };
    const providerFailures = [...candidate.providerFailures, failure];
    const geminiDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "gemini") : null;
    geminiDiagnostics && (geminiDiagnostics.skipped += 1);
    logApiEvent("error", {
      stage: "retriever",
      provider: "brave",
      action: "abort_candidate",
      shop: candidate.name,
      placeId: candidate.place_id,
      attempt: 1,
      durationMs: Math.round(performance.now() - startedAt),
      retryable: false,
      message: failure.message,
    });
    logCandidateHalt(
      candidate,
      "retriever",
      "brave_request_failed",
      ["gemini_verifier", "gemini_reviewer"],
      providerFailures
    );
    return {
      shop: candidate,
      rank: candidate.rank,
      verifier: "Verifier",
      reviewed: false,
      reviewerTriggered: false,
      verifierCompleted: false,
      haltedAt: "retriever",
      haltReason: "brave_request_failed",
      providerFailures,
      evidence: createEmptyEvidenceBundle(
        candidate,
        queries,
        "Search failed before evidence could be collected."
      ),
      result: createDefaultResult(candidate),
    };
  }

  const providerFailures = [...candidate.providerFailures, ...evidenceResult.providerFailures];
  if (evidenceResult.haltedAt && evidenceResult.haltReason) {
    const geminiDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "gemini") : null;
    geminiDiagnostics && (geminiDiagnostics.skipped += 1);
    logCandidateHalt(
      candidate,
      evidenceResult.haltedAt,
      evidenceResult.haltReason,
      ["gemini_verifier", "gemini_reviewer"],
      providerFailures
    );
    return {
      shop: candidate,
      rank: candidate.rank,
      verifier: "Verifier",
      reviewed: false,
      reviewerTriggered: false,
      verifierCompleted: false,
      haltedAt: evidenceResult.haltedAt,
      haltReason: evidenceResult.haltReason,
      providerFailures,
      evidence: evidenceResult.evidence,
      result: createDefaultResult(candidate),
    };
  }

  const geminiDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "gemini") : null;
  geminiDiagnostics && (geminiDiagnostics.attempted += 1);
  try {
    const verifierStartedAt = performance.now();
    const verifierResult = await runVerifier(
      candidate,
      evidenceResult.evidence,
      userKeyword,
      llmProvider
    );
    const verifierMs = Math.round(performance.now() - verifierStartedAt);
    geminiDiagnostics && (geminiDiagnostics.succeeded += 1);
    logApiEvent("log", {
      stage: "verifier",
      provider: "gemini",
      action: "continue",
      shop: candidate.name,
      placeId: candidate.place_id,
      attempt: 1,
      durationMs: verifierMs,
      retryable: false,
      prompt_tokens: verifierResult.usage?.prompt_tokens,
      completion_tokens: verifierResult.usage?.completion_tokens,
      total_tokens: verifierResult.usage?.total_tokens,
    });
    cacheAgentResult(cacheKey, verifierResult.result);

    console.log(
      `[Agent][Verifier][${llmProvider}] Shop="${candidate.name}" rank=${candidate.rank} queries=${evidenceResult.evidence.queries.length} snippets=${evidenceResult.evidence.snippets.length} evidenceMs=${evidenceMs} verifierMs=${verifierMs} totalMs=${Math.round(
        performance.now() - startedAt
      )}`
    );

    return {
      shop: candidate,
      rank: candidate.rank,
      verifier: "Verifier",
      reviewed: false,
      reviewerTriggered: false,
      verifierCompleted: true,
      providerFailures,
      evidence: evidenceResult.evidence,
      result: verifierResult.result,
    };
  } catch (error) {
    geminiDiagnostics && (geminiDiagnostics.failed += 1);
    const failure: ProviderFailure = {
      provider: "gemini",
      stage: "verifier",
      reason: "verifier_failed",
      message: error instanceof Error ? error.message : "Unknown verifier error",
      retryable: false,
    };
    const haltedFailures = [...providerFailures, failure];
    logApiEvent("error", {
      stage: "verifier",
      provider: "gemini",
      action: "abort_candidate",
      shop: candidate.name,
      placeId: candidate.place_id,
      attempt: 1,
      durationMs: Math.round(performance.now() - startedAt),
      retryable: false,
      message: failure.message,
    });
    console.error(
      `[Agent][Verifier][${llmProvider}] Shop="${candidate.name}" failed:`,
      error
    );
    logCandidateHalt(
      candidate,
      "verifier",
      "gemini_failed",
      ["gemini_reviewer"],
      haltedFailures
    );
    return {
      shop: candidate,
      rank: candidate.rank,
      verifier: "Verifier",
      reviewed: false,
      reviewerTriggered: false,
      verifierCompleted: false,
      haltedAt: "verifier",
      haltReason: "gemini_failed",
      providerFailures: haltedFailures,
      evidence: evidenceResult.evidence,
      result: createDefaultResult(candidate),
    };
  }
}

async function investigateCandidates(
  candidates: InvestigationCandidate[],
  userKeyword?: string,
  llmProvider: LLMProviderMode = "gemini",
  diagnostics?: SearchRunDiagnostics
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
        investigateRankedCandidate(candidate, userKeyword, llmProvider, diagnostics)
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

async function enrichShopsWithPlaceDetails<T extends AgentShop>(
  shops: T[],
  diagnostics?: SearchRunDiagnostics
): Promise<T[]> {
  if (shops.length === 0) {
    return shops;
  }

  const enrichedShops = await Promise.all(
    shops.map(async (shop) => {
      const detailsDiagnostics = diagnostics ? getStepDiagnostics(diagnostics, "details") : null;
      if (!shouldLookupPlaceDetails(shop)) {
        detailsDiagnostics && (detailsDiagnostics.skipped += 1);
        return shop;
      }

      const cachedDetails = getCachedPlaceDetails(shop.place_id);
      if (cachedDetails) {
        detailsDiagnostics && (detailsDiagnostics.skipped += 1);
        return {
          ...shop,
          address: cachedDetails.address || shop.address,
          website: cachedDetails.website ?? shop.website,
        } as T;
      }

      console.log(`[Agent][Places] details lookup for "${shop.name}"`);
      detailsDiagnostics && (detailsDiagnostics.attempted += 1);
      const startedAt = performance.now();

      try {
        const details = await makeRequest<PlaceDetailsResult>(
          "/maps/api/place/details/json",
          {
            place_id: shop.place_id,
            fields: "website,formatted_address",
            language: "ja",
          }
        );
        const durationMs = Math.round(performance.now() - startedAt);

        if (details.status !== "OK" || !details.result) {
          detailsDiagnostics && (detailsDiagnostics.failed += 1);
          const failure: ProviderFailure = {
            provider: "details",
            stage: "details",
            reason: "details_status",
            message: `Place details returned ${details.status}`,
            providerStatus: details.status,
            retryable: false,
          };
          const usableContext = hasUsableInvestigationContext(shop);
          logApiEvent(usableContext ? "warn" : "error", {
            stage: "details",
            provider: "details",
            action: usableContext ? "continue" : "abort_candidate",
            shop: shop.name,
            placeId: shop.place_id,
            providerStatus: details.status,
            durationMs,
            retryable: false,
            message: failure.message,
          });
          return usableContext
            ? appendProviderFailure(shop, failure)
            : haltPreparedCandidate(shop, "details_unusable_context", failure);
        }

        detailsDiagnostics && (detailsDiagnostics.succeeded += 1);
        const enrichedShop = {
          ...shop,
          address: details.result.formatted_address ?? shop.address,
          website: details.result.website ?? shop.website,
        };
        logApiEvent("log", {
          stage: "details",
          provider: "details",
          action: "continue",
          shop: shop.name,
          placeId: shop.place_id,
          providerStatus: details.status,
          durationMs,
          retryable: false,
        });
        cachePlaceDetails(shop.place_id, {
          address: enrichedShop.address,
          website: enrichedShop.website,
        });
        return enrichedShop as T;
      } catch (error) {
        detailsDiagnostics && (detailsDiagnostics.failed += 1);
        const durationMs = Math.round(performance.now() - startedAt);
        const failure: ProviderFailure = {
          provider: "details",
          stage: "details",
          reason: "details_request_failed",
          message: error instanceof Error ? error.message : "Unknown place details error",
          retryable: false,
        };
        const usableContext = hasUsableInvestigationContext(shop);
        logApiEvent(usableContext ? "warn" : "error", {
          stage: "details",
          provider: "details",
          action: usableContext ? "continue" : "abort_candidate",
          shop: shop.name,
          placeId: shop.place_id,
          durationMs,
          retryable: false,
          message: failure.message,
        });
        console.warn(
          `[Agent][Places] details lookup failed for "${shop.name}"`,
          error
        );
        return usableContext
          ? appendProviderFailure(shop, failure)
          : haltPreparedCandidate(shop, "details_unusable_context", failure);
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
  const diagnostics = createSearchRunDiagnostics();
  const rankedCandidates = await prepareCandidatesForInvestigation(
    lat,
    lng,
    radius,
    keyword,
    diagnostics
  );
  diagnostics.candidatesPrepared = rankedCandidates.length;

  if (rankedCandidates.length === 0) {
    console.log("[Agent][Scout] No candidate shops found within the radius");
    logAgentEvent("log", {
      event: "search_summary",
      profiles: diagnostics.profiles,
      candidatesPrepared: diagnostics.candidatesPrepared,
      candidatesInvestigated: 0,
      candidatesHalted: 0,
      nearby: diagnostics.nearby,
      details: diagnostics.details,
      brave: diagnostics.brave,
      gemini: diagnostics.gemini,
      totalMs: Math.round(performance.now() - startedAt),
    });
    return [];
  }

  console.log(
    `[Agent][Scout][${llmProvider}] Prepared ${rankedCandidates.length} ranked candidates within radius=${radius}`
  );

  const waveOneCandidates = rankedCandidates.slice(0, WAVE_ONE_SIZE);
  let outcomes = await investigateCandidates(
    waveOneCandidates,
    keyword,
    llmProvider,
    diagnostics
  );
  outcomes = await applyReviewerPass(outcomes, keyword, [], llmProvider, diagnostics);

  if (outcomes.some((outcome) => outcome.result.has_gakuwari)) {
    const additionalCandidates = rankedCandidates.slice(
      WAVE_ONE_SIZE,
      Math.min(MAX_INVESTIGATED_AFTER_HIT, rankedCandidates.length)
    );

    if (additionalCandidates.length > 0) {
      const extraOutcomes = await investigateCandidates(
        additionalCandidates,
        keyword,
        llmProvider,
        diagnostics
      );
      outcomes = outcomes.concat(
        await applyReviewerPass(extraOutcomes, keyword, [], llmProvider, diagnostics)
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
        llmProvider,
        diagnostics
      );
      outcomes = outcomes.concat(
        await applyReviewerPass(waveTwoOutcomes, keyword, [], llmProvider, diagnostics)
      );
    }
  }

  const sortedOutcomes = sortInvestigationOutcomes(outcomes);
  diagnostics.candidatesInvestigated = sortedOutcomes.length;
  diagnostics.candidatesHalted = sortedOutcomes.filter((outcome) => Boolean(outcome.haltedAt)).length;

  console.log(
    `[Agent][Timing][${llmProvider}] searchGakuwariSpots candidates=${rankedCandidates.length} investigated=${sortedOutcomes.length} totalMs=${Math.round(
      performance.now() - startedAt
    )}`
  );
  logAgentEvent("log", {
    event: "search_summary",
    profiles: diagnostics.profiles,
    matchedCategoryIds: diagnostics.matchedCategoryIds,
    matchedAliases: diagnostics.matchedAliases,
    apiBoostEnabled: diagnostics.apiBoostEnabled,
    budgetPolicy: diagnostics.budgetPolicy,
    broadOnlyReason: diagnostics.broadOnlyReason,
    candidatesPrepared: diagnostics.candidatesPrepared,
    candidatesInvestigated: diagnostics.candidatesInvestigated,
    candidatesHalted: diagnostics.candidatesHalted,
    nearby: diagnostics.nearby,
    details: diagnostics.details,
    brave: diagnostics.brave,
    gemini: diagnostics.gemini,
    totalMs: Math.round(performance.now() - startedAt),
  });

  return sortedOutcomes.map((outcome) =>
    toGakuwariSearchResult(outcome.shop, outcome.result)
  );
}

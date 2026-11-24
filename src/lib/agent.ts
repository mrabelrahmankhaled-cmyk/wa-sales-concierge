import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import {
  escalateToHuman,
  getProductByCode,
  getStorePolicy,
  loadStore,
  searchProducts,
} from "./store";
import type { LoadedStore, SalesAgentResult, ToolCallTrace } from "./types";

export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_SESSION_TURNS = 12;
export const MODEL_COOLDOWN_MS = 5 * 60 * 1000; // 300,000 ms (5-minute cooldown for slow/overloaded models)
export const DEFAULT_CALL_TIMEOUT_MS = 8000; // Strict 8s per-attempt timeout
const MAX_TOOL_ITERATIONS = 6;

export const DEFAULT_PRIMARY_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
];

export interface SessionTurn {
  userText: string;
  modelText: string;
}

interface SessionState {
  turns: SessionTurn[];
  updatedAt: number;
}

const sessionStore = new Map<string, SessionState>();
const modelCooldownMap = new Map<string, number>();
const modelsWithoutThinkingSupport = new Set<string>();

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "GEMINI_API_KEY is missing. Add GEMINI_API_KEY to your .env.local file to enable AI responses."
    );
    this.name = "MissingApiKeyError";
  }
}

export class ModelCallTimeoutError extends Error {
  public readonly status = 504;
  constructor(model: string, timeoutMs: number) {
    super(`GEMINI_CALL_TIMEOUT: Model "${model}" did not respond within ${timeoutMs}ms`);
    this.name = "ModelCallTimeoutError";
  }
}

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key && key !== "your_gemini_api_key_here");
}

export function getCallTimeoutMs(overrideMs?: number): number {
  if (typeof overrideMs === "number" && overrideMs > 0) {
    return overrideMs;
  }
  const envRaw = process.env.GEMINI_CALL_TIMEOUT_MS?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_CALL_TIMEOUT_MS;
}

/**
 * Resets the in-memory model cooldown & capability maps (useful for deterministic unit tests).
 */
export function resetModelCooldowns(): void {
  modelCooldownMap.clear();
  modelsWithoutThinkingSupport.clear();
}

/**
 * Returns the cooldown expiration timestamp (ms) if the model is currently cooling down, or null.
 */
export function getModelCooldownExpiry(model: string, now = Date.now()): number | null {
  const expiry = modelCooldownMap.get(model);
  if (expiry === undefined) return null;
  if (expiry <= now) {
    modelCooldownMap.delete(model);
    return null;
  }
  return expiry;
}

export function markModelInCooldown(model: string, now = Date.now()): void {
  modelCooldownMap.set(model, now + MODEL_COOLDOWN_MS);
}

/**
 * Builds the deduplicated primary + fallback model chain from environment variables or defaults.
 */
export function getConfiguredModelChain(): string[] {
  const primary = process.env.GEMINI_MODEL?.trim() || DEFAULT_PRIMARY_MODEL;
  const rawFallbacks = process.env.GEMINI_FALLBACK_MODELS?.trim();
  const fallbacks = rawFallbacks
    ? rawFallbacks
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : DEFAULT_FALLBACK_MODELS;

  const unique: string[] = [];
  for (const model of [primary, ...fallbacks]) {
    if (model && !unique.includes(model)) {
      unique.push(model);
    }
  }
  return unique;
}

/**
 * Returns the ordered list of models to try right now:
 * - Skips any model currently in its 5-minute cooldown window.
 * - If ALL models are in cooldown, returns the model whose cooldown expires earliest.
 */
export function getCandidateModelsForTurn(now = Date.now()): string[] {
  const chain = getConfiguredModelChain();

  for (const [model, expiresAt] of modelCooldownMap.entries()) {
    if (expiresAt <= now) {
      modelCooldownMap.delete(model);
    }
  }

  const healthy = chain.filter((model) => !modelCooldownMap.has(model));
  if (healthy.length > 0) {
    return healthy;
  }

  const sortedByEarliestExpiry = [...chain].sort(
    (a, b) => (modelCooldownMap.get(a) ?? 0) - (modelCooldownMap.get(b) ?? 0)
  );
  return sortedByEarliestExpiry.slice(0, 1);
}

/**
 * Checks whether an error indicates a 400 rejection of `thinkingConfig` so we can retry once without it.
 */
export function isThinkingConfigRejectedError(error: unknown): boolean {
  if (!error || error instanceof ModelCallTimeoutError) return false;

  const errObj = error as Record<string, unknown>;
  const nestedErr = (errObj.error as Record<string, unknown> | undefined) ?? {};
  const statusCandidates = [errObj.status, errObj.statusCode, errObj.code, nestedErr.code];

  const has400Status = statusCandidates.some(
    (v) => v === 400 || v === "400" || v === "INVALID_ARGUMENT"
  );

  const rawMsg =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error);

  const mentions400 = has400Status || /\b400\b|INVALID_ARGUMENT/i.test(rawMsg);
  const mentionsThinking = /thinking|budget/i.test(rawMsg);

  return mentions400 && (mentionsThinking || has400Status);
}

/**
 * Checks whether an error should trigger a 5-minute cooldown and immediate failover to the next model:
 * Per-call timeout, AbortError, 503, 504, 429, 404, UNAVAILABLE, RESOURCE_EXHAUSTED, DEADLINE_EXCEEDED, or NOT_FOUND.
 */
export function isFailoverTriggerError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof ModelCallTimeoutError) return true;

  const errObj = error as Record<string, unknown>;
  const nestedErr = (errObj.error as Record<string, unknown> | undefined) ?? {};

  if (errObj.name === "AbortError" || errObj.name === "TimeoutError") {
    return true;
  }

  const statusCandidates = [
    errObj.status,
    errObj.statusCode,
    errObj.code,
    nestedErr.code,
    nestedErr.status,
  ];

  for (const val of statusCandidates) {
    if (val === 503 || val === 504 || val === 429 || val === 404) return true;
    if (typeof val === "string") {
      const upper = val.toUpperCase();
      if (
        upper === "503" ||
        upper === "504" ||
        upper === "429" ||
        upper === "404" ||
        upper.includes("UNAVAILABLE") ||
        upper.includes("RESOURCE_EXHAUSTED") ||
        upper.includes("NOT_FOUND") ||
        upper.includes("DEADLINE_EXCEEDED") ||
        upper.includes("TIMEOUT") ||
        upper.includes("ETIMEDOUT")
      ) {
        return true;
      }
    }
  }

  const rawMsg =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  const upperMsg = rawMsg.toUpperCase();

  return (
    /\b(503|504|429|404)\b/.test(upperMsg) ||
    upperMsg.includes("UNAVAILABLE") ||
    upperMsg.includes("RESOURCE_EXHAUSTED") ||
    upperMsg.includes("NOT_FOUND") ||
    upperMsg.includes("GEMINI_CALL_TIMEOUT") ||
    upperMsg.includes("DEADLINE_EXCEEDED") ||
    upperMsg.includes("ETIMEDOUT") ||
    upperMsg.includes("ABORTERROR")
  );
}

function summarizeDebugError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown upstream model error";
  }
}

export interface FunctionCallLike {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export interface GenerateContentResponseLike {
  text?: string;
  functionCalls?: FunctionCallLike[];
  candidates?: Array<{
    content?: Content;
  }>;
}

export interface GenAIClientLike {
  models: {
    generateContent(params: {
      model: string;
      contents: Content[];
      config?: Record<string, unknown>;
    }): Promise<GenerateContentResponseLike>;
  };
}

function getSessionKey(storeSlug: string, sessionId: string): string {
  return `${storeSlug.toLowerCase()}::${sessionId}`;
}

function pruneExpiredSessions(now = Date.now()): void {
  for (const [key, session] of sessionStore.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessionStore.delete(key);
    }
  }
}

export function getSessionTurns(
  storeSlug: string,
  sessionId: string,
  now = Date.now()
): SessionTurn[] {
  pruneExpiredSessions(now);
  const key = getSessionKey(storeSlug, sessionId);
  const existing = sessionStore.get(key);
  if (!existing) return [];
  return [...existing.turns];
}

function appendSessionTurn(
  storeSlug: string,
  sessionId: string,
  turn: SessionTurn,
  now = Date.now()
): void {
  pruneExpiredSessions(now);
  const key = getSessionKey(storeSlug, sessionId);
  const existing = sessionStore.get(key);
  const updatedTurns = [...(existing?.turns ?? []), turn].slice(-MAX_SESSION_TURNS);
  sessionStore.set(key, {
    turns: updatedTurns,
    updatedAt: now,
  });
}

export function clearSessionHistory(storeSlug?: string, sessionId?: string): void {
  if (!storeSlug) {
    sessionStore.clear();
    return;
  }
  if (sessionId) {
    sessionStore.delete(getSessionKey(storeSlug, sessionId));
    return;
  }
  const prefix = `${storeSlug.toLowerCase()}::`;
  for (const key of sessionStore.keys()) {
    if (key.startsWith(prefix)) {
      sessionStore.delete(key);
    }
  }
}

/**
 * Gemini Function Declarations for Zero-Hallucination Catalog & Policy Lookup
 */
export const SALES_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "get_product_by_code",
    description:
      "Look up a specific product in the store catalog by its exact or partial product code (case-insensitive, e.g. 'B039' or 'R104'). MUST be called before stating price, weight, karat, stock availability, or link of a coded item.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        code: {
          type: Type.STRING,
          description: "Product SKU/code such as 'B039', 'R104', 'N219'.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "search_products",
    description:
      "Search the store catalog across Arabic/English product names, categories, karats, and descriptions, with optional maximum price, category, and in-stock filters. MUST be called before recommending products or proposing in-stock alternatives.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description:
            "Arabic or English search keywords (e.g., 'خاتم عيار 21', 'سوار ناعم', 'عقد هدية'). Leave empty if filtering purely by category/maxPrice.",
        },
        maxPrice: {
          type: Type.NUMBER,
          description: "Maximum price in store currency (e.g., 1500).",
        },
        category: {
          type: Type.STRING,
          description: "Optional category filter (e.g., 'خواتم', 'أساور', 'عقود', 'أقراط').",
        },
        inStockOnly: {
          type: Type.BOOLEAN,
          description: "Set to true to return only available in-stock products.",
        },
      },
    },
  },
  {
    name: "get_store_policy",
    description:
      "Retrieve official store policies from config.json including shipping, installments (Tabby/Tamara), returns/exchanges, or working hours. MUST be called before answering any policy, delivery, or installment question.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: {
          type: Type.STRING,
          enum: ["shipping", "installments", "returns", "working_hours", "all"],
          description:
            "Policy topic requested by the customer: 'shipping', 'installments', 'returns', 'working_hours', or 'all'.",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Escalate and hand off the conversation to a human sales specialist. Call this for custom sizing/engraving/bespoke fabrication, price negotiation/special discounts, complaints, wholesale requests, or items completely absent from the catalog.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: {
          type: Type.STRING,
          description:
            "Short reason for escalation (e.g., 'custom_sizing_and_discount', 'custom_engraving', 'complaint', 'not_in_catalog').",
        },
        customerSummary: {
          type: Type.STRING,
          description:
            "Concise Arabic summary of what the customer wants so the human sales rep has full context.",
        },
      },
      required: ["reason", "customerSummary"],
    },
  },
];

export function buildSystemPrompt(store: LoadedStore): string {
  const { config } = store;
  return `أنت مستشار مبيعات ذكي وراقي عبر واتساب لمتجر "${config.storeName}".
اللهجة وتنسيق واتساب الأصلي (مهم جداً):
- تحدث بلهجة سعودية بيضاء راقية، دافئة، مختصرة، ومهذبة جداً (${config.dialect}) مثل مستشار مبيعات محترف في متجر ذهب ومجوهرات فاخر في السعودية.
- نسّق الرسائل بأسلوب واتساب الأصلي فقط:
  • يُمنع منعاً باتاً استخدام تنسيق Markdown ذي النجمتين مثل **نص** أو العناوين # أو جداول Markdown.
  • لإبراز الكلمات المهمة أو الأسعار أو أسماء القطع استخدم نجمة واحدة فقط على طريقة واتساب مثل: *اسم القطعة* أو *1,290 ريال*.
  • استخدم فقرات قصيرة ونقاط بسيطة وواضحة (• أو -) سهلة القراءة على شاشة الجوال.
- العملة المعتمدة للمتجر هي: ${config.currency} (ريال سعودي).

قواعد صارمة لمنع الهلوسة (Zero-Hallucination Rules — إلزامية 100%):
1. يُمنع منعاً باتاً تخمين أو اختلاق أي سعر أو وزن بالجرام أو عيار ذهب أو حالة توفر أو رابط منتج أو سياسة متجر من ذاكرتك.
2. يجب دائماً استدعاء الأداة المناسبة أولاً قبل ذكر أي معلومة:
   - عند السؤال عن كود قطعة محدد (مثل B039): استدعِ get_product_by_code.
   - عند البحث عن قطع حسب النوع أو العيار أو الميزانية: استدعِ search_products.
   - عند السؤال عن الشحن، التوصيل، التقسيط (تابي / تمارا)، الاستبدال والاسترجاع، أو أوقات الدوام: استدعِ get_store_policy.
   - عند طلب تفصيل خاص، تعديل مقاس غير قياسي، نقش اسم، تفاوض على السعر أو طلب خصم خاص، شكوى، أو طلب غير متوفر في الكتالوج: استدعِ escalate_to_human فوراً.
3. إذا كانت القطعة المطلوبة غير متوفرة حالياً (inStock: false):
   - وضّح للعميل بصدق ولطافة أن القطعة غير متوفرة حالياً (نفدت كميتها).
   - بادر فوراً باستدعاء search_products مع inStockOnly: true لاقتراح قطعتين (1 إلى 2) بديلتين متوفرتين من نفس الفئة أو قريبتين منها مع ذكر أسمائها وأسعارها وروابطها.
4. عند ترشيح أو عرض أي منتج متوفر، اذكر دائماً الرابط الدقيق للمنتج (url) كما ورد من الأداة تماماً حتى يتمكن العميل من إتمام الطلب مباشرة.
5. عند استدعاء escalate_to_human، طمئن العميل بلباقة بأنه تم تحويل طلبه لمستشار المبيعات المختص واذكر رقم التواصل المباشر (${config.humanHandoffPhone}) وأوقات العمل إن لزم.`;
}

export function buildPoliteFallbackReply(store: LoadedStore): string {
  return `حياك الله في *${store.config.storeName}* ✨\nنواجه حالياً ضغطاً مؤقتاً في الخدمة الذكية، نعتذر منك جداً 🙏\nياليت تعيد إرسال استفسارك بعد لحظات، أو تتواصل مباشرة مع مستشار المبيعات لخدمتك فوراً على الرقم: ${store.config.humanHandoffPhone}`;
}

function executeStoreTool(
  store: LoadedStore,
  name: string,
  args: Record<string, unknown>
): { result: Record<string, unknown>; isEscalation: boolean } {
  switch (name) {
    case "get_product_by_code":
      return {
        result: getProductByCode(store, { code: String(args.code ?? "") }),
        isEscalation: false,
      };
    case "search_products":
      return {
        result: searchProducts(store, {
          query: typeof args.query === "string" ? args.query : undefined,
          maxPrice: typeof args.maxPrice === "number" ? args.maxPrice : undefined,
          category: typeof args.category === "string" ? args.category : undefined,
          inStockOnly: typeof args.inStockOnly === "boolean" ? args.inStockOnly : undefined,
        }),
        isEscalation: false,
      };
    case "get_store_policy":
      return {
        result: getStorePolicy(store, { topic: String(args.topic ?? "all") }),
        isEscalation: false,
      };
    case "escalate_to_human":
      return {
        result: escalateToHuman(store, {
          reason: String(args.reason ?? "customer_request"),
          customerSummary: String(args.customerSummary ?? ""),
        }),
        isEscalation: true,
      };
    default:
      return {
        result: { error: `Unknown tool: ${name}` },
        isEscalation: false,
      };
  }
}

function extractFunctionCalls(response: GenerateContentResponseLike): FunctionCallLike[] {
  if (Array.isArray(response.functionCalls) && response.functionCalls.length > 0) {
    return response.functionCalls;
  }
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const calls: FunctionCallLike[] = [];
  for (const part of parts) {
    if (part.functionCall) {
      calls.push({
        id: part.functionCall.id,
        name: part.functionCall.name,
        args: (part.functionCall.args as Record<string, unknown> | undefined) ?? {},
      });
    }
  }
  return calls;
}

function extractResponseText(response: GenerateContentResponseLike): string {
  if (typeof response.text === "string" && response.text.trim()) {
    return response.text.trim();
  }
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const texts = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean);
  return texts.join("").trim();
}

/**
 * Executes a single `generateContent` call bounded by a strict `AbortController` + `Promise.race` timeout.
 */
async function invokeGenerateContentWithTimeout(params: {
  aiClient: GenAIClientLike;
  model: string;
  contents: Content[];
  systemInstruction: string;
  includeThinkingConfig: boolean;
  timeoutMs: number;
}): Promise<GenerateContentResponseLike> {
  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      controller.abort();
      reject(new ModelCallTimeoutError(params.model, params.timeoutMs));
    }, params.timeoutMs);
  });

  const requestConfig: Record<string, unknown> = {
    systemInstruction: params.systemInstruction,
    temperature: 0.2,
    tools: [{ functionDeclarations: SALES_TOOL_DECLARATIONS }],
    abortSignal: controller.signal,
    ...(params.includeThinkingConfig ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };

  try {
    return await Promise.race([
      params.aiClient.models.generateContent({
        model: params.model,
        contents: params.contents,
        config: requestConfig,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
}

async function generateWithFailover(params: {
  aiClient: GenAIClientLike;
  contents: Content[];
  systemInstruction: string;
  now: number;
  callTimeoutMs: number;
}): Promise<{ response: GenerateContentResponseLike; modelUsed: string }> {
  const candidates = getCandidateModelsForTurn(params.now);
  const errors: string[] = [];

  for (const candidateModel of candidates) {
    const useThinkingBudgetZero = !modelsWithoutThinkingSupport.has(candidateModel);

    try {
      const response = await invokeGenerateContentWithTimeout({
        aiClient: params.aiClient,
        model: candidateModel,
        contents: params.contents,
        systemInstruction: params.systemInstruction,
        includeThinkingConfig: useThinkingBudgetZero,
        timeoutMs: params.callTimeoutMs,
      });
      return { response, modelUsed: candidateModel };
    } catch (firstErr) {
      // If a model rejects `thinkingConfig` with HTTP 400, immediately retry once without `thinkingConfig`
      if (useThinkingBudgetZero && isThinkingConfigRejectedError(firstErr)) {
        modelsWithoutThinkingSupport.add(candidateModel);
        try {
          const retryResponse = await invokeGenerateContentWithTimeout({
            aiClient: params.aiClient,
            model: candidateModel,
            contents: params.contents,
            systemInstruction: params.systemInstruction,
            includeThinkingConfig: false,
            timeoutMs: params.callTimeoutMs,
          });
          return { response: retryResponse, modelUsed: candidateModel };
        } catch (retryErr) {
          const retrySummary = summarizeDebugError(retryErr);
          errors.push(`[${candidateModel}] ${retrySummary}`);
          if (isFailoverTriggerError(retryErr)) {
            markModelInCooldown(candidateModel, params.now);
            continue;
          }
          throw new Error(errors.join(" | "));
        }
      }

      const summary = summarizeDebugError(firstErr);
      errors.push(`[${candidateModel}] ${summary}`);

      if (isFailoverTriggerError(firstErr)) {
        markModelInCooldown(candidateModel, params.now);
        continue;
      }

      // Non-failover error (e.g., invalid API key): fail fast without stalling
      throw new Error(errors.join(" | "));
    }
  }

  throw new Error(`All candidate models failed: ${errors.join(" -> ")}`);
}

export interface RunSalesAgentInput {
  storeSlug: string;
  sessionId: string;
  message: string;
  client?: GenAIClientLike;
  now?: number;
  callTimeoutMs?: number;
}

/**
 * Core Zero-Hallucination AI Sales Engine (`runSalesAgent`)
 * Shared across both the WhatsApp Web Simulator and the Meta WhatsApp Cloud API Webhook.
 */
export async function runSalesAgent(input: RunSalesAgentInput): Promise<SalesAgentResult> {
  const { storeSlug, sessionId, message, now = Date.now() } = input;
  const callTimeoutMs = getCallTimeoutMs(input.callTimeoutMs);
  const store = loadStore(storeSlug);
  const trimmedMessage = message.trim();

  if (!trimmedMessage) {
    return {
      reply: store.config.greetingMessage,
      toolCalls: [],
      handedOff: false,
      modelUsed: "static-greeting",
    };
  }

  let aiClient = input.client;
  if (!aiClient) {
    if (!isGeminiConfigured()) {
      throw new MissingApiKeyError();
    }
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  }

  const systemInstruction = buildSystemPrompt(store);

  // Build multi-turn history from session memory (up to 12 prior turns)
  const priorTurns = getSessionTurns(store.config.slug, sessionId, now);
  const contents: Content[] = [];
  for (const turn of priorTurns) {
    contents.push({ role: "user", parts: [{ text: turn.userText }] });
    contents.push({ role: "model", parts: [{ text: turn.modelText }] });
  }
  contents.push({ role: "user", parts: [{ text: trimmedMessage }] });

  const toolCalls: ToolCallTrace[] = [];
  let handedOff = false;
  let finalReply = "";
  let modelUsed = getConfiguredModelChain()[0] || DEFAULT_PRIMARY_MODEL;

  try {
    for (let step = 0; step < MAX_TOOL_ITERATIONS; step++) {
      const { response, modelUsed: stepModel } = await generateWithFailover({
        aiClient,
        contents,
        systemInstruction,
        now,
        callTimeoutMs,
      });
      modelUsed = stepModel;

      const pendingCalls = extractFunctionCalls(response);

      if (pendingCalls.length === 0) {
        finalReply = extractResponseText(response);
        break;
      }

      // Preserve exact candidate content when present (including Gemini thought signatures)
      const candidateContent = response.candidates?.[0]?.content;
      if (
        candidateContent &&
        Array.isArray(candidateContent.parts) &&
        candidateContent.parts.length > 0
      ) {
        contents.push(candidateContent);
      } else {
        contents.push({
          role: "model",
          parts: pendingCalls.map((fc) => ({
            functionCall: {
              ...(fc.id ? { id: fc.id } : {}),
              name: fc.name ?? "",
              args: fc.args ?? {},
            },
          })),
        });
      }

      const functionResponseParts: Part[] = [];

      for (const call of pendingCalls) {
        const toolName = call.name ?? "unknown";
        const toolArgs = (call.args ?? {}) as Record<string, unknown>;
        const { result, isEscalation } = executeStoreTool(store, toolName, toolArgs);

        if (isEscalation) {
          handedOff = true;
        }

        toolCalls.push({
          name: toolName,
          args: toolArgs,
          result,
        });

        functionResponseParts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: toolName,
            response: result,
          },
        });
      }

      contents.push({
        role: "user",
        parts: functionResponseParts,
      });
    }
  } catch (err) {
    // Never expose raw JSON / SDK errors to the customer bubble
    const debugError = summarizeDebugError(err);
    console.error("[SalesAgent] Model chain failed:", debugError);
    return {
      reply: buildPoliteFallbackReply(store),
      toolCalls,
      handedOff,
      modelUsed: "fallback-error",
      debugError,
    };
  }

  if (!finalReply) {
    finalReply = handedOff
      ? `تم تحويل طلبك لمستشار المبيعات المختص في *${store.config.storeName}*، وسيتواصل معك قريباً. كما يمكنك التواصل مباشرة على ${store.config.humanHandoffPhone}.`
      : `أهلاً بك في *${store.config.storeName}*! هل تود الاستفسار عن قطعة معينة أو تصفح تشكيلة الذهب المتوفرة لدينا؟`;
  }

  appendSessionTurn(
    store.config.slug,
    sessionId,
    { userText: trimmedMessage, modelText: finalReply },
    now
  );

  return {
    reply: finalReply,
    toolCalls,
    handedOff,
    modelUsed,
  };
}

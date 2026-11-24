import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach } from "node:test";
import { NextRequest } from "next/server";
import {
  escalateToHuman,
  getProductByCode,
  getStorePolicy,
  loadStore,
  searchProducts,
  StoreNotFoundError,
} from "../src/lib/store";
import {
  clearSessionHistory,
  getCandidateModelsForTurn,
  getModelCooldownExpiry,
  getSessionTurns,
  MAX_SESSION_TURNS,
  MODEL_COOLDOWN_MS,
  resetModelCooldowns,
  runSalesAgent,
  SESSION_TTL_MS,
  type GenAIClientLike,
} from "../src/lib/agent";
import {
  extractWhatsAppMessages,
  handleWhatsAppWebhookPost,
  resetWebhookDeduplication,
} from "../src/lib/whatsapp-webhook";
import { GET as webhookGET } from "../src/app/api/webhook/whatsapp/route";
import {
  importFromUrl,
  parseProductPageHtml,
  parseSitemapXml,
} from "../scripts/import-store.mjs";
import type { Product } from "../src/lib/types";

describe("1. Multi-Store Loader & Zero-Hallucination Tool Functions", () => {
  it("loads and validates demo-jewelry config and 10 realistic catalog items", () => {
    const store = loadStore("demo-jewelry", { bypassCache: true });
    assert.equal(store.config.slug, "demo-jewelry");
    assert.equal(store.config.currency, "SAR");
    assert.equal(store.catalog.length, 10);

    const outOfStockItems = store.catalog.filter((p) => !p.inStock);
    assert.ok(outOfStockItems.length >= 2, "Expected at least 2 out-of-stock products");

    for (const item of store.catalog) {
      assert.ok(item.price >= 450 && item.price <= 3200, `Price out of range: ${item.price}`);
    }
  });

  it("rejects invalid or non-existent store slugs safely", () => {
    assert.throws(() => loadStore("../outside"), StoreNotFoundError);
    assert.throws(() => loadStore("non-existent-store"), StoreNotFoundError);
  });

  it("get_product_by_code is case-insensitive and handles missing codes", () => {
    const store = loadStore("demo-jewelry");

    const upper = getProductByCode(store, { code: "B039" });
    const lower = getProductByCode(store, { code: "b039" });
    assert.equal(upper.found, true);
    assert.equal(lower.found, true);
    assert.equal((lower.product as Product).code, "B039");
    assert.equal((lower.product as Product).price, 1290);
    assert.equal((lower.product as Product).inStock, true);

    const missing = getProductByCode(store, { code: "Z999" });
    assert.equal(missing.found, false);
  });

  it("search_products supports Arabic queries, karat filtering, maxPrice, and inStockOnly", () => {
    const store = loadStore("demo-jewelry");

    const rings21Under1500 = searchProducts(store, {
      query: "خواتم عيار 21",
      maxPrice: 1500,
      inStockOnly: true,
    });

    const products = rings21Under1500.products as Product[];
    assert.ok(products.length >= 2, "Should find 21K rings under 1500 SAR");
    for (const p of products) {
      assert.equal(p.inStock, true);
      assert.equal(p.karat, "21K");
      assert.ok(p.price <= 1500);
      assert.ok(p.category.includes("خواتم"));
    }

    const allNecklacesInStock = searchProducts(store, {
      category: "عقود",
      inStockOnly: true,
    });
    const necklaceCodes = (allNecklacesInStock.products as Product[]).map((p) => p.code);
    assert.ok(!necklaceCodes.includes("N219"), "Out-of-stock N219 must be excluded");
  });

  it("get_store_policy returns accurate shipping, installments (Tabby/Tamara), returns, and working hours", () => {
    const store = loadStore("demo-jewelry");

    const installments = getStorePolicy(store, { topic: "installments" });
    assert.equal(installments.topic, "installments");
    assert.ok(JSON.stringify(installments.installments).includes("Tabby"));
    assert.ok(JSON.stringify(installments.installments).includes("Tamara"));

    const shipping = getStorePolicy(store, { topic: "shipping" });
    assert.equal(shipping.topic, "shipping");
    assert.equal(shipping.shippingPolicy, store.config.shippingPolicy);

    const hours = getStorePolicy(store, { topic: "working_hours" });
    assert.equal(hours.workingHours, store.config.workingHours);
  });
});

describe("2. Out-of-Stock Detection & Human Escalation Tool Output", () => {
  it("flags out-of-stock products clearly in get_product_by_code", () => {
    const store = loadStore("demo-jewelry");
    const outOfStockLookup = getProductByCode(store, { code: "B042" });

    assert.equal(outOfStockLookup.found, true);
    assert.equal((outOfStockLookup.product as Product).inStock, false);
    assert.ok(String(outOfStockLookup.stockNote).includes("غير متوفرة"));
  });

  it("escalate_to_human returns structured handoff payload with store phone & summary", () => {
    const store = loadStore("demo-jewelry");
    const escalation = escalateToHuman(store, {
      reason: "custom_sizing_and_discount",
      customerSummary: "العميل يطلب تفصيل مقاس خاص مع خصم إضافي على الخاتم",
    });

    assert.equal(escalation.escalated, true);
    assert.equal(escalation.humanHandoffPhone, store.config.humanHandoffPhone);
    assert.equal(escalation.reason, "custom_sizing_and_discount");
  });
});

describe("3. Meta WhatsApp Cloud API Webhook (GET Verification & POST Deduplication)", () => {
  beforeEach(() => {
    resetWebhookDeduplication();
    clearSessionHistory();
    resetModelCooldowns();
    process.env.WHATSAPP_VERIFY_TOKEN = "test_secret_verify_token";
    process.env.WHATSAPP_ACCESS_TOKEN = "test_meta_access_token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "9988776655";
    process.env.DEFAULT_STORE_SLUG = "demo-jewelry";
  });

  it("GET /api/webhook/whatsapp returns 200 challenge on valid token and 403 on mismatch", async () => {
    const validReq = new NextRequest(
      "http://localhost:3000/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=test_secret_verify_token&hub.challenge=123456789"
    );
    const validRes = await webhookGET(validReq);
    assert.equal(validRes.status, 200);
    assert.equal(await validRes.text(), "123456789");

    const invalidReq = new NextRequest(
      "http://localhost:3000/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=123456789"
    );
    const invalidRes = await webhookGET(invalidReq);
    assert.equal(invalidRes.status, 403);
  });

  it("extracts Meta webhook messages, suppresses duplicate message.id retries, and sends Graph API reply", async () => {
    const sampleMetaPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "9988776655" },
                messages: [
                  {
                    from: "966501112233",
                    id: "wamid.HBgMOTY2NTAxMTEyMjMzFQIAEhggAA==",
                    timestamp: "1710000000",
                    type: "text",
                    text: { body: "بكم قطعة B039؟" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const extracted = extractWhatsAppMessages(sampleMetaPayload);
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].from, "966501112233");
    assert.equal(extracted[0].textBody, "بكم قطعة B039؟");

    let callIndex = 0;
    const mockAiClient: GenAIClientLike = {
      models: {
        async generateContent() {
          callIndex += 1;
          if (callIndex === 1) {
            return {
              functionCalls: [{ id: "c1", name: "get_product_by_code", args: { code: "B039" } }],
            };
          }
          return {
            text: "يا هلا بك! قطعة *B039* متوفرة بسعر *1290 ريال*: https://salla.sa/ruwaa-jewelry/bracelet-b039",
          };
        },
      },
    };

    const outboundCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      outboundCalls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ messages: [{ id: "out_1" }] }), { status: 200 });
    };

    const firstRun = await handleWhatsAppWebhookPost(sampleMetaPayload, {
      aiClient: mockAiClient,
      fetchImpl: mockFetch,
    });
    assert.equal(firstRun.processed, 1);
    assert.equal(firstRun.duplicatesIgnored, 0);
    assert.equal(outboundCalls.length, 1);
    assert.equal(
      outboundCalls[0].url,
      "https://graph.facebook.com/v21.0/9988776655/messages"
    );
    assert.equal(outboundCalls[0].body.to, "966501112233");

    const retryRun = await handleWhatsAppWebhookPost(sampleMetaPayload, {
      aiClient: mockAiClient,
      fetchImpl: mockFetch,
    });
    assert.equal(retryRun.processed, 0);
    assert.equal(retryRun.duplicatesIgnored, 1);
    assert.equal(outboundCalls.length, 1, "Duplicate message.id must not re-send Graph API reply");
  });

  it("handles non-text WhatsApp messages (e.g., audio/image) gracefully", async () => {
    const imagePayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "966509998877",
                    id: "wamid.IMAGE_MSG_1",
                    type: "image",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const sentBodies: string[] = [];
    const mockFetch: typeof fetch = async (_input, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}"));
      sentBodies.push(parsed.text?.body ?? "");
      return new Response("{}", { status: 200 });
    };

    const res = await handleWhatsAppWebhookPost(imagePayload, { fetchImpl: mockFetch });
    assert.equal(res.processed, 1);
    assert.equal(sentBodies.length, 1);
    assert.ok(sentBodies[0].includes("الرسائل النصية"));
  });
});

describe("4. Agent Tool-Loop Execution, Multi-Model Failover & Session Memory", () => {
  beforeEach(() => {
    clearSessionHistory();
    resetModelCooldowns();
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_FALLBACK_MODELS;
    delete process.env.GEMINI_CALL_TIMEOUT_MS;
  });

  it("executes multi-step tool loop for out-of-stock item -> alternative search -> reply", async () => {
    let turnStep = 0;
    const mockClient: GenAIClientLike = {
      models: {
        async generateContent({ contents, config }) {
          assert.deepEqual(
            (config as Record<string, unknown>)?.thinkingConfig,
            { thinkingBudget: 0 },
            "Should pass thinkingConfig: { thinkingBudget: 0 } by default"
          );
          turnStep += 1;
          if (turnStep === 1) {
            return {
              functionCalls: [{ id: "tc_1", name: "get_product_by_code", args: { code: "B042" } }],
            };
          }
          if (turnStep === 2) {
            const lastMsg = contents[contents.length - 1];
            const fnResp = lastMsg.parts?.[0]?.functionResponse?.response as Record<
              string,
              unknown
            >;
            assert.equal((fnResp.product as Product).inStock, false);

            return {
              functionCalls: [
                {
                  id: "tc_2",
                  name: "search_products",
                  args: { category: "أساور", inStockOnly: true },
                },
              ],
            };
          }
          return {
            text: "حياك الله! سوار *B042* غير متوفر حالياً، لكن نرشح لك سوار *B039* المتوفر بسعر *1290 ريال*: https://salla.sa/ruwaa-jewelry/bracelet-b039",
          };
        },
      },
    };

    const result = await runSalesAgent({
      storeSlug: "demo-jewelry",
      sessionId: "sim-1",
      message: "بكم قطعة B042 وهل متوفرة؟",
      client: mockClient,
    });

    assert.equal(result.handedOff, false);
    assert.equal(result.modelUsed, "gemini-3.5-flash-lite");
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, "get_product_by_code");
    assert.equal(result.toolCalls[1].name, "search_products");
    assert.ok(result.reply.includes("https://salla.sa/ruwaa-jewelry/bracelet-b039"));
  });

  it("immediately fails over on 503 UNAVAILABLE, places primary model in 5-minute cooldown, and skips it on next turn", async () => {
    const t0 = 1_750_000_000_000;
    const attemptedModels: string[] = [];

    const mockClient: GenAIClientLike = {
      models: {
        async generateContent({ model }) {
          attemptedModels.push(model);
          if (model === "gemini-3.5-flash-lite") {
            const err = Object.assign(
              new Error('{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}'),
              { status: 503 }
            );
            throw err;
          }
          return {
            text: `رد سريع من النموذج البديل *${model}*`,
          };
        },
      },
    };

    assert.equal(MODEL_COOLDOWN_MS, 300_000, "Cooldown duration must be 5 minutes (300000 ms)");

    // Turn 1 at t0: tries gemini-3.5-flash-lite -> 503 -> immediately fails over to gemini-3.1-flash-lite
    const turn1 = await runSalesAgent({
      storeSlug: "demo-jewelry",
      sessionId: "failover-sess",
      message: "السلام عليكم",
      client: mockClient,
      now: t0,
    });

    assert.equal(turn1.modelUsed, "gemini-3.1-flash-lite");
    assert.deepEqual(attemptedModels, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
    assert.equal(
      getModelCooldownExpiry("gemini-3.5-flash-lite", t0 + 120_000),
      t0 + MODEL_COOLDOWN_MS
    );

    // Turn 2 at t0 + 2 minutes (still within 5-minute cooldown): skips gemini-3.5-flash-lite completely!
    attemptedModels.length = 0;
    const turn2 = await runSalesAgent({
      storeSlug: "demo-jewelry",
      sessionId: "failover-sess",
      message: "شكراً لكم",
      client: mockClient,
      now: t0 + 120_000,
    });

    assert.equal(turn2.modelUsed, "gemini-3.1-flash-lite");
    assert.deepEqual(
      attemptedModels,
      ["gemini-3.1-flash-lite"],
      "Cooling-down model must be skipped during 5-minute cooldown window"
    );

    // After 5-minute cooldown expires, gemini-3.5-flash-lite is eligible again
    const candidatesAfterExpiry = getCandidateModelsForTurn(t0 + MODEL_COOLDOWN_MS + 1);
    assert.equal(candidatesAfterExpiry[0], "gemini-3.5-flash-lite");
  });

  it("aborts a hanging primary model on GEMINI_CALL_TIMEOUT_MS, marks 5m cooldown, and fails over quickly", async () => {
    process.env.GEMINI_CALL_TIMEOUT_MS = "45";
    const t0 = 1_760_000_000_000;
    const attemptedModels: string[] = [];
    let abortSignalFired = false;

    const hangingThenFastClient: GenAIClientLike = {
      models: {
        async generateContent({ model, config }) {
          attemptedModels.push(model);
          if (model === "gemini-3.5-flash-lite") {
            const signal = (config as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            return await new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                abortSignalFired = true;
                reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
              });
            });
          }
          return {
            text: "تم الرد فوراً من النموذج الثاني بدون تعليق!",
          };
        },
      },
    };

    const startWall = Date.now();
    const res = await runSalesAgent({
      storeSlug: "demo-jewelry",
      sessionId: "timeout-sess",
      message: "هل المحل مفتوح؟",
      client: hangingThenFastClient,
      now: t0,
    });
    const elapsedMs = Date.now() - startWall;

    assert.equal(res.modelUsed, "gemini-3.1-flash-lite");
    assert.equal(abortSignalFired, true, "AbortSignal should fire when per-call timeout expires");
    assert.deepEqual(attemptedModels, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
    assert.ok(elapsedMs < 1000, `Expected fast failover under 1000ms, took ${elapsedMs}ms`);
    assert.equal(
      getModelCooldownExpiry("gemini-3.5-flash-lite", t0 + 60_000),
      t0 + MODEL_COOLDOWN_MS,
      "Timed-out model should be placed in 5-minute cooldown"
    );
  });

  it("retries once without thinkingConfig if a model rejects thinkingConfig with HTTP 400", async () => {
    const configsSeen: Array<Record<string, unknown>> = [];
    const mockClient: GenAIClientLike = {
      models: {
        async generateContent({ config }) {
          const cfg = (config ?? {}) as Record<string, unknown>;
          configsSeen.push(cfg);
          if (cfg.thinkingConfig) {
            throw Object.assign(
              new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"thinkingConfig is not supported for this model"}}'),
              { status: 400 }
            );
          }
          return { text: "تم الرد بنجاح بعد إعادة المحاولة بدون thinkingConfig" };
        },
      },
    };

    const res = await runSalesAgent({
      storeSlug: "demo-jewelry",
      sessionId: "no-thinking-support",
      message: "مرحبا",
      client: mockClient,
    });

    assert.equal(res.modelUsed, "gemini-3.5-flash-lite");
    assert.equal(configsSeen.length, 2);
    assert.deepEqual(configsSeen[0].thinkingConfig, { thinkingBudget: 0 });
    assert.equal(configsSeen[1].thinkingConfig, undefined);
  });

  it("picks the model with earliest expiring cooldown when ALL models are in cooldown", async () => {
    process.env.GEMINI_MODEL = "gemini-3.7-flash";
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash";

    const failOnceClient: GenAIClientLike = {
      models: {
        async generateContent() {
          throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
        },
      },
    };

    // Put gemini-3.7-flash into cooldown at t=1000, and gemini-3.6-flash at t=5000
    resetModelCooldowns();
    try {
      await failOnceClient.models.generateContent({ model: "noop", contents: [] });
    } catch {
      // ignore
    }
    await runSalesAgent({
      storeSlug: "demo-jewelry",
      sessionId: "earliest-cd",
      message: "اختبار",
      client: {
        models: {
          async generateContent({ model }) {
            if (model === "gemini-3.7-flash") {
              throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
            }
            return { text: "ok" };
          },
        },
      },
      now: 1_000,
    });
    // Now put gemini-3.6-flash into cooldown at t=5000 (expires at 65000, whereas 3.7 expires at 61000)
    await runSalesAgent({
      storeSlug: "demo-jewelry",
      sessionId: "earliest-cd",
      message: "اختبار 2",
      client: failOnceClient,
      now: 5_000,
    });

    // At t=10000 both are in cooldown; earliest expiring is gemini-3.7-flash (61000 < 65000)
    assert.deepEqual(getCandidateModelsForTurn(10_000), ["gemini-3.7-flash"]);
  });

  it("never leaks raw JSON errors to the customer bubble when all models fail", async () => {
    process.env.GEMINI_MODEL = "gemini-3.7-flash";
    process.env.GEMINI_FALLBACK_MODELS = "gemini-3.6-flash";

    const failingClient: GenAIClientLike = {
      models: {
        async generateContent() {
          throw new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}');
        },
      },
    };

    const res = await runSalesAgent({
      storeSlug: "demo-jewelry",
      sessionId: "all-down",
      message: "بكم B039؟",
      client: failingClient,
    });

    assert.ok(!res.reply.includes("RESOURCE_EXHAUSTED"), "Customer bubble must not contain raw JSON error");
    assert.ok(res.reply.includes("+966550123456"), "Fallback reply should politely offer handoff phone");
    assert.ok(res.debugError?.includes("RESOURCE_EXHAUSTED"), "Developer Inspector should receive debugError");
  });

  it("sets handedOff: true when escalate_to_human tool is invoked", async () => {
    let step = 0;
    const mockClient: GenAIClientLike = {
      models: {
        async generateContent() {
          step += 1;
          if (step === 1) {
            return {
              functionCalls: [
                {
                  id: "esc_1",
                  name: "escalate_to_human",
                  args: {
                    reason: "custom_size_and_discount",
                    customerSummary: "العميل يطلب تفصيل مقاس خاص وخصم",
                  },
                },
              ],
            };
          }
          return {
            text: "أبشر بعزك! تم تحويل طلبك لمستشار المبيعات المختص للتفصيل الخاص على الرقم +966550123456.",
          };
        },
      },
    };

    const result = await runSalesAgent({
      storeSlug: "demo-jewelry",
      sessionId: "sim-handoff",
      message: "أبغى تفصيل مقاس خاص وخصم",
      client: mockClient,
    });

    assert.equal(result.handedOff, true);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "escalate_to_human");
  });

  it("enforces 12-turn cap and 30-minute TTL on in-memory session history", async () => {
    const baseTime = 1_700_000_000_000;
    const mockClient: GenAIClientLike = {
      models: {
        async generateContent() {
          return { text: "رد تجريبي" };
        },
      },
    };

    for (let i = 1; i <= 15; i++) {
      await runSalesAgent({
        storeSlug: "demo-jewelry",
        sessionId: "ttl-session",
        message: `رسالة رقم ${i}`,
        client: mockClient,
        now: baseTime + i * 1000,
      });
    }

    const activeTurns = getSessionTurns("demo-jewelry", "ttl-session", baseTime + 20_000);
    assert.equal(activeTurns.length, MAX_SESSION_TURNS);
    assert.equal(activeTurns[0].userText, "رسالة رقم 4");
    assert.equal(activeTurns[11].userText, "رسالة رقم 15");

    const expiredTurns = getSessionTurns(
      "demo-jewelry",
      "ttl-session",
      baseTime + 20_000 + SESSION_TTL_MS + 1000
    );
    assert.equal(expiredTurns.length, 0);
  });
});

describe("5. Store Importer CLI (CSV, Sitemap XML & Schema.org JSON-LD Product Parsing)", () => {
  it("extracts Salla & Zid product URLs and nested product sitemaps from sitemap.xml", () => {
    const sampleIndexXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://gold-demo.sa/sitemap_pages.xml</loc></sitemap>
        <sitemap><loc>https://gold-demo.sa/sitemap_products.xml</loc></sitemap>
      </sitemapindex>`;

    const indexParsed = parseSitemapXml(sampleIndexXml, "https://gold-demo.sa");
    assert.deepEqual(indexParsed.nestedProductSitemaps, [
      "https://gold-demo.sa/sitemap_products.xml",
    ]);

    const sampleProductSitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://gold-demo.sa/</loc></url>
        <url><loc>https://gold-demo.sa/pages/privacy</loc></url>
        <url><loc>https://gold-demo.sa/gold-bracelet-b039/p19283746</loc></url>
        <url><loc>https://gold-demo.sa/products/21k-bahraini-ring-r112</loc></url>
      </urlset>`;

    const urlsetParsed = parseSitemapXml(sampleProductSitemapXml, "https://gold-demo.sa");
    assert.deepEqual(urlsetParsed.productUrls, [
      "https://gold-demo.sa/gold-bracelet-b039/p19283746",
      "https://gold-demo.sa/products/21k-bahraini-ring-r112",
    ]);
  });

  it("parses Schema.org JSON-LD Product, extracts [B039] code, karat, weight, and stock status", () => {
    const productHtml = `<!doctype html>
      <html lang="ar">
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org/",
            "@type": "Product",
            "name": "سوار ذهب إيطالي عيار 18 وزن 3.45 جرام [B039]",
            "description": "سوار ناعم عيار 18 مناسب للهدايا",
            "category": "أساور ذهب",
            "offers": {
              "@type": "Offer",
              "priceCurrency": "SAR",
              "price": "1290.00",
              "availability": "https://schema.org/InStock"
            }
          }
        </script>
      </head>
      <body><h1>سوار ذهب [B039]</h1></body>
      </html>`;

    const parsed = parseProductPageHtml(
      productHtml,
      "https://gold-demo.sa/gold-bracelet/p19283746",
      1
    );
    assert.ok(parsed);
    assert.equal(parsed.code, "B039");
    assert.equal(parsed.price, 1290);
    assert.equal(parsed.inStock, true);
    assert.equal(parsed.karat, "18K");
    assert.equal(parsed.weightGrams, 3.45);
  });

  it("falls back to sitemap.xml when Salla/Zid homepage renders 0 client-side products", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://client-salla.sa/") {
        return new Response(
          `<html>
            <head><meta property="og:site_name" content="مجوهرات الأصالة" /></head>
            <body>
              <footer>شحن مجاني للطلبات فوق 999 ريال عبر سمسا • متوفر تابي وتمارا • واتساب: <a href="https://wa.me/966551234567">تواصل</a></footer>
              <div id="salla-client-grid"></div>
            </body>
          </html>`,
          { status: 200 }
        );
      }
      if (url === "https://client-salla.sa/sitemap.xml") {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
           <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
             <url><loc>https://client-salla.sa/ring-r201/p55443322</loc></url>
           </urlset>`,
          { status: 200 }
        );
      }
      if (url === "https://client-salla.sa/ring-r201/p55443322") {
        return new Response(
          `<html><head>
            <script type="application/ld+json">
              {"@type":"Product","sku":"R201","name":"خاتم ذهب عيار 21","offers":{"price":"1420","availability":"https://schema.org/OutOfStock"}}
            </script>
          </head><body></body></html>`,
          { status: 200 }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const imported = await importFromUrl("https://client-salla.sa/", {
      limit: 5,
      fetchImpl: mockFetch,
    });

    assert.equal(imported.metadata?.detectedStoreName, "مجوهرات الأصالة");
    assert.equal(imported.metadata?.detectedPhone, "+966551234567");
    assert.deepEqual(imported.metadata?.installments.providers, ["Tabby", "Tamara"]);
    assert.equal(imported.products.length, 1);
    assert.equal(imported.products[0].code, "R201");
    assert.equal(imported.products[0].price, 1420);
    assert.equal(imported.products[0].inStock, false);
  });

  it("scaffolds a valid multi-store folder from a local CSV and passes Zod validation", () => {
    const tmpCsv = path.join(os.tmpdir(), `sample-store-${Date.now()}.csv`);
    const testSlug = "tmp-csv-jewelry-test";
    const targetStoreDir = path.join(process.cwd(), "src", "stores", testSlug);

    const csvContent = [
      "code,name,category,karat,weightGrams,price,inStock,url,description",
      'K901,"خاتم ذهب عيار 21 كلاسيك","خواتم",21K,2.8,1190,true,https://example.sa/p/k901,"خاتم ذهب صافي عيار 21"',
      'K902,"عقد ذهب عيار 18 ناعم","عقود",18K,3.1,1050,false,https://example.sa/p/k902,"عقد ناعم للهدايا"',
    ].join("\n");

    fs.writeFileSync(tmpCsv, csvContent, "utf-8");

    try {
      execFileSync(
        process.execPath,
        ["scripts/import-store.mjs", tmpCsv, "--slug", testSlug, "--name", "متجر اختبار"],
        { cwd: process.cwd(), stdio: "pipe" }
      );

      const loaded = loadStore(testSlug, { bypassCache: true });
      assert.equal(loaded.config.storeName, "متجر اختبار");
      assert.equal(loaded.catalog.length, 2);
      assert.equal(loaded.catalog[0].code, "K901");
      assert.equal(loaded.catalog[1].inStock, false);
    } finally {
      fs.rmSync(tmpCsv, { force: true });
      fs.rmSync(targetStoreDir, { recursive: true, force: true });
    }
  });
});

# WA Sales Concierge (`wa-sales-concierge`)

A clean, production-ready, multi-store **Zero-Hallucination AI WhatsApp Sales Concierge** built with **Next.js (App Router, TypeScript, Tailwind CSS)** and the official **`@google/genai`** SDK for Saudi & GCC e-commerce stores (Salla / Zid).

---

## Key Capabilities

1. **Multi-Store Drop-in Architecture (`src/stores/<slug>/`)**
   - Onboard any new store by adding `config.json` + `catalog.json` under `src/stores/<slug>/` without modifying core engine code.
   - Includes a ready-to-test Saudi gold & jewelry store (`src/stores/demo-jewelry/`) with 10 products (`460–3,150 SAR`, 18K/21K, including code `B039` and out-of-stock items `B042` & `N219`).
   - Includes `scripts/import-store.mjs` to scaffold a new store in seconds from a public Salla/Zid URL (with automatic `sitemap.xml` product discovery + JSON-LD `Product` scraping + footer Tabby/Tamara/WhatsApp metadata detection) or local CSV.

2. **Zero-Hallucination AI Sales Engine + Low-Latency Multi-Model Failover (`src/lib/agent.ts`)**
   - Primary model defaults to fast `gemini-3.5-flash-lite` (`thinkingBudget: 0`) with instant failover across `GEMINI_FALLBACK_MODELS` (`gemini-3.1-flash-lite,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash`), a strict **8-second per-call timeout** (`GEMINI_CALL_TIMEOUT_MS=8000`), and an in-memory **5-minute cooldown map** on timeouts/`503`/`429`/`404`/`UNAVAILABLE`/`RESOURCE_EXHAUSTED`/`NOT_FOUND`.
   - Uses strict **Gemini Function Calling** (`get_product_by_code`, `search_products`, `get_store_policy`, `escalate_to_human`) so prices, weights, karat, stock availability, URLs, and Tabby/Tamara policies are never guessed.
   - Replies in warm, concise Saudi white Arabic (`لهجة سعودية بيضاء راقية`) using native WhatsApp `*bold*` formatting, and never leaks raw SDK/JSON errors to the customer chat bubble.
   - Lightweight in-memory multi-turn session store (`storeSlug + sessionId`, last 12 turns, 30-minute auto-TTL).

3. **Channel 1: Interactive RTL WhatsApp Web Simulator (`/demo/[slug]`)**
   - Mobile-first RTL WhatsApp UI at `/demo/demo-jewelry` with quick-test prompt chips, native `*bold*` + clickable URL rendering, human handoff badge, and a collapsible **Developer Inspector** (`?debug=1` or header button) showing `modelUsed`, tool call arguments/results, and `debugError` diagnostics.

4. **Channel 2: Meta WhatsApp Cloud API Webhook (`/api/webhook/whatsapp`)**
   - `GET`: Verifies `hub.mode === "subscribe"` and `hub.verify_token`.
   - `POST`: Validates incoming payloads, deduplicates `message.id` retries in memory, handles non-text media politely, routes messages through `runSalesAgent()`, and sends replies via Meta Graph API `v21.0`.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env.local
# Edit .env.local and set GEMINI_API_KEY=your_key_here

# 3. Start development server
npm run dev
```

Open:
- **Store Hub:** `http://localhost:3000`
- **WhatsApp Simulator:** `http://localhost:3000/demo/demo-jewelry`
- **Simulator + Developer Inspector:** `http://localhost:3000/demo/demo-jewelry?debug=1`

---

## Verification & Automated Tests

The test suite runs **100% offline** using Node's native test runner (`node --test`) and a mocked Gemini client:

```bash
# Run offline unit & integration tests
npm test

# Run strict TypeScript check
npx tsc --noEmit

# Build production bundle
npm run build
```

---

## Onboarding a New Salla / Zid Store

```bash
# From a public Salla or Zid store URL (auto-crawls homepage metadata + sitemap.xml up to --limit):
npm run import-store -- https://salla.sa/your-store --slug my-store --limit 15

# Or from an exported products CSV file:
npm run import-store -- ./products.csv --slug my-store --name "مجوهرات النخبة"
```

Then review `src/stores/my-store/config.json` and `catalog.json`, and open `http://localhost:3000/demo/my-store`.

---

## Meta WhatsApp Cloud API Setup (`/api/webhook/whatsapp`)

1. Create a **Meta Business App** at [developers.facebook.com](https://developers.facebook.com/) and add the **WhatsApp** product.
2. Copy your **Phone Number ID** and **Access Token** into `.env.local` (or your hosting provider's environment settings):
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_VERIFY_TOKEN` (any strong secret string you choose)
   - `DEFAULT_STORE_SLUG=demo-jewelry`
3. Expose your Next.js deployment over HTTPS (e.g., Vercel, Cloud Run, or `ngrok http 3000` for local testing).
4. In **Meta App Dashboard → WhatsApp → Configuration → Webhook**:
   - **Callback URL:** `https://<your-domain>/api/webhook/whatsapp`
   - **Verify Token:** exact value of `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and Save**, then subscribe to the **`messages`** webhook field.

<!-- deploy-trigger: 2026-11-25 -->

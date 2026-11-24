import fs from "node:fs";
import path from "node:path";
import {
  CatalogSchema,
  type EscalateToHumanArgs,
  type GetProductByCodeArgs,
  type GetStorePolicyArgs,
  type LoadedStore,
  type Product,
  type SearchProductsArgs,
  type StoreConfig,
  StoreConfigSchema,
} from "./types";

const STORES_DIR = path.join(process.cwd(), "src", "stores");
const storeCache = new Map<string, LoadedStore>();

export class StoreNotFoundError extends Error {
  constructor(slug: string) {
    super(`Store "${slug}" was not found under src/stores/${slug}/`);
    this.name = "StoreNotFoundError";
  }
}

function validateSlugFormat(slug: string): string {
  const clean = slug.trim();
  if (!/^[a-z0-9-]+$/i.test(clean)) {
    throw new StoreNotFoundError(slug);
  }
  return clean;
}

/**
 * Lists all valid store slugs available under `src/stores/`.
 */
export function listStoreSlugs(): string[] {
  if (!fs.existsSync(STORES_DIR)) return [];
  return fs
    .readdirSync(STORES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9-]+$/i.test(entry.name))
    .filter((entry) => {
      const dir = path.join(STORES_DIR, entry.name);
      return (
        fs.existsSync(path.join(dir, "config.json")) &&
        fs.existsSync(path.join(dir, "catalog.json"))
      );
    })
    .map((entry) => entry.name);
}

/**
 * Loads and strictly validates `config.json` and `catalog.json` for a store slug.
 */
export function loadStore(slug: string, options?: { bypassCache?: boolean }): LoadedStore {
  const cleanSlug = validateSlugFormat(slug);
  if (!options?.bypassCache && storeCache.has(cleanSlug)) {
    return storeCache.get(cleanSlug)!;
  }

  const storeDir = path.join(STORES_DIR, cleanSlug);
  const configPath = path.join(storeDir, "config.json");
  const catalogPath = path.join(storeDir, "catalog.json");

  if (!fs.existsSync(configPath) || !fs.existsSync(catalogPath)) {
    throw new StoreNotFoundError(cleanSlug);
  }

  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const rawCatalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));

  const config = StoreConfigSchema.parse(rawConfig);
  const catalog = CatalogSchema.parse(rawCatalog);

  const loaded: LoadedStore = { config, catalog };
  storeCache.set(cleanSlug, loaded);
  return loaded;
}

/**
 * Normalizes Arabic & English text for resilient search across singular/plural & spelling variants.
 */
export function normalizeSearchText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // strip tashkeel & tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[()[\]{}،,.;:!?'"«»\-_/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Expands common Saudi jewelry Arabic/English synonyms so singular/plural queries match seamlessly.
 */
const SYNONYM_GROUPS: string[][] = [
  ["خاتم", "خواتم", "دبله", "دبل", "محبس", "ring", "rings"],
  ["سوار", "اسواره", "اساور", "انسيال", "غويشه", "بناجر", "bracelet", "bracelets"],
  ["عقد", "عقود", "سلسال", "سلاسل", "سبحه", "قلاده", "تعليقه", "تشوكر", "necklace", "necklaces"],
  ["حلق", "حلقان", "اقراط", "قرط", "تركيه", "earring", "earrings"],
  ["طقم", "اطقم", "شبكه", "set", "sets"],
  ["21k", "21", "عيار 21"],
  ["18k", "18", "عيار 18"],
  ["24k", "24", "عيار 24"],
];

function expandTokenVariants(token: string): string[] {
  const norm = normalizeSearchText(token);
  if (!norm) return [];
  const variants = new Set<string>([norm]);
  // Strip Arabic definite article "ال"
  if (norm.startsWith("ال") && norm.length > 3) {
    variants.add(norm.slice(2));
  }
  for (const group of SYNONYM_GROUPS) {
    const normalizedGroup = group.map(normalizeSearchText);
    const hasMatch = [...variants].some((v) => normalizedGroup.includes(v));
    if (hasMatch) {
      for (const item of normalizedGroup) {
        variants.add(item);
      }
    }
  }
  return [...variants];
}

const STOP_WORDS = new Set(
  [
    "في",
    "من",
    "على",
    "الي",
    "عن",
    "مع",
    "او",
    "هل",
    "عندكم",
    "عندي",
    "ابغي",
    "ابي",
    "اريد",
    "بكم",
    "كم",
    "سعر",
    "تحت",
    "فوق",
    "اقل",
    "ريال",
    "سعودي",
    "متوفر",
    "متوفره",
    "موجود",
    "قطعه",
    "ذهب",
    "عيار",
    "sar",
    "in",
    "under",
    "for",
    "the",
    "and",
  ].map(normalizeSearchText)
);

/**
 * Tool 1: `get_product_by_code`
 * Case-insensitive exact or partial lookup by product code (e.g., `B039` or `b039`).
 */
export function getProductByCode(
  store: LoadedStore,
  args: GetProductByCodeArgs
): Record<string, unknown> {
  const rawCode = (args.code ?? "").trim();
  if (!rawCode) {
    return {
      found: false,
      error: "يرجى تزويد كود القطعة للبحث عنها.",
    };
  }

  const target = rawCode.toLowerCase();
  const exact = store.catalog.find((p) => p.code.toLowerCase() === target);

  if (exact) {
    return {
      found: true,
      matchType: "exact",
      currency: store.config.currency,
      product: exact,
      stockNote: exact.inStock
        ? "متوفرة حالياً وجاهزة للشحن الفوري"
        : "غير متوفرة حالياً (نفدت الكمية) — استخدم أداة search_products لاقتراح بديل متوفر من نفس الفئة",
    };
  }

  const partialMatches = store.catalog.filter(
    (p) =>
      p.code.toLowerCase().includes(target) || target.includes(p.code.toLowerCase())
  );

  if (partialMatches.length > 0) {
    return {
      found: true,
      matchType: "partial",
      currency: store.config.currency,
      product: partialMatches[0],
      matches: partialMatches,
    };
  }

  return {
    found: false,
    requestedCode: rawCode,
    message: `لا توجد قطعة مسجلة بالكود "${rawCode}" في كتالوج المتجر.`,
  };
}

/**
 * Tool 2: `search_products`
 * Searches Arabic/English product names, categories, karat, and descriptions with strict price/stock filters.
 */
export function searchProducts(
  store: LoadedStore,
  args: SearchProductsArgs
): Record<string, unknown> {
  const { query = "", maxPrice, category, inStockOnly = false } = args;

  let candidates = store.catalog.filter((product) => {
    if (inStockOnly && !product.inStock) {
      return false;
    }
    if (typeof maxPrice === "number" && !Number.isNaN(maxPrice) && product.price > maxPrice) {
      return false;
    }
    if (category && category.trim()) {
      const catVariants = expandTokenVariants(category);
      const productCatNorm = normalizeSearchText(
        `${product.category} ${product.name}`
      );
      const matchesCat = catVariants.some((variant) => productCatNorm.includes(variant));
      if (!matchesCat) {
        return false;
      }
    }
    return true;
  });

  const normalizedQuery = normalizeSearchText(query);
  const rawTokens = normalizedQuery
    .split(" ")
    .filter((tok) => tok.length > 0 && !STOP_WORDS.has(tok));

  if (rawTokens.length > 0) {
    const scored = candidates
      .map((product) => {
        const searchableBlob = normalizeSearchText(
          [
            product.code,
            product.name,
            product.category,
            product.karat ?? "",
            product.description,
          ].join(" ")
        );

        let score = 0;
        let matchedTokens = 0;

        for (const token of rawTokens) {
          // Exact karat check so "21" doesn't accidentally match "18" and vice-versa
          if (token === "18" || token === "21" || token === "22" || token === "24") {
            const productKaratNorm = normalizeSearchText(product.karat ?? "");
            if (
              productKaratNorm.includes(token) ||
              searchableBlob.includes(`عيار ${token}`) ||
              searchableBlob.includes(`${token}k`)
            ) {
              score += 5;
              matchedTokens += 1;
            }
            continue;
          }

          const variants = expandTokenVariants(token);
          const hit = variants.some((v) => searchableBlob.includes(v));
          if (hit) {
            score += normalizeSearchText(product.name).includes(variants[0]) ? 4 : 2;
            matchedTokens += 1;
          }
        }

        // Boost in-stock items slightly when sorting
        if (product.inStock && matchedTokens > 0) {
          score += 0.5;
        }

        return { product, score, matchedTokens };
      })
      .filter((entry) => entry.matchedTokens > 0);

    // Require all specified karat constraints if present in tokens
    const karatTokens = rawTokens.filter((t) => ["18", "21", "22", "24"].includes(t));
    const filteredScored =
      karatTokens.length > 0
        ? scored.filter(({ product }) => {
            const kNorm = normalizeSearchText(`${product.karat ?? ""} ${product.name}`);
            return karatTokens.every(
              (kt) => kNorm.includes(`${kt}k`) || kNorm.includes(`عيار ${kt}`) || kNorm === kt
            );
          })
        : scored;

    // Prefer items matching the most tokens
    filteredScored.sort((a, b) => {
      if (b.matchedTokens !== a.matchedTokens) return b.matchedTokens - a.matchedTokens;
      if (b.score !== a.score) return b.score - a.score;
      return a.product.price - b.product.price;
    });

    candidates = filteredScored.map((entry) => entry.product);
  } else {
    // No text tokens (only category / maxPrice / inStockOnly filters)
    candidates.sort((a, b) => {
      if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
      return a.price - b.price;
    });
  }

  return {
    currency: store.config.currency,
    totalMatches: candidates.length,
    filtersApplied: {
      query: query || null,
      maxPrice: maxPrice ?? null,
      category: category || null,
      inStockOnly,
    },
    products: candidates.slice(0, 6),
  };
}

function formatInstallments(config: StoreConfig): unknown {
  return config.installments;
}

/**
 * Tool 3: `get_store_policy`
 * Returns exact shipping, installments (Tabby/Tamara), returns, or working hours from `config.json`.
 */
export function getStorePolicy(
  store: LoadedStore,
  args: GetStorePolicyArgs
): Record<string, unknown> {
  const rawTopic = (args.topic ?? "all").toLowerCase().trim();
  const { config } = store;

  if (
    rawTopic === "shipping" ||
    rawTopic.includes("شحن") ||
    rawTopic.includes("توصيل") ||
    rawTopic.includes("delivery")
  ) {
    return {
      topic: "shipping",
      storeName: config.storeName,
      shippingPolicy: config.shippingPolicy,
    };
  }

  if (
    rawTopic === "installments" ||
    rawTopic.includes("تقسيط") ||
    rawTopic.includes("تابي") ||
    rawTopic.includes("تمارا") ||
    rawTopic.includes("tabby") ||
    rawTopic.includes("tamara")
  ) {
    return {
      topic: "installments",
      storeName: config.storeName,
      currency: config.currency,
      installments: formatInstallments(config),
    };
  }

  if (
    rawTopic === "returns" ||
    rawTopic.includes("استرجاع") ||
    rawTopic.includes("استبدال") ||
    rawTopic.includes("return") ||
    rawTopic.includes("exchange")
  ) {
    return {
      topic: "returns",
      storeName: config.storeName,
      returnPolicy:
        config.returnPolicy ??
        "يرجى التواصل مع خدمة العملاء لمعرفة تفاصيل الاستبدال والاسترجاع حسب نوع القطعة.",
    };
  }

  if (
    rawTopic === "working_hours" ||
    rawTopic.includes("دوام") ||
    rawTopic.includes("ساعات") ||
    rawTopic.includes("hours")
  ) {
    return {
      topic: "working_hours",
      storeName: config.storeName,
      workingHours: config.workingHours,
    };
  }

  return {
    topic: "all",
    storeName: config.storeName,
    currency: config.currency,
    shippingPolicy: config.shippingPolicy,
    installments: formatInstallments(config),
    returnPolicy:
      config.returnPolicy ??
      "يرجى التواصل مع خدمة العملاء لمعرفة تفاصيل الاستبدال والاسترجاع حسب نوع القطعة.",
    workingHours: config.workingHours,
    humanHandoffPhone: config.humanHandoffPhone,
  };
}

/**
 * Tool 4: `escalate_to_human`
 * Flags the conversation for a human sales rep.
 */
export function escalateToHuman(
  store: LoadedStore,
  args: EscalateToHumanArgs
): Record<string, unknown> {
  return {
    escalated: true,
    storeName: store.config.storeName,
    humanHandoffPhone: store.config.humanHandoffPhone,
    workingHours: store.config.workingHours,
    reason: args.reason,
    customerSummary: args.customerSummary,
    note: "تم تسجيل طلب التحويل لمستشار المبيعات المختص وسيتواصل مع العميل مباشرة.",
  };
}

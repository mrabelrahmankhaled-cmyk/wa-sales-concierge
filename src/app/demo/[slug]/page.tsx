import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import WhatsAppSimulator from "@/components/WhatsAppSimulator";
import { isGeminiConfigured } from "@/lib/agent";
import { loadStore, StoreNotFoundError } from "@/lib/store";
import type { LoadedStore } from "@/lib/types";

export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  try {
    const store = loadStore(slug);
    const storeName = store.config.storeName;
    const title = `تجربة المساعد الذكي — ${storeName}`;
    const description = `جرّب مستشار المبيعات الذكي المخصص لمتجر ${storeName}: رد فوري على الأسعار وتوفر القطع وتابي وتمارا وروابط الشراء المباشرة.`;

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        locale: "ar_SA",
        type: "website",
      },
      twitter: {
        card: "summary",
        title,
        description,
      },
    };
  } catch (error) {
    if (error instanceof StoreNotFoundError) {
      return {
        title: "تجربة المساعد الذكي لمتاجر الذهب والمجوهرات",
        description:
          "جرّب مستشار المبيعات الذكي المخصص لمتاجر سلة وزد: رد فوري على الأسعار وتوفر القطع وتابي وتمارا وروابط الشراء المباشرة.",
      };
    }
    throw error;
  }
}

function cleanCategoryLabel(rawCategory: string): string {
  const stripped = rawCategory.replace(/\s*\([^)]*\)\s*/g, "").trim();
  return stripped || "قطع مميزة";
}

function isShortReadableCode(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > 10) return false;
  // Reject 9+ digit numeric IDs (with or without a leading 'P')
  if (/^[Pp]?\d{8,}$/.test(trimmed)) return false;
  return true;
}

function buildDynamicQuickPrompts(store: LoadedStore): string[] {
  const { catalog, config } = store;
  const inStockItems = catalog.filter((p) => p.inStock);
  const pool = inStockItems.length > 0 ? inStockItems : catalog;

  // 1. Prefer first in-stock product with a short readable alphanumeric code (not a 9+ digit numeric ID)
  const firstProduct =
    pool.find((p) => /^[A-Za-z]{1,4}-?\d{2,5}$/.test(p.code.trim())) ??
    pool.find((p) => isShortReadableCode(p.code)) ??
    pool[0];
  const chip1 = firstProduct
    ? `بكم قطعة ${firstProduct.code} وهل متوفرة؟`
    : "ما هي أبرز القطع المتوفرة حالياً؟";

  // 2. Category + budget derived from actual store catalog prices
  const distinctCategories = Array.from(
    new Set(pool.map((p) => cleanCategoryLabel(p.category)).filter(Boolean))
  );
  // Prefer a second category if available so Chip 1 and Chip 2 showcase variety
  const sampleCategory =
    distinctCategories.find(
      (cat) => firstProduct && cat !== cleanCategoryLabel(firstProduct.category)
    ) ??
    distinctCategories[0] ??
    "منتجات";

  const categoryItems = pool.filter(
    (p) => cleanCategoryLabel(p.category) === sampleCategory && p.price > 0
  );
  const pricedPool = (categoryItems.length > 0 ? categoryItems : pool)
    .map((p) => p.price)
    .filter((price) => price > 0)
    .sort((a, b) => a - b);

  let suggestedBudget = 1500;
  if (pricedPool.length > 0) {
    const midUpperIndex = Math.min(
      pricedPool.length - 1,
      Math.floor(pricedPool.length * 0.65)
    );
    const referencePrice = pricedPool[midUpperIndex];
    const step = referencePrice >= 500 ? 100 : 50;
    suggestedBudget = Math.max(step, Math.ceil((referencePrice * 1.05) / step) * step);
  }

  const currencyLabel =
    config.currency.trim().toUpperCase() === "SAR" ? "ريال" : config.currency.trim();
  const chip2 = `عندكم ${sampleCategory} تحت ${suggestedBudget} ${currencyLabel}؟`;

  // 3. Installments & shipping policy
  const chip3 = "هل متوفر تقسيط تابي وتمارا وكم مدة الشحن؟";

  // 4. Special gift packaging / human handoff trigger
  const chip4 = "أبغى أطلب هدية بتغليف خاص";

  return [chip1, chip2, chip3, chip4];
}

interface DemoStorePageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ debug?: string; inspector?: string }>;
}

export default async function DemoStorePage({
  params,
  searchParams,
}: DemoStorePageProps) {
  const { slug } = await params;
  const resolvedSearch = await searchParams;

  let store;
  try {
    store = loadStore(slug);
  } catch (error) {
    if (error instanceof StoreNotFoundError) {
      notFound();
    }
    throw error;
  }

  const showInspector =
    resolvedSearch.debug === "1" ||
    resolvedSearch.debug === "true" ||
    resolvedSearch.inspector === "1";
  const apiKeyConfigured = isGeminiConfigured();
  const quickPrompts = buildDynamicQuickPrompts(store);

  return (
    <WhatsAppSimulator
      storeSlug={store.config.slug}
      storeName={store.config.storeName}
      greetingMessage={store.config.greetingMessage}
      humanHandoffPhone={store.config.humanHandoffPhone}
      catalogCount={store.catalog.length}
      quickPrompts={quickPrompts}
      showInspector={showInspector}
      initialApiKeyMissing={!apiKeyConfigured}
    />
  );
}

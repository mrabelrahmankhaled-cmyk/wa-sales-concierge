#!/usr/bin/env node
/**
 * Store Onboarding CLI Helper (`scripts/import-store.mjs`)
 *
 * Scaffolds a new `src/stores/<slug>/config.json` + `catalog.json` from either:
 *   1. A public Salla / Zid / Shopify e-commerce store URL:
 *      - Scrapes homepage/footer metadata (shipping, Tabby/Tamara, return policy, WhatsApp phone)
 *      - Scrapes direct homepage products if server-rendered
 *      - Automatically falls back to `${origin}/sitemap.xml` (following nested product sitemaps
 *        like `sitemap_products.xml` / `products.xml`), filters product URLs (Salla `/p<digits>`,
 *        Zid/Shopify `/products/...`), and fetches up to `--limit` (default 15) product pages
 *        concurrently (concurrency = 4) using JSON-LD `Product` + DOM/meta fallbacks.
 *   2. A local CSV file path.
 *
 * Usage examples:
 *   node scripts/import-store.mjs https://salla.sa/some-store --slug my-gold-store --limit 15
 *   node scripts/import-store.mjs ./products.csv --slug alnoor-gold --name "مجوهرات النور"
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "ar-SA,ar;q=0.9,en;q=0.8",
};

export function parseArgs(argv) {
  const args = argv.slice(2);
  let source = "";
  let slug = "";
  let storeName = "";
  let phone = "";
  let limit = 15;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--slug" && args[i + 1]) {
      slug = args[++i];
    } else if (arg === "--name" && args[i + 1]) {
      storeName = args[++i];
    } else if (arg === "--phone" && args[i + 1]) {
      phone = args[++i];
    } else if (arg === "--limit" && args[i + 1]) {
      const parsed = Number.parseInt(args[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = parsed;
      }
    } else if (!arg.startsWith("--") && !source) {
      source = arg;
    }
  }

  return { source, slug, storeName, phone, limit };
}

export function toArabicWesternDigits(str) {
  const eastern = "٠١٢٣٤٥٦٧٨٩";
  return String(str ?? "").replace(/[٠-٩]/g, (d) => String(eastern.indexOf(d)));
}

export function parsePriceNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (!raw) return 0;
  const normalized = toArabicWesternDigits(raw)
    .replace(/,/g, "")
    .replace(/[^\d.]/g, " ")
    .trim();
  const match = normalized.match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

export function inferKarat(text) {
  const norm = toArabicWesternDigits(text);
  const match = norm.match(/(?:عيار\s*(18|21|22|24)(?!\d)|(18|21|22|24)\s*[kK]\b)/i);
  if (!match) return undefined;
  return `${match[1] || match[2]}K`;
}

export function inferWeightGrams(text) {
  const norm = toArabicWesternDigits(text);
  const match = norm.match(
    /(\d+(?:\.\d+)?)\s*(?:(?:جرام|غرام|جم)(?=$|\s|[،,.;:!؟)\]])|(?:g|gram|grams)\b)/i
  );
  return match ? Number(match[1]) : undefined;
}

/**
 * Extracts a clean customer-facing product code (like `R039`, `N039`, `B039`) from title, SKU, or URL.
 * Prioritizes short alphanumeric codes (`/\[?([A-Za-z]{1,4}-?\d{2,5})\]?/`) over internal 9-10 digit
 * Salla/Zid numeric IDs, while avoiding mistaking karat strings (`18K`, `21K`, `22K`, `24K`) for codes.
 */
export function extractProductCode({ sku, title = "", url = "", index = 1 }) {
  const isKaratToken = (val) => /^(18|21|22|24)k$/i.test(val);
  const cleanSku = toArabicWesternDigits(String(sku ?? "").trim());
  const normTitle = toArabicWesternDigits(title);

  // 1. Short alphanumeric SKU (e.g., "R039", "[B039]", "R-104" — NOT a long numeric Salla ID)
  const alphaSkuMatch = cleanSku.match(/^\[?([A-Za-z]{1,4}-?\d{2,5})\]?$/);
  if (alphaSkuMatch && !isKaratToken(alphaSkuMatch[1])) {
    return alphaSkuMatch[1].toUpperCase();
  }

  // 2. Bracketed or labeled short alphanumeric code in title (e.g., "[R039]", "(N039)", "كود B039")
  const bracketOrLabelMatch = normTitle.match(
    /(?:\[|\(|(?:كود|رمز|موديل|قطعة|code|sku)\s*[:#-]?\s*)([A-Za-z]{1,4}-?\d{2,5})(?:\]|\))?/i
  );
  if (bracketOrLabelMatch && !isKaratToken(bracketOrLabelMatch[1])) {
    return bracketOrLabelMatch[1].toUpperCase();
  }

  // 3. Any short alphanumeric code in title matching /\[?([A-Za-z]{1,4}-?\d{2,5})\]?/
  const titleCodeMatches = normTitle.matchAll(/\[?([A-Za-z]{1,4}-?\d{2,5})\]?/g);
  for (const match of titleCodeMatches) {
    const candidate = match[1];
    if (candidate && !isKaratToken(candidate)) {
      return candidate.toUpperCase();
    }
  }

  // 4. Short alphanumeric code slug in URL path (excluding Salla's trailing `/p1928559766`)
  try {
    const pathname = decodeURIComponent(new URL(url).pathname).replace(/\/p\d{6,}(?:\/|$)/i, "");
    const slugMatch = pathname.match(/(?:^|\/|-)([A-Za-z]{1,4}-?\d{2,5})(?=-|\/|$)/);
    if (slugMatch && !isKaratToken(slugMatch[1])) {
      return slugMatch[1].toUpperCase();
    }
  } catch {
    // Ignore relative or invalid URLs
  }

  // 5. Fallback: numeric SKU or Salla URL `/p<digits>` ID when no alphanumeric code exists
  if (cleanSku && /^[a-z0-9\-_]{2,24}$/i.test(cleanSku) && !isKaratToken(cleanSku)) {
    return cleanSku.toUpperCase();
  }

  const sallaUrlMatch = String(url).match(/\/p(\d{4,12})(?:[/?#]|$)/i);
  if (sallaUrlMatch) {
    return sallaUrlMatch[1];
  }

  return `P${String(index).padStart(3, "0")}`;
}

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Scrapes homepage/footer HTML to auto-populate `config.json` fields (storeName, WhatsApp phone,
 * Tabby/Tamara installments, shipping mentions, return policy, and working hours).
 */
export function extractStoreMetadataFromHtml(html, targetUrl) {
  const $ = cheerio.load(html);
  const fullText = toArabicWesternDigits($("body").text().replace(/\s+/g, " ").trim());
  const htmlLower = html.toLowerCase();

  const detectedStoreName =
    $('meta[property="og:site_name"]').attr("content")?.trim() ||
    $("title").first().text().split("|")[0].split(" - ")[0].trim() ||
    new URL(targetUrl).hostname.replace(/^www\./, "");

  // 1. Detect WhatsApp / Customer Care Phone
  let detectedPhone = "";
  $('a[href*="wa.me/"], a[href*="whatsapp.com/send"], a[href^="tel:"]').each((_, el) => {
    if (detectedPhone) return;
    const href = $(el).attr("href") || "";
    const waMatch = href.match(/(?:wa\.me\/|phone=|\btel:)(\+?\d{9,15})/i);
    if (waMatch) {
      const digits = waMatch[1].replace(/^\+/, "");
      detectedPhone = digits.startsWith("05")
        ? `+966${digits.slice(1)}`
        : `+${digits}`;
    }
  });
  if (!detectedPhone) {
    const phoneInText = fullText.match(/(?:\+?966\s*5\d{8}|\b05\d{8}\b)/);
    if (phoneInText) {
      const clean = phoneInText[0].replace(/\s+/g, "");
      detectedPhone = clean.startsWith("05")
        ? `+966${clean.slice(1)}`
        : clean.startsWith("+")
          ? clean
          : `+${clean}`;
    }
  }

  // 2. Detect Tabby / Tamara Installments
  const hasTabby = /tabby|تابي/i.test(htmlLower) || fullText.includes("تابي");
  const hasTamara = /tamara|تمارا/i.test(htmlLower) || fullText.includes("تمارا");
  const providers = [
    ...(hasTabby ? ["Tabby"] : []),
    ...(hasTamara ? ["Tamara"] : []),
  ];

  const installments =
    providers.length > 0
      ? {
          enabled: true,
          providers,
          installmentCount: 4,
          details: `متوفر التقسيط الميسر عبر ${providers
            .map((p) => (p === "Tabby" ? "تابي (Tabby)" : "تمارا (Tamara)"))
            .join(" و")} على 4 دفعات شهرية بدون فوائد وفق الشروط الموضحة في صفحة الدفع.`,
        }
      : {
          enabled: false,
          providers: [],
          details:
            "يرجى مراجعة بوابة الدفع في المتجر للتأكد من خيارات التقسيط المتاحة حالياً.",
        };

  // 3. Detect Shipping details (carriers & free-shipping threshold)
  const carriers = [];
  if (/سمسا|smsa/i.test(fullText)) carriers.push("سمسا");
  if (/أرامكس|ارامكس|aramex/i.test(fullText)) carriers.push("أرامكس");
  if (/dhl/i.test(fullText)) carriers.push("DHL");
  if (/ريد بوكس|redbox/i.test(fullText)) carriers.push("ريد بوكس");

  const freeShipMatch = fullText.match(
    /شحن مجاني[^.!؟\n]{0,60}?(\d{2,5})\s*(?:ريال|ر\.س|sar)/i
  );
  const carrierPhrase = carriers.length > 0 ? ` عبر ${carriers.join(" و")}` : "";
  const shippingPolicy = freeShipMatch
    ? `شحن سريع ومؤمن لجميع مدن المملكة${carrierPhrase} (شحن مجاني للطلبات فوق ${freeShipMatch[1]} ريال).`
    : `شحن سريع ومؤمن لجميع مناطق المملكة${carrierPhrase} خلال 2 إلى 5 أيام عمل.`;

  // 4. Detect Return Policy / FAQ snippet if mentioned
  const returnMatch = fullText.match(
    /(?:الاستبدال والاسترجاع|الاسترجاع أو الاستبدال)[^.!؟\n]{0,90}(\d+)\s*(?:أيام|ايام|يوم)/i
  );
  const returnPolicy = returnMatch
    ? `يتاح الاستبدال والاسترجاع خلال ${returnMatch[1]} أيام من استلام الطلب بشرط بقاء القطعة بحالتها الأصلية مع الفاتورة.`
    : "يخضع الاستبدال والاسترجاع لسياسة المتجر المعتمدة خلال 7 أيام من تاريخ الاستلام بشرط سلامة القطعة والفاتورة.";

  return {
    detectedStoreName,
    detectedPhone,
    installments,
    shippingPolicy,
    returnPolicy,
  };
}

/**
 * Checks whether a sitemap `<loc>` URL points to an individual product page on Salla, Zid, or Shopify.
 */
export function isProductUrl(candidateUrl, baseOrigin) {
  try {
    const parsed = new URL(candidateUrl, baseOrigin);
    if (baseOrigin && parsed.origin !== new URL(baseOrigin).origin) {
      return false;
    }
    const pathname = decodeURIComponent(parsed.pathname);

    // Exclude obvious non-product pages
    if (
      /\/(cart|checkout|login|register|account|blogs?|pages?|policies|privacy|terms|contact|faq|search|tag|brands?)(\/|$)/i.test(
        pathname
      )
    ) {
      return false;
    }

    // Salla product URLs: `/p123456...` or `/.../p123456...` or Zid/Shopify `/products/<slug>`
    if (/\/p\d{4,}(?:\/|$)/i.test(pathname)) return true;
    if (/\/products\/[^/]+/i.test(pathname)) return true;
    if (/\/product\/[^/]+/i.test(pathname)) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Parses a `sitemap.xml` (either `<sitemapindex>` or `<urlset>`) and returns:
 * - `nestedProductSitemaps`: child sitemap URLs prioritized for products
 * - `productUrls`: matched product page URLs
 */
export function parseSitemapXml(xmlString, baseOrigin) {
  const $ = cheerio.load(xmlString, { xmlMode: true });
  const nestedSitemaps = [];
  const allPageUrls = [];

  $("sitemap > loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) nestedSitemaps.push(loc);
  });

  $("url > loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) allPageUrls.push(loc);
  });

  // Prioritize product-specific child sitemaps (e.g., sitemap_products.xml, products-1.xml)
  const productSitemaps = nestedSitemaps.filter((u) => /product/i.test(u));
  const nestedProductSitemaps =
    productSitemaps.length > 0 ? productSitemaps : nestedSitemaps.slice(0, 3);

  // If this XML came from an explicit product sitemap, keep non-root URLs; otherwise filter strictly
  const productUrls = allPageUrls.filter((u) => isProductUrl(u, baseOrigin));

  return {
    nestedProductSitemaps,
    productUrls,
    allPageUrls,
  };
}

/**
 * Extracts a single `Product` object from a Salla/Zid/Shopify product HTML page
 * using Schema.org JSON-LD (`@type: "Product"`) with DOM & OpenGraph meta fallbacks.
 */
export function parseProductPageHtml(html, pageUrl, index = 1) {
  const $ = cheerio.load(html);

  let ldProduct = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (ldProduct) return;
    try {
      const rawText = $(el).contents().text().trim();
      if (!rawText) return;
      const parsed = JSON.parse(rawText);
      const queue = Array.isArray(parsed)
        ? [...parsed]
        : parsed["@graph"] && Array.isArray(parsed["@graph"])
          ? [...parsed["@graph"]]
          : [parsed];

      for (const node of queue) {
        if (!node || typeof node !== "object") continue;
        const t = node["@type"];
        const isProd =
          t === "Product" || (Array.isArray(t) && t.includes("Product"));
        if (isProd) {
          ldProduct = node;
          break;
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  });

  // Extract fields from JSON-LD first
  let name = String(ldProduct?.name ?? "").trim();
  let description = String(ldProduct?.description ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let sku = String(ldProduct?.sku || ldProduct?.mpn || ldProduct?.productID || "").trim();
  let category = String(ldProduct?.category || "").trim();
  let price = 0;
  let inStock = true;
  let hasExplicitAvailability = false;

  if (ldProduct?.offers) {
    const offerObj = Array.isArray(ldProduct.offers)
      ? ldProduct.offers[0]
      : ldProduct.offers.offers && Array.isArray(ldProduct.offers.offers)
        ? ldProduct.offers.offers[0]
        : ldProduct.offers;

    price = parsePriceNumber(
      offerObj?.price ??
        offerObj?.lowPrice ??
        offerObj?.priceSpecification?.price ??
        ldProduct?.offers?.lowPrice
    );

    const availStr = String(
      offerObj?.availability ?? ldProduct?.offers?.availability ?? ""
    ).toLowerCase();
    if (availStr) {
      hasExplicitAvailability = true;
      inStock =
        !availStr.includes("outofstock") &&
        !availStr.includes("soldout") &&
        !availStr.includes("discontinued");
    }
  }

  // DOM & Meta Fallbacks
  if (!name) {
    name =
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content")?.split("|")[0]?.trim() ||
      $("title").first().text().split("|")[0]?.trim() ||
      "";
  }

  if (!name) {
    return null;
  }

  if (!price) {
    const metaPrice =
      $('meta[property="product:price:amount"]').attr("content") ||
      $('meta[property="og:price:amount"]').attr("content") ||
      $("[data-product-price]").first().attr("data-product-price") ||
      $(
        ".product-formatted-price, .s-product-card-sale-price, .price-wrapper, .product-price, .price"
      )
        .first()
        .text();
    price = parsePriceNumber(metaPrice);
  }

  if (!hasExplicitAvailability) {
    const metaAvail = (
      $('meta[property="product:availability"]').attr("content") ||
      $('meta[property="og:availability"]').attr("content") ||
      ""
    ).toLowerCase();

    if (metaAvail) {
      inStock = !metaAvail.includes("out") && !metaAvail.includes("sold");
    } else {
      const actionAreaText = $(
        ".product-form, .add-to-cart, [data-product-availability], .out-of-stock"
      ).text();
      if (/نفذت الكمية|نفدت الكمية|غير متوفر|out of stock|sold out/i.test(actionAreaText)) {
        inStock = false;
      }
    }
  }

  if (!description) {
    description =
      $('meta[property="og:description"]').attr("content")?.trim() ||
      $('meta[name="description"]').attr("content")?.trim() ||
      name;
  }

  if (!category) {
    const breadcrumbCat = $(
      ".breadcrumbs a, nav[aria-label*='breadcrumb'] a, .breadcrumb-item a"
    )
      .eq(1)
      .text()
      .trim();
    category = breadcrumbCat || "مجوهرات (Jewelry)";
  }

  if (!sku) {
    sku =
      $("[data-sku]").first().attr("data-sku")?.trim() ||
      $(".product-sku, .sku").first().text().replace(/^(?:SKU|رمز المنتج|الكود)\s*[:#-]?\s*/i, "").trim() ||
      "";
  }

  const code = extractProductCode({ sku, title: name, url: pageUrl, index });
  const combinedText = `${name} ${description}`;
  const karat = inferKarat(combinedText);
  const weightGrams = inferWeightGrams(combinedText);

  return {
    code,
    name,
    category,
    ...(karat ? { karat } : {}),
    ...(weightGrams ? { weightGrams } : {}),
    price: price > 0 ? price : 0,
    inStock,
    url: pageUrl,
    description,
  };
}

/**
 * Concurrency-limited async mapper (default concurrency = 4).
 */
export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const currentIndex = cursor++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Simple RFC-4180 compatible CSV row splitter
 */
function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function importFromCsv(filePath) {
  const content = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV file must include a header row and at least one product row.");
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const products = [];

  for (let idx = 1; idx < lines.length; idx++) {
    const values = parseCsvLine(lines[idx]);
    const row = Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));

    const name = row.name || row.title || row["اسم المنتج"] || `منتج ${idx}`;
    const description = row.description || row["الوصف"] || name;
    const price = parsePriceNumber(row.price || row.sale_price || row["السعر"]);
    const code = extractProductCode({
      sku: row.code || row.sku || row.id,
      title: name,
      url: row.url || "",
      index: idx,
    });
    const category = row.category || row["التصنيف"] || "مجوهرات (Jewelry)";
    const rawStock = (row.instock ?? row.in_stock ?? row.stock ?? row.available ?? "true")
      .toString()
      .toLowerCase();
    const inStock = !["false", "0", "no", "out_of_stock", "نفذت", "غير متوفر"].includes(rawStock);
    const url =
      row.url ||
      row.link ||
      `https://example-store.sa/products/${encodeURIComponent(code.toLowerCase())}`;

    const karat = row.karat || inferKarat(`${name} ${description}`);
    const weightRaw = row.weightgrams || row.weight || row["الوزن"];
    const weightGrams = weightRaw
      ? Number(toArabicWesternDigits(weightRaw).replace(/[^\d.]/g, ""))
      : inferWeightGrams(`${name} ${description}`);

    products.push({
      code: String(code).trim(),
      name: String(name).trim(),
      category: String(category).trim(),
      ...(karat ? { karat: String(karat).trim() } : {}),
      ...(weightGrams && weightGrams > 0 ? { weightGrams } : {}),
      price: price > 0 ? price : 500,
      inStock,
      url: String(url).trim(),
      description: String(description).trim(),
    });
  }

  return { metadata: null, products };
}

function extractProductsFromListingHtml(html, targetUrl, limit) {
  const $ = cheerio.load(html);
  const baseOrigin = new URL(targetUrl).origin;
  const seenUrls = new Set();
  const products = [];

  const resolveUrl = (href) => {
    if (!href) return targetUrl;
    try {
      return new URL(href, baseOrigin).toString();
    } catch {
      return targetUrl;
    }
  };

  // Pass 1: JSON-LD ItemList / Product blocks on homepage
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(parsed)
        ? parsed
        : parsed["@graph"]
          ? parsed["@graph"]
          : [parsed];

      for (const node of nodes) {
        const items =
          node["@type"] === "Product"
            ? [node]
            : node["@type"] === "ItemList" && Array.isArray(node.itemListElement)
              ? node.itemListElement.map((e) => e.item || e).filter((x) => x?.name)
              : [];

        for (const item of items) {
          if (products.length >= limit) break;
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers || {};
          const itemUrl = resolveUrl(item.url || offer.url);
          if (seenUrls.has(itemUrl)) continue;

          const name = String(item.name || "").trim();
          const price = parsePriceNumber(offer.price ?? item.price);
          if (!name || price <= 0) continue;

          const avail = String(offer.availability || "").toLowerCase();
          const inStock = !avail.includes("outofstock") && !avail.includes("soldout");
          const description = String(item.description || name).trim();
          const code = extractProductCode({
            sku: item.sku || item.productID,
            title: name,
            url: itemUrl,
            index: products.length + 1,
          });
          const karat = inferKarat(`${name} ${description}`);
          const weightGrams = inferWeightGrams(`${name} ${description}`);

          seenUrls.add(itemUrl);
          products.push({
            code,
            name,
            category: String(item.category || "مجوهرات (Jewelry)"),
            ...(karat ? { karat } : {}),
            ...(weightGrams ? { weightGrams } : {}),
            price,
            inStock,
            url: itemUrl,
            description,
          });
        }
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  });

  // Pass 2: Server-rendered Salla / Zid product cards
  const cardSelectors = [
    "custom-salla-product-card",
    "salla-product-card",
    ".s-product-card-entry",
    ".product-entry",
    ".product-block",
    ".product-card",
    ".product-item",
    "[data-product-id]",
  ];

  $(cardSelectors.join(", ")).each((_, card) => {
    if (products.length >= limit) return;
    const $card = $(card);
    const linkEl = $card.find("a[href]").first();
    const name =
      $card
        .find(".s-product-card-content-title, .product-title, .product-card__title, h2, h3, h4")
        .first()
        .text()
        .trim() ||
      linkEl.attr("title")?.trim() ||
      "";

    if (!name) return;

    const itemUrl = resolveUrl(linkEl.attr("href"));
    if (seenUrls.has(itemUrl)) return;

    const priceText = $card
      .find(
        ".s-product-card-sale-price, .s-product-card-price, .product-price, .price, [data-price]"
      )
      .first()
      .text();
    const price = parsePriceNumber(priceText || $card.attr("data-price"));
    if (price <= 0) return;

    const cardText = $card.text();
    const outOfStock = /نفذت|نفدت|غير متوفر|out of stock|sold out/i.test(cardText);
    const code = extractProductCode({
      sku: $card.attr("data-sku") || $card.attr("data-product-id"),
      title: name,
      url: itemUrl,
      index: products.length + 1,
    });
    const karat = inferKarat(`${name} ${cardText}`);
    const weightGrams = inferWeightGrams(`${name} ${cardText}`);

    seenUrls.add(itemUrl);
    products.push({
      code,
      name,
      category: "مجوهرات (Jewelry)",
      ...(karat ? { karat } : {}),
      ...(weightGrams ? { weightGrams } : {}),
      price,
      inStock: !outOfStock,
      url: itemUrl,
      description: name,
    });
  });

  return products;
}

/**
 * Discovers product URLs via `${origin}/sitemap.xml` (and nested product sitemaps) and scrapes
 * up to `limit` product pages concurrently (concurrency = 4).
 */
export async function discoverProductsViaSitemap(
  baseOrigin,
  { limit = 15, concurrency = 4, fetchImpl = fetch } = {}
) {
  const rootSitemapUrl = `${baseOrigin.replace(/\/$/, "")}/sitemap.xml`;
  const rootRes = await fetchImpl(rootSitemapUrl, { headers: DEFAULT_HEADERS });
  if (!rootRes.ok) {
    return [];
  }

  const rootXml = await rootRes.text();
  const parsedRoot = parseSitemapXml(rootXml, baseOrigin);

  const collectedUrls = new Set(parsedRoot.productUrls);

  for (const childSitemapUrl of parsedRoot.nestedProductSitemaps) {
    if (collectedUrls.size >= limit) break;
    try {
      const childRes = await fetchImpl(childSitemapUrl, { headers: DEFAULT_HEADERS });
      if (!childRes.ok) continue;
      const childXml = await childRes.text();
      const parsedChild = parseSitemapXml(childXml, baseOrigin);
      const urlsToAdd =
        parsedChild.productUrls.length > 0
          ? parsedChild.productUrls
          : /product/i.test(childSitemapUrl)
            ? parsedChild.allPageUrls.filter((u) => u !== `${baseOrigin}/`)
            : [];

      for (const u of urlsToAdd) {
        collectedUrls.add(u);
        if (collectedUrls.size >= limit) break;
      }
    } catch {
      // Continue across remaining child sitemaps
    }
  }

  const targetProductUrls = [...collectedUrls].slice(0, limit);
  if (targetProductUrls.length === 0) {
    return [];
  }

  const scraped = await mapWithConcurrency(
    targetProductUrls,
    concurrency,
    async (prodUrl, idx) => {
      try {
        const res = await fetchImpl(prodUrl, { headers: DEFAULT_HEADERS });
        if (!res.ok) return null;
        const html = await res.text();
        return parseProductPageHtml(html, prodUrl, idx + 1);
      } catch {
        return null;
      }
    }
  );

  // Deduplicate codes if multiple products had identical fallback codes
  const usedCodes = new Set();
  const validProducts = [];
  for (const item of scraped) {
    if (!item || !item.name) continue;
    let uniqueCode = item.code;
    if (usedCodes.has(uniqueCode)) {
      uniqueCode = `${uniqueCode}-${validProducts.length + 1}`;
    }
    usedCodes.add(uniqueCode);
    validProducts.push({ ...item, code: uniqueCode });
  }

  return validProducts;
}

export async function importFromUrl(
  targetUrl,
  { limit = 15, fetchImpl = fetch } = {}
) {
  const response = await fetchImpl(targetUrl, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} (${response.statusText}) while fetching ${targetUrl}`);
  }

  const homepageHtml = await response.text();
  const baseOrigin = new URL(targetUrl).origin;

  // Step 1: Scrape homepage/footer metadata for config.json
  const metadata = extractStoreMetadataFromHtml(homepageHtml, targetUrl);

  // Step 2: Attempt direct homepage product extraction
  let products = extractProductsFromListingHtml(homepageHtml, targetUrl, limit);

  // Step 3: Salla/Zid client-rendered storefront fallback -> crawl sitemap.xml concurrently (concurrency = 4)
  if (products.length === 0) {
    products = await discoverProductsViaSitemap(baseOrigin, {
      limit,
      concurrency: 4,
      fetchImpl,
    });
  }

  return { metadata, products };
}

async function main() {
  const { source, slug: rawSlug, storeName: rawStoreName, phone: rawPhone, limit } = parseArgs(
    process.argv
  );

  if (!source) {
    console.error(
      'Usage:\n  node scripts/import-store.mjs <salla-or-zid-url | local.csv> [--slug <slug>] [--name "Store Name"] [--phone "+966..."] [--limit 15]'
    );
    process.exit(1);
  }

  const isUrl = /^https?:\/\//i.test(source);
  const { metadata, products } = isUrl
    ? await importFromUrl(source, { limit })
    : importFromCsv(path.resolve(process.cwd(), source));

  if (products.length === 0) {
    console.error(
      "No products could be extracted from the homepage or sitemap.xml. Try passing an exported products CSV path instead."
    );
    process.exit(1);
  }

  const slug =
    rawSlug ||
    (isUrl
      ? slugify(new URL(source).pathname.replace(/\//g, "-") || new URL(source).hostname)
      : slugify(path.basename(source, path.extname(source))));

  const storeName = rawStoreName || metadata?.detectedStoreName || slug;
  const humanHandoffPhone = rawPhone || metadata?.detectedPhone || "+966500000000";
  const outDir = path.join(process.cwd(), "src", "stores", slug);
  fs.mkdirSync(outDir, { recursive: true });

  const config = {
    slug,
    storeName,
    dialect: "Saudi Arabic",
    currency: "SAR",
    shippingPolicy:
      metadata?.shippingPolicy ||
      "شحن سريع ومؤمن لجميع مناطق المملكة خلال 2 إلى 5 أيام عمل.",
    installments: metadata?.installments || {
      enabled: true,
      providers: ["Tabby", "Tamara"],
      details:
        "يتوفر التقسيط عبر تابي وتمارا على 4 دفعات بدون فوائد وفق الشروط الموضحة في صفحة الدفع.",
    },
    returnPolicy:
      metadata?.returnPolicy ||
      "يخضع الاستبدال والاسترجاع لسياسة المتجر المعتمدة خلال 7 أيام من تاريخ الاستلام بشرط سلامة القطعة والفاتورة.",
    workingHours: "يومياً من 10:00 صباحاً حتى 10:00 مساءً (بتوقيت الرياض).",
    humanHandoffPhone,
    greetingMessage: `يا هلا وحياك الله في *${storeName}* ✨\nكيف أقدر أخدمك اليوم؟ اسألني عن أي قطعة أو كود منتج أو ميزانيتك وأبشر بالخير.`,
  };

  fs.writeFileSync(path.join(outDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "catalog.json"), JSON.stringify(products, null, 2) + "\n");

  console.log(`✅ Scaffolded store "${storeName}" (${products.length} products)`);
  console.log(`   📁 Config:  src/stores/${slug}/config.json`);
  console.log(`   📦 Catalog: src/stores/${slug}/catalog.json`);
  console.log(`   🌐 Demo UI: http://localhost:3000/demo/${slug}`);
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error("❌ Store import failed:", err.message || err);
    process.exit(1);
  });
}

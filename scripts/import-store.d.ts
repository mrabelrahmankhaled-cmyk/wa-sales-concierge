import type { Product } from "../src/lib/types";

export interface ExtractedStoreMetadata {
  detectedStoreName: string;
  detectedPhone: string;
  installments: {
    enabled: boolean;
    providers: string[];
    installmentCount?: number;
    details: string;
  };
  shippingPolicy: string;
  returnPolicy: string;
}

export function parseSitemapXml(
  xmlString: string,
  baseOrigin: string
): {
  nestedProductSitemaps: string[];
  productUrls: string[];
  allPageUrls: string[];
};

export function parseProductPageHtml(
  html: string,
  pageUrl: string,
  index?: number
): Product | null;

export function extractStoreMetadataFromHtml(
  html: string,
  targetUrl: string
): ExtractedStoreMetadata;

export function importFromUrl(
  targetUrl: string,
  options?: { limit?: number; fetchImpl?: typeof fetch }
): Promise<{ metadata: ExtractedStoreMetadata | null; products: Product[] }>;

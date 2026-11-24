import { z } from "zod";

/**
 * Installments configuration (Tabby / Tamara / etc.)
 * Supports either a concise policy string or a structured breakdown.
 */
export const InstallmentsSchema = z.union([
  z.string().min(1),
  z.object({
    enabled: z.boolean(),
    providers: z.array(z.string().min(1)),
    minAmount: z.number().nonnegative().optional(),
    installmentCount: z.number().int().positive().optional(),
    details: z.string().min(1),
  }),
]);

export type InstallmentsConfig = z.infer<typeof InstallmentsSchema>;

/**
 * Strict schema for `src/stores/<slug>/config.json`
 */
export const StoreConfigSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/i, "Store slug must contain only letters, numbers, and hyphens"),
  storeName: z.string().min(1),
  dialect: z.string().min(1),
  currency: z.string().min(1),
  shippingPolicy: z.string().min(1),
  installments: InstallmentsSchema,
  returnPolicy: z.string().min(1).optional(),
  workingHours: z.string().min(1),
  humanHandoffPhone: z.string().min(1),
  greetingMessage: z.string().min(1),
});

export type StoreConfig = z.infer<typeof StoreConfigSchema>;

/**
 * Strict schema for individual items in `src/stores/<slug>/catalog.json`
 */
export const ProductSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  karat: z.string().min(1).optional(),
  weightGrams: z.number().positive().optional(),
  price: z.number().nonnegative(),
  inStock: z.boolean(),
  url: z.string().url(),
  description: z.string().min(1),
});

export const CatalogSchema = z.array(ProductSchema).min(1);

export type Product = z.infer<typeof ProductSchema>;

export interface LoadedStore {
  config: StoreConfig;
  catalog: Product[];
}

export type PolicyTopic = "shipping" | "installments" | "returns" | "working_hours" | "all";

export interface GetProductByCodeArgs {
  code: string;
}

export interface SearchProductsArgs {
  query?: string;
  maxPrice?: number;
  category?: string;
  inStockOnly?: boolean;
}

export interface GetStorePolicyArgs {
  topic: PolicyTopic | string;
}

export interface EscalateToHumanArgs {
  reason: string;
  customerSummary: string;
}

export interface ToolCallTrace {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface SalesAgentResult {
  reply: string;
  toolCalls: ToolCallTrace[];
  handedOff: boolean;
  modelUsed: string;
  debugError?: string;
}

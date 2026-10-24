import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { COMMERCE_DATA_CLASSIFICATION } from "./order-contracts.js";

export const DEFAULT_SYNTHETIC_ORDERS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "data",
  "commerce",
  "synthetic-orders-v1.json"
);

export const SYNTHETIC_ORDER_STATUSES = ["placed", "processing", "delivered", "cancelled"] as const;
export type SyntheticOrderStatus = (typeof SYNTHETIC_ORDER_STATUSES)[number];

const syntheticOrderSchema = z
  .object({
    orderId: z.string().min(1),
    tenantId: z.string().min(1),
    ownerPrincipalId: z.string().min(1),
    status: z.enum(SYNTHETIC_ORDER_STATUSES),
    refundWindowEndsAt: z.string().datetime(),
    lineItems: z
      .array(
        z
          .object({
            lineItemId: z.string().min(1),
            sku: z.string().min(1),
            quantity: z.number().int().min(1),
          })
          .strict()
      )
      .min(1),
  })
  .strict();
export type SyntheticOrder = z.infer<typeof syntheticOrderSchema>;

/** A fixture without synthetic provenance is rejected as a whole. */
export const syntheticOrderFixtureSchema = z
  .object({
    provenance: z
      .object({
        synthetic: z.literal(true),
        datasetId: z.string().min(1),
        datasetVersion: z.string().min(1),
        generatedAt: z.string().min(1),
        dataClassification: z.literal(COMMERCE_DATA_CLASSIFICATION),
        description: z.string().optional(),
      })
      .strict(),
    orders: z
      .array(syntheticOrderSchema)
      .min(1)
      .refine(
        (orders) => new Set(orders.map((order) => order.orderId)).size === orders.length,
        { message: "orderId must be unique" }
      ),
  })
  .strict();
export type SyntheticOrderFixture = z.infer<typeof syntheticOrderFixtureSchema>;

export function parseSyntheticOrderFixture(value: unknown): SyntheticOrderFixture {
  return syntheticOrderFixtureSchema.parse(value);
}

export async function loadSyntheticOrderFixture(
  path: string = DEFAULT_SYNTHETIC_ORDERS_PATH
): Promise<SyntheticOrderFixture> {
  return parseSyntheticOrderFixture(JSON.parse(await readFile(path, "utf8")));
}

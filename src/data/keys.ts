// Query keys centralizadas — UNA sola fuente de verdad para cache/invalidación
// (React Query + Realtime). Guardrail: nada de keys ad-hoc por componente.
import type { Database } from "./database.types";

export type TableName = keyof Database["public"]["Tables"];

export const keys = {
  departments: ["departments"] as const,
  categories: ["categories"] as const,
  models: ["models"] as const,
  aliases: (modelId?: string) =>
    modelId === undefined ? (["model_aliases"] as const) : (["model_aliases", modelId] as const),
  suppliers: ["suppliers"] as const,
  clients: ["clients"] as const,
  shippings: ["shippings"] as const,
  prices: (modelId?: string) =>
    modelId === undefined ? (["prices"] as const) : (["prices", modelId] as const),
  priceTiers: (modelId?: string) =>
    modelId === undefined ? (["price_tiers"] as const) : (["price_tiers", modelId] as const),
  priceHistory: (modelId?: string) =>
    modelId === undefined ? (["price_history"] as const) : (["price_history", modelId] as const),
  salePrices: ["sale_prices"] as const,
  snapshots: ["snapshots"] as const,
  invoices: ["invoices"] as const,
  invoiceItems: (invoiceId?: string) =>
    invoiceId === undefined ? (["invoice_items"] as const) : (["invoice_items", invoiceId] as const),
  itemUnits: (itemId?: string) =>
    itemId === undefined ? (["invoice_item_units"] as const) : (["invoice_item_units", itemId] as const),
  ledger: (partyId?: string) =>
    partyId === undefined ? (["ledger"] as const) : (["ledger", partyId] as const),
  opsTracking: ["ops_tracking"] as const,
  knowledge: ["knowledge"] as const,
  chatLog: ["chat_log"] as const,
  drafts: ["drafts"] as const,
} as const;

// Realtime → invalidación: tabla física → key RAÍZ a invalidar (la invalidación por
// prefijo alcanza también a las keys con parámetro, p.ej. ["prices", modelId]).
// Son las tablas mutables que la app observa; la publication (0002_realtime.sql)
// habilita TODAS las tablas para no necesitar otra migración en fases futuras.
export const realtimeInvalidation: ReadonlyArray<readonly [TableName, readonly string[]]> = [
  ["departments", keys.departments],
  ["categories", keys.categories],
  ["models", keys.models],
  ["model_aliases", keys.aliases()],
  ["prices", keys.prices()],
  ["price_tiers", keys.priceTiers()],
  ["sale_prices", keys.salePrices],
  ["clients", keys.clients],
  ["suppliers", keys.suppliers],
  ["invoices", keys.invoices],
  ["invoice_items", keys.invoiceItems()],
  ["invoice_item_units", keys.itemUnits()],
  ["shippings", keys.shippings],
  ["drafts", keys.drafts],
  ["ledger", keys.ledger()],
  ["ops_tracking", keys.opsTracking],
];

// mockDeps COMPARTIDO (tests unit del executor, del loop y evals offline): ToolDeps
// completo con STORE MUTABLE (P1: el verify-after-write se prueba releyendo estado real),
// staging en memoria y memoria/journal reseteables (setKnowledgeRows / setAgentRunRows).
import { vi } from "vitest";
import { normalize } from "../../src/domain/normalize";
import type { StagedNegotiation } from "../../src/domain/negotiation";
import type { ToolDeps } from "../../src/features/agent/executor";

export type SeedPrice = { model_id: string; supplier_id: string; price: number; updated_at?: string };
export type SeedTier = { model_id: string; supplier_id: string; min_qty: number; price: number };
export type MockSeed = { prices?: SeedPrice[]; tiers?: SeedTier[]; sales?: Array<{ model_id: string; price: number }> };

export function mockDeps(overrides: Partial<ToolDeps> = {}, seed?: MockSeed): ToolDeps {
  const models = [
    { id: "m1", canonical_name: "S26 12+512 5G DS", category_id: "c-sam", department_id: "d-tel" },
    { id: "m2", canonical_name: "A17 4+128 DS", category_id: "c-sam", department_id: "d-tel" },
  ];
  const aliasMap = new Map<string, string>([
    [normalize("S26 12+512 5G DS"), "m1"],
    [normalize("A17 4+128 DS"), "m2"],
  ]);
  // STORE MUTABLE (P1): las escrituras impactan y las lecturas releen — el
  // verify-after-write del executor se prueba contra estado real, no contra un fixture.
  const now = () => new Date().toISOString();
  const store = {
    prices: (
      seed?.prices ?? [
        { model_id: "m1", supplier_id: "s-bax", price: 600 },
        { model_id: "m1", supplier_id: "s-sou", price: 640 },
      ]
    ).map((r) => ({ updated_at: now(), ...r })),
    tiers: (seed?.tiers ?? [
      { model_id: "m1", supplier_id: "s-bax", min_qty: 1, price: 600 },
      { model_id: "m1", supplier_id: "s-bax", min_qty: 50, price: 580 },
    ]).map((t) => ({ ...t })),
    sales: (seed?.sales ?? []).map((s) => ({ ...s })),
  };
  const upsertStorePrice = (row: { model_id: string; supplier_id: string; price: number }) => {
    const i = store.prices.findIndex(
      (r) => r.model_id === row.model_id && r.supplier_id === row.supplier_id,
    );
    if (i === -1) store.prices.push({ ...row, updated_at: now() });
    else store.prices[i] = { ...store.prices[i]!, price: row.price, updated_at: now() };
  };
  const replaceStoreTiers = (
    pair: { model_id: string; supplier_id: string },
    tiers: ReadonlyArray<{ min_qty: number; price: number }>,
  ) => {
    store.tiers = store.tiers.filter(
      (t) => !(t.model_id === pair.model_id && t.supplier_id === pair.supplier_id),
    );
    for (const t of tiers) store.tiers.push({ ...pair, ...t });
  };
  const base: ToolDeps = {
    resolver: async () => ({
      findAliasKey: (k) => aliasMap.get(k) ?? null,
      findModelByKey: () => null,
    }),
    listModels: async () => models,
    listCategories: async () => [
      { id: "c-sam", name: "Samsung" },
      { id: "c-alta", name: "Samsung Gama Alta" },
    ],
    listDepartments: async () => [
      { id: "d-tel", name: "Teléfonos" },
      { id: "d-iph", name: "iPhone" },
    ],
    listSuppliers: async () => [
      { id: "s-bax", name: "Bax", active: true },
      { id: "s-sou", name: "South", active: true },
    ],
    listPrices: async () => store.prices.map((r) => ({ ...r })),
    listTiers: async () => store.tiers.map((t) => ({ ...t })),
    listSalePrices: async () => store.sales.map((s) => ({ ...s })),
    listClients: async () => [{ id: "cl1", name: "Ojus", esNuestra: false }],
    listOps: async () => [],
    deskData: async () => ({ invoices: [], ledger: [] }),
    createModelWithAlias: vi.fn(async (name: string) => ({
      id: "m-new",
      canonical_name: name,
      category_id: null,
      department_id: null,
    })),
    renameModelWithAlias: vi.fn(async (modelId: string, newName: string) => ({
      id: modelId,
      canonical_name: newName,
      category_id: null,
      department_id: null,
    })),
    setModelCategory: vi.fn(async () => {}),
    insertCategory: vi.fn(async (name: string) => ({ id: "c-new", name })),
    renameCategory: vi.fn(async (id: string, name: string) => ({ id, name })),
    insertSupplier: vi.fn(async (name: string) => ({ id: "s-new", name, active: true })),
    setSupplierActive: vi.fn(async () => {}),
    upsertPrice: vi.fn(async (row: { model_id: string; supplier_id: string; price: number }) => {
      upsertStorePrice(row);
    }),
    appendPriceHistory: vi.fn(async () => {}),
    setTiersForPair: vi.fn(
      async (
        pair: { model_id: string; supplier_id: string },
        tiers: Array<{ min_qty: number; price: number }>,
      ) => {
        replaceStoreTiers(pair, tiers);
      },
    ),
    deletePrice: vi.fn(async (pair: { model_id: string; supplier_id: string }) => {
      store.prices = store.prices.filter(
        (r) => !(r.model_id === pair.model_id && r.supplier_id === pair.supplier_id),
      );
    }),
    upsertSalePrice: vi.fn(async (row: { model_id: string; price: number }) => {
      const i = store.sales.findIndex((s) => s.model_id === row.model_id);
      if (i === -1) store.sales.push({ model_id: row.model_id, price: row.price });
      else store.sales[i] = { model_id: row.model_id, price: row.price };
    }),
    deleteSalePrice: vi.fn(async (modelId: string) => {
      store.sales = store.sales.filter((s) => s.model_id !== modelId);
    }),
    extractQuote: vi.fn(async () => []),
    applyQuoteEntry: vi.fn(
      async (modelId: string, supplierId: string, entry: { price: number; tiers: Array<{ min_qty: number; price: number }> }) => {
        upsertStorePrice({ model_id: modelId, supplier_id: supplierId, price: entry.price });
        replaceStoreTiers(
          { model_id: modelId, supplier_id: supplierId },
          entry.tiers.length > 1 ? entry.tiers : [],
        );
      },
    ),
    queueCandidates: vi.fn(() => {}),
    ...stagingMock(),
    listKnowledge: async () => knowledgeRows.map((r) => ({ ...r })),
    insertKnowledge: vi.fn(async (t: string) => {
      knowledgeRows.push({ id: String(knowledgeRows.length + 1), rule_text: t });
    }),
    listAgentRuns: async () => agentRunRows.map((r) => ({ ...r })),
    reviewAgentRun: vi.fn(async (id: string, review: { verdict: string; notas?: string }) => {
      const row = agentRunRows.find((r) => r.id === id);
      if (row) row.review = review;
    }),
  };
  return { ...base, ...overrides };
}

let agentRunRows: Array<{
  id: string;
  ts: string;
  task: string;
  mode: string;
  status: string;
  report: string | null;
  metrics: unknown;
  review: unknown;
}> = [];

// staging en memoria (mismo contrato que el store zustand real)
function stagingMock() {
  const box: { current: StagedNegotiation | null } = { current: null };
  return {
    getStaged: () => box.current,
    setStaged: vi.fn((neg: StagedNegotiation) => {
      box.current = neg;
    }),
    removeStagedLines: vi.fn((aliasKeys: readonly string[]) => {
      if (!box.current) return;
      const drop = new Set(aliasKeys);
      const lines = box.current.lines.filter((l) => !drop.has(l.aliasKey));
      box.current = lines.length ? { ...box.current, lines } : null;
    }),
    clearStaged: vi.fn(() => {
      box.current = null;
    }),
  };
}

let knowledgeRows: Array<{ id: string; rule_text: string }> = [];

export function setKnowledgeRows(rows: Array<{ id: string; rule_text: string }>): void {
  knowledgeRows = rows;
}
export function setAgentRunRows(
  rows: Array<{
    id: string;
    ts: string;
    task: string;
    mode: string;
    status: string;
    report: string | null;
    metrics: unknown;
    review: unknown;
  }>,
): void {
  agentRunRows = rows;
}

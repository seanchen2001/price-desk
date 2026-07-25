// ToolDeps para el runtime HEADLESS (P3): como liveDeps pero sin browser —
//  - staging de negociación EN MEMORIA por corrida (nada de zustand/localStorage)
//  - queueCandidates → journal de la corrida (no hay cola de Mesa que mostrar)
//  - extractQuote vía fetch DIRECTO a Gemini (makeDirectGeminiFetch), sin proxy /api
import { listAgentRuns, reviewAgentRun } from "../../data/agentRuns";
import { listClients } from "../../data/clients";
import {
  insertCategory,
  listCategories,
  listDepartments,
  renameCategory,
} from "../../data/departments";
import { listInvoiceItems, listInvoices } from "../../data/invoices";
import { listLedger } from "../../data/ledger";
import { insertKnowledge, listKnowledge, listOps } from "../../data/misc";
import { listModels, updateModel } from "../../data/models";
import {
  appendPriceHistory,
  deletePrice,
  deleteSalePrice,
  listPrices,
  listSalePrices,
  listTiers,
  setTiersForPair,
  upsertPrice,
  upsertSalePrice,
} from "../../data/prices";
import {
  createModelWithAlias,
  fetchResolverSnapshot,
  renameModelWithAlias,
} from "../../data/resolverRepo";
import { insertSupplier, listSuppliers, updateSupplier } from "../../data/suppliers";
import type { Db } from "../../data/supabase";
import type { StagedNegotiation } from "../../domain/negotiation";
import { applyEntry } from "../mesa/applyQuote";
import { buildDeskInvoices, buildLedgerEntries } from "../shared/invoiceInputs";
import type { ToolDeps } from "./executor";
import { extractQuoteAI } from "./extraction";
import type { FetchLike } from "./gemini";

export type ServerDepsOptions = {
  /** transporte directo a Gemini (scripts/lib/gemini.ts) — para extractQuote */
  fetchFn: FetchLike;
  /** candidatos NUEVOS del análisis → journal de la corrida (no hay cola de Mesa acá) */
  onCandidates?: (items: Array<{ rawName: string; aliasKey: string; supplierName: string }>) => void;
};

export function buildServerDeps(db: Db, opts: ServerDepsOptions): ToolDeps {
  // staging in-memory POR CORRIDA (mismo contrato que el store zustand de la Mesa)
  const box: { current: StagedNegotiation | null } = { current: null };
  return {
    resolver: () => fetchResolverSnapshot(db),
    listModels: () => listModels(db),
    listCategories: () => listCategories(db),
    listDepartments: () => listDepartments(db),
    listSuppliers: () => listSuppliers(db),
    listPrices: () => listPrices(undefined, db),
    listTiers: () => listTiers(undefined, db),
    listSalePrices: () => listSalePrices(db),
    listClients: async () =>
      (await listClients(db)).map((c) => ({ id: c.id, name: c.name, esNuestra: c.es_nuestra })),
    listOps: async () =>
      (await listOps(db)).map((o) => ({
        invoiceId: o.invoice_id,
        afuera: o.afuera,
        local: o.local,
        pago: o.pago,
      })),
    deskData: async () => {
      const [invoices, items, ledger] = await Promise.all([
        listInvoices(db),
        listInvoiceItems(undefined, db),
        listLedger({}, db),
      ]);
      return { invoices: buildDeskInvoices(invoices, items), ledger: buildLedgerEntries(ledger) };
    },
    createModelWithAlias: (name, input) => createModelWithAlias(name, input, db),
    renameModelWithAlias: (modelId, newName) => renameModelWithAlias(modelId, newName, db),
    setModelCategory: async (modelId, categoryId) => {
      await updateModel(modelId, { category_id: categoryId }, db);
    },
    insertCategory: (name) => insertCategory(name, db),
    renameCategory: (id, name) => renameCategory(id, name, db),
    insertSupplier: (name) => insertSupplier({ name }, db),
    setSupplierActive: async (id, active) => {
      await updateSupplier(id, { active }, db);
    },
    upsertPrice: async (row) => {
      await upsertPrice(row, db);
    },
    appendPriceHistory: async (row) => {
      await appendPriceHistory(row, db);
    },
    setTiersForPair: async (pair, tiers) => {
      await setTiersForPair(pair, tiers, db);
    },
    deletePrice: (pair) => deletePrice(pair, db),
    upsertSalePrice: async (row) => {
      await upsertSalePrice(row, db);
    },
    deleteSalePrice: (modelId) => deleteSalePrice(modelId, db),
    extractQuote: (input) => extractQuoteAI(input, opts.fetchFn),
    applyQuoteEntry: (modelId, supplierId, entry) => applyEntry(modelId, supplierId, entry, db),
    queueCandidates: (items) => {
      opts.onCandidates?.(
        items.map((i) => ({
          rawName: i.entry.rawName,
          aliasKey: i.aliasKey,
          supplierName: i.supplierName,
        })),
      );
    },
    getStaged: () => box.current,
    setStaged: (neg) => {
      box.current = neg;
    },
    removeStagedLines: (aliasKeys) => {
      if (!box.current) return;
      const drop = new Set(aliasKeys);
      const lines = box.current.lines.filter((l) => !drop.has(l.aliasKey));
      box.current = lines.length === 0 ? null : { ...box.current, lines };
    },
    clearStaged: () => {
      box.current = null;
    },
    listKnowledge: () => listKnowledge(db),
    insertKnowledge: async (ruleText) => {
      await insertKnowledge(ruleText, db);
    },
    listAgentRuns: (opts2) => listAgentRuns(opts2, db),
    reviewAgentRun: async (id, review) => {
      await reviewAgentRun(id, review, db);
    },
  };
}

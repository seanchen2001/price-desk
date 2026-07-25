// ToolDeps REALES del ejecutor: cableado 1:1 a la capa de datos existente (mutaciones
// por fila + resolvedor canónico). Separado de executor.ts para que los unit tests
// (que mockean deps) no importen supabase en runtime.
import { listClients } from "../../data/clients";
import { insertCategory, listCategories, listDepartments, renameCategory } from "../../data/departments";
import { listInvoiceItems, listInvoices } from "../../data/invoices";
import { listLedger } from "../../data/ledger";
import { insertKnowledge, listKnowledge, listOps } from "../../data/misc";
import { updateModel, listModels } from "../../data/models";
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
import { supabase, type Db } from "../../data/supabase";
import { applyEntry } from "../mesa/applyQuote";
import { enqueueCandidates } from "../mesa/queueStore";
import {
  clearStagedNegotiation,
  getStagedNegotiation,
  removeStagedLines as removeStagedNegotiationLines,
  setStagedNegotiation,
} from "./negotiationStore";
import { buildDeskInvoices, buildLedgerEntries } from "../shared/invoiceInputs";
import type { ToolDeps } from "./executor";
import { extractQuoteAI } from "./extraction";

export function buildLiveDeps(db: Db = supabase): ToolDeps {
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
      return {
        invoices: buildDeskInvoices(invoices, items),
        ledger: buildLedgerEntries(ledger),
      };
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
    extractQuote: (input) => extractQuoteAI(input),
    applyQuoteEntry: (modelId, supplierId, entry) => applyEntry(modelId, supplierId, entry, db),
    queueCandidates: (items) => enqueueCandidates(items),
    getStaged: () => getStagedNegotiation(),
    setStaged: (neg) => setStagedNegotiation(neg),
    removeStagedLines: (aliasKeys) => removeStagedNegotiationLines(aliasKeys),
    clearStaged: () => clearStagedNegotiation(),
    listKnowledge: () => listKnowledge(db),
    insertKnowledge: async (ruleText) => {
      await insertKnowledge(ruleText, db);
    },
  };
}

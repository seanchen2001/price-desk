// Ejecutor de tools del agente: mapea cada tool call TIPADA a la capa de datos
// existente (mutaciones por fila) o al domain puro (consultas). El agente propone;
// ESTE código ejecuta. Identidad SIEMPRE vía resolveModel — jamás se escribe por nombre.
//
// Testeable sin base: TODO entra por ToolDeps (deps inyectables; producción los arma
// liveDeps.ts sobre src/data; los unit tests pasan mocks). Este módulo NO importa nada
// con side-effects (supabase) en runtime — solo domain puro y tipos.
import { computeAccounts, parseWhen, type LedgerEntry, type Side } from "../../domain/accounts";
import {
  analyticsData,
  computePnl,
  periodStart,
  type DeskInvoice,
  type PnlPeriod,
} from "../../domain/analytics";
import { bestSuppliers, type PriceMatrix, type TierMatrix } from "../../domain/planning";
import { rowAggregates } from "../../domain/pricing";
import { clientPulse, type PulseClient, type PulseOps } from "../../domain/pulse";
import { resolveModel } from "../../domain/resolver";
import type { ResolverRepo } from "../../domain/resolver";
import type { QuoteEntry, QuoteTier } from "../../domain/quoteParser";
import { listaPrice, whatsappQuoteText, type WhatsappGroup } from "../../domain/whatsapp";
import {
  checkQuoteEntry,
  extractedToQuoteEntries,
  PRICE_AUTO_THRESHOLD,
  type ExtractedItem,
} from "./extraction";

export type ToolCall = { name: string; args: Record<string, unknown> };
export type ToolResult = Record<string, unknown>;

// Filas mínimas que necesita el ejecutor (estructurales: las reales de src/data encajan).
export type AgentModel = {
  id: string;
  canonical_name: string;
  category_id: string | null;
  department_id: string | null;
};
export type AgentNamed = { id: string; name: string };
export type AgentSupplier = AgentNamed & { active: boolean };
export type AgentPriceRow = {
  model_id: string;
  supplier_id: string;
  price: number;
  updated_at: string;
};
export type AgentTierRow = { model_id: string; supplier_id: string; min_qty: number; price: number };
export type AgentSaleRow = { model_id: string; price: number };

export type ToolDeps = {
  // lecturas
  resolver: () => Promise<ResolverRepo>;
  listModels: () => Promise<AgentModel[]>;
  listCategories: () => Promise<AgentNamed[]>;
  listDepartments: () => Promise<AgentNamed[]>;
  listSuppliers: () => Promise<AgentSupplier[]>;
  listPrices: () => Promise<AgentPriceRow[]>;
  listTiers: () => Promise<AgentTierRow[]>;
  listSalePrices: () => Promise<AgentSaleRow[]>;
  listClients: () => Promise<PulseClient[]>;
  listOps: () => Promise<PulseOps[]>;
  deskData: () => Promise<{ invoices: DeskInvoice[]; ledger: LedgerEntry[] }>;
  // mutaciones (las canónicas de src/data — por fila, con self-alias donde corresponde)
  createModelWithAlias: (
    name: string,
    input: { category_id?: string; department_id?: string },
  ) => Promise<AgentModel>;
  renameModelWithAlias: (modelId: string, newName: string) => Promise<AgentModel>;
  setModelCategory: (modelId: string, categoryId: string | null) => Promise<void>;
  insertCategory: (name: string) => Promise<AgentNamed>;
  renameCategory: (id: string, name: string) => Promise<AgentNamed>;
  insertSupplier: (name: string) => Promise<AgentSupplier>;
  setSupplierActive: (id: string, active: boolean) => Promise<void>;
  upsertPrice: (row: { model_id: string; supplier_id: string; price: number }) => Promise<void>;
  appendPriceHistory: (row: {
    model_id: string;
    supplier_id: string;
    price: number;
  }) => Promise<void>;
  setTiersForPair: (
    pair: { model_id: string; supplier_id: string },
    tiers: QuoteTier[],
  ) => Promise<void>;
  deletePrice: (pair: { model_id: string; supplier_id: string }) => Promise<void>;
  upsertSalePrice: (row: { model_id: string; price: number; manual: boolean }) => Promise<void>;
  deleteSalePrice: (modelId: string) => Promise<void>;
  // tubería propose-only de cotizaciones (load_quote desde el chat)
  extractQuote: (input: { text: string }) => Promise<ExtractedItem[]>;
  /** applyEntry de la Mesa: precio por fila + history + escalera del par */
  applyQuoteEntry: (modelId: string, supplierId: string, entry: QuoteEntry) => Promise<void>;
  /** encola candidatos NUEVOS en la cola de confirmación de la Mesa (humano decide) */
  queueCandidates: (
    items: Array<{ entry: QuoteEntry; aliasKey: string; supplierId: string; supplierName: string }>,
  ) => void;
};

// ---------- matching difuso de proveedor (case/typos → propone, JAMÁS crea) ----------

/** clave laxa: minúsculas y solo alfanumérico ("Bax." → "bax"). */
export const supplierKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

/**
 * exact (ci) o misma clave alfanumérica → match directo; typo cercano (distancia ≤2 sobre
 * la clave, o prefijo) → SOLO sugerencia (el que llama pregunta, nunca usa la sugerencia
 * en silencio ni crea un proveedor nuevo).
 */
export function matchSupplier<T extends { name: string }>(
  list: readonly T[],
  raw: string,
): { match: T | null; suggestion: T | null } {
  const q = raw.trim();
  if (!q) return { match: null, suggestion: null };
  const exact = list.find((x) => x.name.toLowerCase() === q.toLowerCase());
  if (exact) return { match: exact, suggestion: null };
  const key = supplierKey(q);
  if (key) {
    const byKey = list.find((x) => supplierKey(x.name) === key);
    if (byKey) return { match: byKey, suggestion: null };
    let best: { item: T; d: number } | null = null;
    for (const x of list) {
      const xk = supplierKey(x.name);
      const d =
        xk.startsWith(key) || key.startsWith(xk) ? 1 : editDistance(xk, key);
      if (d <= 2 && (best === null || d < best.d)) best = { item: x, d };
    }
    if (best) return { match: null, suggestion: best.item };
  }
  return { match: null, suggestion: null };
}

// ---------- helpers ----------

const str = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string).trim() : "";

const num = (args: Record<string, unknown>, key: string): number | null => {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

const ci = (s: string): string => s.trim().toLowerCase();

function findByName<T extends { name: string }>(rows: readonly T[], name: string): T | null {
  const q = ci(name);
  return rows.find((r) => ci(r.name) === q) ?? rows.find((r) => ci(r.name).includes(q)) ?? null;
}

type ModelRef =
  | { ok: true; modelId: string; canonical: string }
  | { ok: false; error: ToolResult };

/** Resuelve una referencia textual a modelo vía resolveModel (guardrail de identidad). */
async function resolveModelRef(deps: ToolDeps, raw: string): Promise<ModelRef> {
  if (!raw) return { ok: false, error: { error: "Falta el nombre del modelo." } };
  const repo = await deps.resolver();
  const r = resolveModel(raw, {}, repo);
  const models = await deps.listModels();
  if ("modelId" in r) {
    const m = models.find((x) => x.id === r.modelId);
    return { ok: true, modelId: r.modelId, canonical: m?.canonical_name ?? raw };
  }
  const token = ci(raw).split(/\s+/)[0] ?? "";
  const parecidos = models
    .filter((m) => token !== "" && ci(m.canonical_name).includes(token))
    .slice(0, 5)
    .map((m) => m.canonical_name);
  return {
    ok: false,
    error: {
      error: `No encontré el modelo "${raw}" en el catálogo (no se crea nada solo; usá create_model si es genuinamente nuevo).`,
      parecidos,
    },
  };
}

async function resolveSupplierRef(
  deps: ToolDeps,
  raw: string,
): Promise<{ ok: true; supplier: AgentSupplier } | { ok: false; error: ToolResult }> {
  if (!raw) return { ok: false, error: { error: "Falta el proveedor." } };
  const suppliers = await deps.listSuppliers();
  const { match, suggestion } = matchSupplier(suppliers, raw);
  if (!match) {
    return {
      ok: false,
      error: {
        error: `No existe el proveedor "${raw}".`,
        ...(suggestion !== null ? { quisiste_decir: suggestion.name } : {}),
        proveedores: suppliers.map((s) => s.name),
        nota: "No se crean proveedores solos: confirmá el nombre o usá create_supplier.",
      },
    };
  }
  return { ok: true, supplier: match };
}

function buildMatrices(prices: readonly AgentPriceRow[], tiers: readonly AgentTierRow[]) {
  const priceMatrix: PriceMatrix = {};
  for (const p of prices) (priceMatrix[p.model_id] ??= {})[p.supplier_id] = p.price;
  const tierMatrix: TierMatrix = {};
  for (const t of tiers) {
    ((tierMatrix[t.model_id] ??= {})[t.supplier_id] ??= []).push({
      min: t.min_qty,
      price: t.price,
    });
  }
  return { priceMatrix, tierMatrix };
}

function sanitizeTierArgs(v: unknown): QuoteTier[] {
  if (!Array.isArray(v)) return [];
  const byMin = new Map<number, number>();
  for (const t of v) {
    if (typeof t !== "object" || t === null) continue;
    const rec = t as Record<string, unknown>;
    const min = rec["min_qty"];
    const price = rec["price"];
    if (typeof min !== "number" || typeof price !== "number") continue;
    if (!Number.isFinite(min) || !Number.isFinite(price) || price <= 0) continue;
    byMin.set(Math.max(1, Math.round(min)), price);
  }
  return [...byMin.entries()]
    .map(([min_qty, price]) => ({ min_qty, price }))
    .sort((a, b) => a.min_qty - b.min_qty);
}

// ---------- ejecutor ----------

/** Nombres que este ejecutor sabe correr (el test los cruza con TOOL_NAMES). */
export const EXECUTABLE_TOOLS: ReadonlySet<string> = new Set([
  "create_model",
  "rename_model",
  "move_model_category",
  "create_category",
  "rename_category",
  "create_supplier",
  "toggle_supplier",
  "set_price",
  "set_tiers",
  "set_sale_price",
  "delete_price",
  "get_mesa_summary",
  "client_pulse",
  "analytics_summary",
  "cuentas_summary",
  "best_suppliers",
  "load_quote",
  "whatsapp_list",
]);

export async function executeTool(call: ToolCall, deps: ToolDeps): Promise<ToolResult> {
  const { args } = call;
  switch (call.name) {
    // ---------- catálogo ----------
    case "create_model": {
      const name = str(args, "name");
      if (!name) return { error: "Falta 'name'." };
      const repo = await deps.resolver();
      const r = resolveModel(name, {}, repo);
      if ("modelId" in r) {
        const models = await deps.listModels();
        const m = models.find((x) => x.id === r.modelId);
        return {
          ya_existe: true,
          model_id: r.modelId,
          canonical_name: m?.canonical_name ?? name,
          nota: "No se duplicó: ese nombre ya resuelve a un modelo existente.",
        };
      }
      const input: { category_id?: string; department_id?: string } = {};
      const catName = str(args, "category");
      if (catName) {
        const cat = findByName(await deps.listCategories(), catName);
        if (!cat) {
          return {
            error: `La categoría "${catName}" no existe. Creala primero con create_category.`,
          };
        }
        input.category_id = cat.id;
      }
      const deptName = str(args, "department");
      if (deptName) {
        const dept = findByName(await deps.listDepartments(), deptName);
        if (!dept) {
          const departments = await deps.listDepartments();
          return {
            error: `El departamento "${deptName}" no existe.`,
            departamentos: departments.map((d) => d.name),
          };
        }
        input.department_id = dept.id;
      }
      const model = await deps.createModelWithAlias(name, input);
      return { creado: true, model_id: model.id, canonical_name: model.canonical_name };
    }
    case "rename_model": {
      const ref = await resolveModelRef(deps, str(args, "model"));
      if (!ref.ok) return ref.error;
      const newName = str(args, "new_name");
      if (!newName) return { error: "Falta 'new_name'." };
      const model = await deps.renameModelWithAlias(ref.modelId, newName);
      return { ok: true, model_id: model.id, antes: ref.canonical, ahora: model.canonical_name };
    }
    case "move_model_category": {
      const ref = await resolveModelRef(deps, str(args, "model"));
      if (!ref.ok) return ref.error;
      const catName = str(args, "category");
      const cat = findByName(await deps.listCategories(), catName);
      if (!cat) {
        return {
          error: `La categoría "${catName}" no existe. Creala primero con create_category.`,
        };
      }
      await deps.setModelCategory(ref.modelId, cat.id);
      return { ok: true, modelo: ref.canonical, categoria: cat.name };
    }
    case "create_category": {
      const name = str(args, "name");
      if (!name) return { error: "Falta 'name'." };
      const existing = findByName(await deps.listCategories(), name);
      if (existing && ci(existing.name) === ci(name)) {
        return { ya_existe: true, category_id: existing.id, name: existing.name };
      }
      const cat = await deps.insertCategory(name);
      return { creada: true, category_id: cat.id, name: cat.name };
    }
    case "rename_category": {
      const from = str(args, "from");
      const to = str(args, "to");
      if (!from || !to) return { error: "Faltan 'from'/'to'." };
      const cat = findByName(await deps.listCategories(), from);
      if (!cat) return { error: `No existe la categoría "${from}".` };
      const renamed = await deps.renameCategory(cat.id, to);
      return { ok: true, antes: cat.name, ahora: renamed.name };
    }
    case "create_supplier": {
      const name = str(args, "name");
      if (!name) return { error: "Falta 'name'." };
      const suppliers = await deps.listSuppliers();
      const existing = suppliers.find((s) => ci(s.name) === ci(name));
      if (existing) return { ya_existe: true, supplier_id: existing.id, name: existing.name };
      const sp = await deps.insertSupplier(name);
      return { creado: true, supplier_id: sp.id, name: sp.name };
    }
    case "toggle_supplier": {
      const ref = await resolveSupplierRef(deps, str(args, "supplier"));
      if (!ref.ok) return ref.error;
      const active = args["active"] === true;
      await deps.setSupplierActive(ref.supplier.id, active);
      return { ok: true, proveedor: ref.supplier.name, active };
    }
    case "set_price": {
      const ref = await resolveModelRef(deps, str(args, "model"));
      if (!ref.ok) return ref.error;
      const sp = await resolveSupplierRef(deps, str(args, "supplier"));
      if (!sp.ok) return sp.error;
      const price = num(args, "price");
      if (price === null || price <= 0) return { error: "Falta un 'price' válido (> 0)." };
      const prices = await deps.listPrices();
      const prev =
        prices.find((p) => p.model_id === ref.modelId && p.supplier_id === sp.supplier.id)
          ?.price ?? null;
      const row = { model_id: ref.modelId, supplier_id: sp.supplier.id, price };
      await deps.upsertPrice(row);
      await deps.appendPriceHistory(row);
      return {
        ok: true,
        modelo: ref.canonical,
        proveedor: sp.supplier.name,
        precio: price,
        precio_anterior: prev,
        variacion_pct: prev !== null && prev !== 0 ? +(((price - prev) / prev) * 100).toFixed(1) : null,
      };
    }
    case "set_tiers": {
      const ref = await resolveModelRef(deps, str(args, "model"));
      if (!ref.ok) return ref.error;
      const sp = await resolveSupplierRef(deps, str(args, "supplier"));
      if (!sp.ok) return sp.error;
      const tiers = sanitizeTierArgs(args["tiers"]);
      const pair = { model_id: ref.modelId, supplier_id: sp.supplier.id };
      await deps.setTiersForPair(pair, tiers);
      if (tiers.length > 0) {
        // misma semántica que el parser: la celda muestra el mejor precio de la escalera
        const best = Math.min(...tiers.map((t) => t.price));
        await deps.upsertPrice({ ...pair, price: best });
        await deps.appendPriceHistory({ ...pair, price: best });
      }
      return {
        ok: true,
        modelo: ref.canonical,
        proveedor: sp.supplier.name,
        escalones: tiers.length,
        nota: tiers.length === 0 ? "Escalera borrada (quedó precio único)." : undefined,
      };
    }
    case "set_sale_price": {
      const ref = await resolveModelRef(deps, str(args, "model"));
      if (!ref.ok) return ref.error;
      const price = num(args, "price");
      if (price === null) {
        await deps.deleteSalePrice(ref.modelId);
        return { ok: true, modelo: ref.canonical, lista: "automática (Mín + margen)" };
      }
      if (price <= 0) return { error: "El 'price' de Lista debe ser > 0 (u omitido)." };
      await deps.upsertSalePrice({ model_id: ref.modelId, price, manual: true });
      return { ok: true, modelo: ref.canonical, lista: price };
    }
    case "delete_price": {
      const ref = await resolveModelRef(deps, str(args, "model"));
      if (!ref.ok) return ref.error;
      const sp = await resolveSupplierRef(deps, str(args, "supplier"));
      if (!sp.ok) return sp.error;
      await deps.deletePrice({ model_id: ref.modelId, supplier_id: sp.supplier.id });
      return { ok: true, borrado: `${ref.canonical} @ ${sp.supplier.name}` };
    }
    case "load_quote": {
      // La lista pegada EN EL CHAT entra a la MISMA tubería propose-only de la Mesa:
      // extracción Gemini → resolveModel → checks determinísticos → auto-aplica solo lo
      // sano (≤±15% vs par, sin flags de sanidad) → candidatos NUEVOS a la cola de
      // confirmación de la Mesa. La IA jamás crea catálogo.
      const text = str(args, "text");
      if (!text) return { error: "Falta 'text' (pegá la lista cruda del proveedor)." };
      const sp = await resolveSupplierRef(deps, str(args, "supplier"));
      if (!sp.ok) return sp.error;
      const items = await deps.extractQuote({ text });
      if (items.length === 0) {
        return { error: "La IA no encontró ningún producto con precio en el texto." };
      }
      const entries = extractedToQuoteEntries(items);
      const [repo, models, prices] = await Promise.all([
        deps.resolver(),
        deps.listModels(),
        deps.listPrices(),
      ]);
      const nameById = new Map(models.map((m) => [m.id, m.canonical_name]));
      const minByModel = new Map<string, number>();
      const pairPrice = new Map<string, number>();
      for (const p of prices) {
        const cur = minByModel.get(p.model_id);
        if (cur === undefined || p.price < cur) minByModel.set(p.model_id, p.price);
        pairPrice.set(`${p.model_id}:${p.supplier_id}`, p.price);
      }

      const aplicados: Array<Record<string, unknown>> = [];
      const aRevisar: Array<Record<string, unknown>> = [];
      const nuevos: string[] = [];
      const queued: Array<{
        entry: QuoteEntry;
        aliasKey: string;
        supplierId: string;
        supplierName: string;
      }> = [];
      for (const entry of entries) {
        const r = resolveModel(entry.rawName, {}, repo);
        if (!("modelId" in r)) {
          nuevos.push(entry.rawName);
          queued.push({
            entry,
            aliasKey: r.aliasKey,
            supplierId: sp.supplier.id,
            supplierName: sp.supplier.name,
          });
          continue;
        }
        const modelo = nameById.get(r.modelId) ?? entry.rawName;
        const flags = checkQuoteEntry(entry, {
          pairPrice: pairPrice.get(`${r.modelId}:${sp.supplier.id}`) ?? null,
          modelMin: minByModel.get(r.modelId) ?? null,
        });
        if (flags.length > 0) {
          aRevisar.push({
            modelo,
            precio: entry.price,
            motivos: flags.map((f) => f.motivo),
            ...(flags.find((f) => f.sugerencia !== undefined)
              ? { sugerencia: flags.find((f) => f.sugerencia !== undefined)?.sugerencia }
              : {}),
          });
          continue;
        }
        await deps.applyQuoteEntry(r.modelId, sp.supplier.id, entry);
        aplicados.push({
          modelo,
          precio: entry.price,
          ...(entry.tiers.length > 1 ? { escalones: entry.tiers.length } : {}),
        });
      }
      if (queued.length > 0) deps.queueCandidates(queued);
      return {
        proveedor: sp.supplier.name,
        aplicados,
        a_revisar: aRevisar,
        nuevos_en_cola: nuevos,
        nota:
          `Auto-apliqué solo deltas ≤ ±${PRICE_AUTO_THRESHOLD}% y sin flags de sanidad. ` +
          (aRevisar.length
            ? "Los de a_revisar NO se aplicaron: confirmá el precio y usá set_price/set_tiers. "
            : "") +
          (nuevos.length
            ? "Los nuevos quedaron en la COLA DE CONFIRMACIÓN de la Mesa (decile al usuario que los confirme ahí; nada se crea solo)."
            : ""),
      };
    }
    case "whatsapp_list": {
      const [models, categories, departments, prices, sales] = await Promise.all([
        deps.listModels(),
        deps.listCategories(),
        deps.listDepartments(),
        deps.listPrices(),
        deps.listSalePrices(),
      ]);
      const marginPct = num(args, "margin_pct") ?? 3;
      const deptName = str(args, "department");
      const catName = str(args, "category");
      const filter = str(args, "filter").toLowerCase();
      let deptId: string | null = null;
      if (deptName) {
        const dept = findByName(departments, deptName);
        if (!dept) {
          return {
            error: `No existe el departamento "${deptName}".`,
            departamentos: departments.map((d) => d.name),
          };
        }
        deptId = dept.id;
      }
      let catId: string | null = null;
      if (catName) {
        const cat = findByName(categories, catName);
        if (!cat) {
          return {
            error: `No existe la categoría "${catName}".`,
            categorias: categories.map((c) => c.name),
          };
        }
        catId = cat.id;
      }
      const minByModel = new Map<string, number>();
      for (const p of prices) {
        const cur = minByModel.get(p.model_id);
        if (cur === undefined || p.price < cur) minByModel.set(p.model_id, p.price);
      }
      const saleByModel = new Map(sales.map((sale) => [sale.model_id, sale.price]));
      const catNameById = new Map(categories.map((c) => [c.id, c.name]));
      const rows = models
        .filter((m) => deptId === null || m.department_id === deptId)
        .filter((m) => catId === null || m.category_id === catId)
        .filter((m) => filter === "" || m.canonical_name.toLowerCase().includes(filter))
        .map((m) => {
          const min = minByModel.get(m.id) ?? null;
          const price = listaPrice(saleByModel.get(m.id) ?? null, min, min, marginPct);
          return {
            categoria: m.category_id ? (catNameById.get(m.category_id) ?? "Otros") : "Otros",
            name: m.canonical_name,
            price,
          };
        })
        .filter((r) => r.price !== null); // sin ningún precio no se cotiza
      const order = [...categories.map((c) => c.name), "Otros"];
      const groups: WhatsappGroup[] = [];
      for (const cat of order) {
        const items = rows.filter((r) => r.categoria === cat);
        if (items.length && !groups.some((g) => g.category === cat)) {
          groups.push({ category: cat, items: items.map((r) => ({ name: r.name, price: r.price })) });
        }
      }
      if (groups.length === 0) {
        return { error: "Ningún modelo con precio matchea ese filtro." };
      }
      return {
        modelos: rows.length,
        texto_whatsapp: whatsappQuoteText(groups),
        nota: "Mostrale el texto TAL CUAL al usuario (formato WhatsApp: *categoría* en negrita, precio de Lista o Mín+margen).",
      };
    }
    // ---------- consulta / briefing ----------
    case "get_mesa_summary": {
      const [models, categories, departments, suppliers, prices, tiers, sales] =
        await Promise.all([
          deps.listModels(),
          deps.listCategories(),
          deps.listDepartments(),
          deps.listSuppliers(),
          deps.listPrices(),
          deps.listTiers(),
          deps.listSalePrices(),
        ]);
      const marginPct = num(args, "margin_pct") ?? 3;
      const deptName = str(args, "department");
      let deptId: string | null = null;
      if (deptName) {
        const dept = findByName(departments, deptName);
        if (!dept) {
          return {
            error: `No existe el departamento "${deptName}".`,
            departamentos: departments.map((d) => d.name),
          };
        }
        deptId = dept.id;
      }
      const catById = new Map(categories.map((c) => [c.id, c.name]));
      const supplierById = new Map(suppliers.map((s) => [s.id, s.name]));
      const saleByModel = new Map(sales.map((s) => [s.model_id, s.price]));
      const pricesByModel = new Map<string, AgentPriceRow[]>();
      for (const p of prices) {
        const arr = pricesByModel.get(p.model_id);
        if (arr) arr.push(p);
        else pricesByModel.set(p.model_id, [p]);
      }
      const tierPairs = new Set(tiers.map((t) => `${t.model_id}:${t.supplier_id}`));
      const rows = models
        .filter((m) => deptId === null || m.department_id === deptId)
        .map((m) => {
          const rowPrices = pricesByModel.get(m.id) ?? [];
          const bySupplier: Record<string, number> = {};
          for (const p of rowPrices) {
            const name = supplierById.get(p.supplier_id);
            if (name !== undefined) bySupplier[name] = p.price;
          }
          const agg = rowAggregates(
            Object.fromEntries(rowPrices.map((p) => [p.supplier_id, p.price])),
            marginPct,
          );
          return {
            modelo: m.canonical_name,
            categoria: m.category_id ? (catById.get(m.category_id) ?? "Otros") : "Otros",
            precios: bySupplier,
            min: agg.min,
            mediana: agg.med,
            cliente: agg.client,
            lista: saleByModel.get(m.id) ?? null,
            con_escala: rowPrices.some((p) => tierPairs.has(`${m.id}:${p.supplier_id}`)),
          };
        });
      const withPrice = rows.filter((r) => r.min !== null);
      return {
        modelos: rows.length,
        con_precio: withPrice.length,
        margen_pct: marginPct,
        filas: withPrice.slice(0, 300),
        sin_precio: rows.length - withPrice.length,
      };
    }
    case "client_pulse": {
      const [{ invoices, ledger }, clients, ops] = await Promise.all([
        deps.deskData(),
        deps.listClients(),
        deps.listOps(),
      ]);
      const client = str(args, "client");
      const pulse = clientPulse(
        { invoices, ledger, clients, ops },
        client === "" ? undefined : client,
      );
      return { clientes: pulse };
    }
    case "analytics_summary": {
      const periodRaw = str(args, "period");
      const period: PnlPeriod =
        periodRaw === "semana" || periodRaw === "todo" ? periodRaw : "mes";
      const [{ invoices, ledger }, clients, suppliers] = await Promise.all([
        deps.deskData(),
        deps.listClients(),
        deps.listSuppliers(),
      ]);
      const from = periodStart(period);
      const pnl = computePnl({ invoices, ledger }, from);
      const inPeriod = invoices.filter((f) => parseWhen(f.date, f.ts) >= from);
      const aData = analyticsData({ invoices: inPeriod });
      const clientName = new Map(clients.map((c) => [c.id, c.name]));
      const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
      return {
        period,
        ventas: pnl.ventas,
        costo: pnl.costo,
        gastos: pnl.gastos,
        margen_neto: pnl.margen,
        margen_pct: +pnl.margenPct.toFixed(1),
        piezas: pnl.piezas,
        facturas: pnl.sales.length,
        top_clientes: aData.topClientes.slice(0, 5).map((c) => ({
          cliente: clientName.get(c.clientId) ?? c.clientId,
          ventas: c.ventas,
          margen: c.margen,
        })),
        top_proveedores: pnl.supplierRows.slice(0, 5).map((r) => ({
          proveedor: supplierName.get(r.supplierId) ?? r.supplierId,
          compra: r.c,
        })),
      };
    }
    case "cuentas_summary": {
      const sideRaw = str(args, "side");
      const side: Side = sideRaw === "supplier" ? "supplier" : "client";
      const [{ invoices, ledger }, clients, suppliers] = await Promise.all([
        deps.deskData(),
        deps.listClients(),
        deps.listSuppliers(),
      ]);
      const nameById =
        side === "client"
          ? new Map(clients.map((c) => [c.id, c.name]))
          : new Map(suppliers.map((s) => [s.id, s.name]));
      const accounts = computeAccounts({ invoices, ledger }, side);
      const rows = Object.values(accounts)
        .map((a) => ({
          parte: nameById.get(a.partyId) ?? a.partyId,
          saldo: +a.saldo.toFixed(2),
          movimientos: a.rows.length,
        }))
        .sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo));
      return {
        side,
        lectura: side === "client" ? "saldo = lo que NOS DEBEN" : "saldo = lo que LES DEBEMOS",
        cuentas: rows,
      };
    }
    case "best_suppliers": {
      const ref = await resolveModelRef(deps, str(args, "model"));
      if (!ref.ok) return ref.error;
      const qtyRaw = num(args, "qty");
      const qty = qtyRaw !== null && qtyRaw >= 1 ? Math.round(qtyRaw) : 1;
      const [prices, tiers, suppliers] = await Promise.all([
        deps.listPrices(),
        deps.listTiers(),
        deps.listSuppliers(),
      ]);
      const { priceMatrix, tierMatrix } = buildMatrices(prices, tiers);
      const bs = bestSuppliers(
        { prices: priceMatrix, tiers: tierMatrix, supplierList: suppliers.map((s) => s.id) },
        ref.modelId,
        qty,
      );
      const nameById = new Map(suppliers.map((s) => [s.id, s.name]));
      return {
        modelo: ref.canonical,
        qty,
        ranking: bs.ranking.map((r) => ({
          proveedor: nameById.get(r.supplierId) ?? r.supplierId,
          costo: r.cost,
          escala: r.escala,
        })),
        mejor: bs.mejor
          ? { proveedor: nameById.get(bs.mejor.supplierId) ?? bs.mejor.supplierId, costo: bs.mejor.costo }
          : null,
        brecha_con_alternativa: bs.brecha_con_alternativa,
        un_solo_proveedor: bs.un_solo_proveedor,
      };
    }
    default:
      return { error: `Tool desconocida: ${call.name}` };
  }
}

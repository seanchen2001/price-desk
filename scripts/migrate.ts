// Fase 9 — Migración ÚNICA kv (proyecto Supabase VIEJO, tabla kv de blobs) → relacional
// (proyecto NUEVO, SCHEMA.sql). Versionada en el repo y RE-CORRIBLE: si el usuario cargó
// datos en la app vieja después de una corrida, se re-corre con --wipe --yes-wipe antes
// del cutover y deja el proyecto nuevo idéntico a los blobs actuales.
//
// Uso:
//   npm run migrate -- --wipe --yes-wipe    # limpia TODO el proyecto nuevo y migra
//   npm run migrate -- --dry-run            # lee blobs + arma todo en memoria, NO escribe
//
// REGLA ABSOLUTA: al proyecto viejo SOLO se le hacen GET (selects) — jamás se escribe.
// Todo lo no-mapeable va a migration-report.json (+ resumen legible por consola).
//
// Orden del wipe (respetando FKs — hijos primero):
//   invoice_item_units → invoice_items → ops_tracking → ledger → invoices →
//   sale_prices → price_tiers → price_history → prices → snapshots →
//   model_aliases → models → clients → shippings → suppliers →
//   categories → departments → knowledge → chat_log → drafts

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { computeAccounts, type Side } from "../src/domain/accounts";
import { normalize } from "../src/domain/normalize";
import { dmyToISO } from "../src/domain/orders";
import { mondayStart } from "../src/domain/pricing";
import { resolveModel, type ResolverRepo } from "../src/domain/resolver";
import {
  buildDeskInvoices,
  buildLedgerEntries,
} from "../src/features/shared/invoiceInputs";
import type { Database, Json } from "../src/data/database.types";
import type { InvoiceItemRow, InvoiceRow } from "../src/data/invoices";
import type { LedgerRow } from "../src/data/ledger";

type Tables = Database["public"]["Tables"];
type Ins<T extends keyof Tables> = Tables[T]["Insert"];

// ---------- CATALOG base hardcodeado del viejo (extraído de price-logic.js) ----------
// El jsx viejo lo importaba de ./price-logic.js; acá va congelado porque es parte de la
// foto a migrar (los base ocultados viven en hiddenModels, no desaparecen del catálogo).
const OLD_BASE_CATALOG: ReadonlyArray<{ cat: string; name: string }> = [
  { cat: "Samsung", name: "A06 4+64 DS" },
  { cat: "Samsung", name: "A07 4+64 DS" },
  { cat: "Samsung", name: "A07 4+128 DS" },
  { cat: "Samsung", name: "A16 4+128 DS" },
  { cat: "Samsung", name: "A17 4+128 DS" },
  { cat: "Samsung", name: "A26 8+256 5G DS" },
  { cat: "Samsung", name: "A36 6+128 5G DS" },
  { cat: "Samsung", name: "A36 8+256 5G DS" },
  { cat: "Samsung", name: "A37 6+128 5G DS" },
  { cat: "Samsung", name: "A37 8+256 5G DS" },
  { cat: "Samsung", name: "A56 8+128 5G DS" },
  { cat: "Samsung", name: "A56 8+256 5G DS" },
  { cat: "Samsung", name: "A56 12+256 5G DS" },
  { cat: "Samsung", name: "A57 8+128 5G DS" },
  { cat: "Samsung", name: "A57 8+256 5G DS" },
  { cat: "Samsung", name: "A57 12+256 5G DS" },
  { cat: "Samsung", name: "S25 FE 8+256 5G DS" },
  { cat: "Samsung", name: "S25 FE 8+512 5G DS" },
  { cat: "Samsung", name: "S25 ULTRA 12+256 5G DS" },
  { cat: "Samsung", name: "S25 ULTRA 12+512 5G DS" },
  { cat: "Samsung", name: "S25 ULTRA 12+1T 5G DS" },
  { cat: "Samsung", name: "S26 12/256GB 5G" },
  { cat: "Samsung", name: "S26 12/512GB 5G" },
  { cat: "Samsung", name: "S26 Plus 12/256GB 5G" },
  { cat: "Samsung", name: "S26 Plus 12/512GB 5G" },
  { cat: "Samsung", name: "S26 ULTRA 12/256GB 5G" },
  { cat: "Samsung", name: "S26 ULTRA 12/512GB 5G" },
  { cat: "Samsung", name: "S26 ULTRA 12/1TB 5G" },
  { cat: "Motorola LATIN", name: "Motorola G06 4+256" },
  { cat: "Motorola LATIN", name: "Motorola G15 4+256" },
  { cat: "Motorola LATIN", name: "Motorola G17 4+256" },
  { cat: "Motorola LATIN", name: "Motorola G35 4+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola G56 8+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 60 12+512" },
  { cat: "Motorola LATIN", name: "Motorola Edge 60 Fusion 8+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 60 Pro 8+512 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 70 Fusion 8+256 5G" },
  { cat: "Motorola LATIN", name: "Motorola Edge 70 Fusion 8+256 5G - FIFA2026" },
  { cat: "Motorola LATIN", name: "Motorola G86 PWR 8+256" },
  { cat: "Motorola EURO", name: "XT2535 G06 4+256" },
  { cat: "Motorola EURO", name: "XT2527 G86 8+256 5G" },
  { cat: "Motorola EURO", name: "XT2505 Edge 60 8+256" },
  { cat: "Motorola EURO", name: "XT2509 Edge 60 Neo 12+256" },
];

const DEPTS = ["Teléfonos", "iPhone", "Laptops", "Otros"];
const DEFAULT_DEPT = "Teléfonos";
// mismas categorías que siembra la app nueva (departments.ts) — el resto sale de lo observado
const CATEGORY_SEED = ["Samsung", "Motorola LATIN", "Motorola EURO", "iPhone", "Laptops", "Otros"];
// códigos cortos de proveedor (lib/constants.js del viejo) para suppliers.code
const SUPPLIER_CODES: Record<string, string> = {
  planet: "PL", mirgor: "Mir", bax: "Bax", baxcell: "Bax", vitel: "Vit", sh: "SH",
};

// ---------- shapes de los blobs viejos ----------
type OldCatalogEntry = { name?: string; cat?: string; dept?: string };
type OldTier = { min?: number; price?: number };
type OldInvoiceItem = {
  sku?: string; qty?: number; color?: string; spec?: string; supplier?: string;
  cost?: number; price?: number; imei?: string; imeis?: string[]; serials?: string[]; cat?: string;
};
type OldOrder = {
  stage?: string; payment?: string; fob?: string; salesperson?: string; job?: string;
  terms?: string; dueDate?: string; deliveryAddr?: string;
};
type OldInvoice = {
  ts?: number; no?: string | number; date?: string; type?: string; client?: string;
  clientId?: string; shipId?: string; piezas?: number; subtotal?: number; shipping?: number;
  total?: number; cost?: number; margin?: number; supplierCosts?: Record<string, number>;
  items?: OldInvoiceItem[]; order?: OldOrder; clientPdf?: Record<string, unknown>;
};
type OldLedgerEntry = {
  id?: string; ts?: number; side?: string; party?: string; type?: string;
  amount?: number; concept?: string; date?: string; ref?: string;
};
type OldSnapshot = {
  week?: number; ts?: number;
  prices?: Record<string, Record<string, number>>; lista?: Record<string, number>;
};
type OldClient = {
  id?: string; name?: string; address?: string; ruc?: string; phone?: string;
  cuentaCorriente?: boolean; esNuestra?: boolean;
};
type OldShip = {
  id?: string; label?: string; notify?: string; direccion?: string; telefono?: string; contacto?: string;
};
type OldChat = { ts?: number; userText?: string; actions?: unknown; finalText?: string };
type OldOps = { afuera?: boolean; local?: boolean; pago?: boolean; cargamosNosotros?: boolean };
type OldDraft = { id?: string; ts?: number } & Record<string, unknown>;
type OldTrashItem = { id?: string; kind?: string; data?: unknown; deletedAt?: number };

type OldKv = {
  aliases: Record<string, string>;
  catalog: OldCatalogEntry[];
  chatLog: OldChat[];
  clients: OldClient[];
  drafts: OldDraft[];
  hiddenModels: string[];
  invoices: OldInvoice[];
  knowledge: string[];
  ledger: OldLedgerEntry[];
  lista: Record<string, number>;
  ops: Record<string, OldOps>;
  priceHistory: Array<{ sku?: string; sup?: string; price?: number; ts?: number }>;
  prices: Record<string, Record<string, number>>;
  shippings: OldShip[];
  snapshots: OldSnapshot[];
  supplierDepts: Record<string, string[]>;
  suppliers: string[];
  tiers: Record<string, Record<string, OldTier[]>>;
  times: Record<string, Record<string, number>>;
  trash: OldTrashItem[];
};

// ---------- env + REST (PostgREST directo; sin supabase-js para no arrastrar websockets) ----------
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    out[t.slice(0, t.indexOf("=")).trim()] = t.slice(t.indexOf("=") + 1).trim();
  }
  return out;
}

type Rest = {
  get: <T>(path: string) => Promise<T>;
  insert: (table: string, rows: unknown[]) => Promise<void>;
  del: (table: string, pkCol: string) => Promise<void>;
  count: (table: string) => Promise<number>;
};

function rest(base: string, key: string, { readOnly = false } = {}): Rest {
  const url = base.replace(/\/$/, "") + "/rest/v1";
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const fail = async (r: Response, what: string): Promise<never> => {
    throw new Error(`${what} → HTTP ${r.status}: ${await r.text()}`);
  };
  return {
    async get<T>(path: string): Promise<T> {
      const r = await fetch(`${url}/${path}`, { headers });
      if (!r.ok) return fail(r, `GET ${path}`);
      return (await r.json()) as T;
    },
    async insert(table: string, rows: unknown[]): Promise<void> {
      if (readOnly) throw new Error(`INSERT prohibido en base de solo lectura (${table})`);
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const r = await fetch(`${url}/${table}`, {
          method: "POST",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify(chunk),
        });
        if (!r.ok) return fail(r, `INSERT ${table} (${chunk.length} filas)`);
      }
    },
    async del(table: string, pkCol: string): Promise<void> {
      if (readOnly) throw new Error(`DELETE prohibido en base de solo lectura (${table})`);
      const r = await fetch(`${url}/${table}?${pkCol}=not.is.null`, { method: "DELETE", headers });
      if (!r.ok) return fail(r, `DELETE ${table}`);
    },
    async count(table: string): Promise<number> {
      const r = await fetch(`${url}/${table}?select=*&limit=0`, {
        headers: { ...headers, Prefer: "count=exact" },
      });
      if (!r.ok) return fail(r, `COUNT ${table}`);
      return Number((r.headers.get("content-range") ?? "*/0").split("/")[1]) || 0;
    },
  };
}

// ---------- helpers ----------
const iso = (ms: number | undefined | null, fallback?: number): string =>
  new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : (fallback ?? 0)).toISOString();
const isoDateLocal = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;

// canonName del viejo (lib/accounts.js): el hack de aliases que fusiona cuentas por nombre
function canonName(aliases: Record<string, string>, name: string | null | undefined): string {
  const n = (name ?? "—").trim() || "—";
  return aliases[n] ?? n;
}

// PORT 1:1 del computeAccounts VIEJO (lib/accounts.js) — SOLO para la validación
// "totales viejos con la lógica vieja". El orden no afecta el saldo final, así que
// devolvemos directamente { cuentaCanónica → saldo }.
function oldSaldos(kv: OldKv, side: "client" | "supplier"): Record<string, number> {
  const saldo: Record<string, number> = {};
  const add = (party: string, cargo: number, pago: number): void => {
    const p = canonName(kv.aliases, party);
    saldo[p] = (saldo[p] ?? 0) + cargo - pago;
  };
  for (const f of kv.invoices) {
    if (f.type !== "factura") continue;
    if (side === "client") add(f.client || "—", num(f.total), 0);
    else for (const [sp, c] of Object.entries(f.supplierCosts ?? {})) add(sp, num(c), 0);
  }
  for (const e of kv.ledger) {
    if (e.side !== side) continue;
    if (e.type === "cargo" && e.ref) continue; // cargos automáticos viejos → derivados
    const pago = e.type === "pago";
    add(e.party ?? "—", pago ? 0 : num(e.amount), pago ? num(e.amount) : 0);
  }
  return Object.fromEntries(Object.entries(saldo).map(([k, v]) => [k, round2(v)]));
}

// ---------- reporte ----------
type Report = {
  ranAt: string;
  mode: string;
  warnings: string[];
  unresolved: { where: string; raw: string; aliasKey: string; count?: number }[];
  unevenUnits: { invoiceNo: string; sku: string; qty: number; imeis: number; serials: number }[];
  unmappedParties: { where: string; party: string; side: string }[];
  supplierDepts: Record<string, string[]>;
  modelsCreatedOutsideCatalog: string[];
  duplicatePriceCollisions: string[];
  totals?: Record<string, unknown>;
  divergences: string[];
  accounts?: Record<string, unknown>;
};

// ============================== MAIN ==============================
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const wipe = args.has("--wipe");
  const yesWipe = args.has("--yes-wipe");

  const env = loadEnv();
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Falta ${k} en .env`);
    return v;
  };
  // VIEJO: cliente marcado readOnly — el helper tira si algo intentara escribir.
  const oldDb = rest(need("OLD_SUPABASE_URL"), need("OLD_SUPABASE_SERVICE_KEY"), { readOnly: true });
  const newDb = rest(need("VITE_SUPABASE_URL"), need("SUPABASE_SERVICE_KEY"));

  const report: Report = {
    ranAt: new Date().toISOString(),
    mode: dryRun ? "dry-run" : wipe ? "wipe+migrate" : "migrate",
    warnings: [],
    unresolved: [],
    unevenUnits: [],
    unmappedParties: [],
    supplierDepts: {},
    modelsCreatedOutsideCatalog: [],
    duplicatePriceCollisions: [],
    divergences: [],
  };
  const warn = (msg: string): void => {
    report.warnings.push(msg);
    console.warn("⚠️  " + msg);
  };

  // ---------- 1. leer los blobs del kv viejo (SOLO select) ----------
  console.log("Leyendo blobs del proyecto viejo…");
  const kvRows = await oldDb.get<Array<{ key: string; value: unknown }>>("kv?select=key,value");
  const raw = Object.fromEntries(kvRows.map((r) => [r.key, r.value]));
  const kv: OldKv = {
    aliases: (raw["aliases"] ?? {}) as Record<string, string>,
    catalog: (raw["catalog"] ?? []) as OldCatalogEntry[],
    chatLog: (raw["chatLog"] ?? []) as OldChat[],
    clients: (raw["clients"] ?? []) as OldClient[],
    drafts: (raw["drafts"] ?? []) as OldDraft[],
    hiddenModels: (raw["hiddenModels"] ?? []) as string[],
    invoices: (raw["invoices"] ?? []) as OldInvoice[],
    knowledge: (raw["knowledge"] ?? []) as string[],
    ledger: (raw["ledger"] ?? []) as OldLedgerEntry[],
    lista: (raw["lista"] ?? {}) as Record<string, number>,
    ops: (raw["ops"] ?? {}) as Record<string, OldOps>,
    priceHistory: (raw["priceHistory"] ?? []) as OldKv["priceHistory"],
    prices: (raw["prices"] ?? {}) as Record<string, Record<string, number>>,
    shippings: (raw["shippings"] ?? []) as OldShip[],
    snapshots: (raw["snapshots"] ?? []) as OldSnapshot[],
    supplierDepts: (raw["supplierDepts"] ?? {}) as Record<string, string[]>,
    suppliers: (raw["suppliers"] ?? []) as string[],
    tiers: (raw["tiers"] ?? {}) as Record<string, Record<string, OldTier[]>>,
    times: (raw["times"] ?? {}) as Record<string, Record<string, number>>,
    trash: (raw["trash"] ?? []) as OldTrashItem[],
  };
  console.log(
    `  kv: ${kvRows.length} colecciones · catálogo extra ${kv.catalog.length} · precios ${Object.keys(kv.prices).length} skus · facturas ${kv.invoices.length} · ledger ${kv.ledger.length}`,
  );
  report.supplierDepts = kv.supplierDepts; // sin columna en el schema nuevo (ver nota en el resumen)

  // ---------- 2. armar TODO en memoria (ids uuid generados acá) ----------

  // departments: los 4 estándar + los observados (catálogo + supplierDepts)
  const deptNames = [
    ...new Set([
      ...DEPTS,
      ...kv.catalog.map((c) => c.dept).filter((d): d is string => !!d),
      ...Object.values(kv.supplierDepts).flat(),
    ]),
  ];
  const deptId = new Map(deptNames.map((n) => [n, randomUUID()]));
  const departments: Ins<"departments">[] = deptNames.map((name) => ({ id: deptId.get(name) as string, name }));

  // categories: seed de la app nueva + las observadas en CATALOG base y extraCatalog
  const catNames = [
    ...new Set([
      ...CATEGORY_SEED,
      ...OLD_BASE_CATALOG.map((c) => c.cat),
      ...kv.catalog.map((c) => c.cat).filter((c): c is string => !!c),
    ]),
  ];
  const catId = new Map(catNames.map((n) => [n, randomUUID()]));
  const categories: Ins<"categories">[] = catNames.map((name) => ({ id: catId.get(name) as string, name }));

  // suppliers: la lista del kv + cualquier nombre visto en precios/facturas/ledger
  const supplierNames = [...kv.suppliers];
  const supplierKey = (n: string): string => n.trim().toLowerCase();
  const supplierSeen = new Set(supplierNames.map(supplierKey));
  const addSupplierIfNew = (name: string | undefined, where: string): void => {
    const n = String(name ?? "").trim();
    if (!n || supplierSeen.has(supplierKey(n))) return;
    supplierSeen.add(supplierKey(n));
    supplierNames.push(n);
    warn(`Proveedor "${n}" no estaba en la lista de suppliers (visto en ${where}) → creado igual`);
  };
  for (const bySup of Object.values(kv.prices)) for (const sp of Object.keys(bySup)) addSupplierIfNew(sp, "prices");
  for (const bySup of Object.values(kv.tiers)) for (const sp of Object.keys(bySup)) addSupplierIfNew(sp, "tiers");
  for (const bySup of Object.values(kv.times)) for (const sp of Object.keys(bySup)) addSupplierIfNew(sp, "times");
  for (const f of kv.invoices) {
    for (const sp of Object.keys(f.supplierCosts ?? {})) addSupplierIfNew(sp, `factura #${f.no}`);
    for (const it of f.items ?? []) addSupplierIfNew(it.supplier, `items factura #${f.no}`);
  }
  for (const e of kv.ledger) if (e.side === "supplier") addSupplierIfNew(e.party, "ledger");
  const supplierIdByName = new Map<string, string>();
  const suppliers: Ins<"suppliers">[] = supplierNames.map((name) => {
    const id = randomUUID();
    supplierIdByName.set(supplierKey(name), id);
    return { id, name, code: SUPPLIER_CODES[name.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null, active: true };
  });
  const supplierId = (name: string | undefined | null): string | null =>
    name ? (supplierIdByName.get(supplierKey(name)) ?? null) : null;

  // --- modelos + aliases: resolveModel del domain con un repo en memoria que se puebla acá ---
  const byAliasKey = new Map<string, string>();
  const byCanonicalKey = new Map<string, string>();
  const repo: ResolverRepo = {
    findAliasKey: (k) => byAliasKey.get(k) ?? null,
    findModelByKey: (k) => byCanonicalKey.get(k) ?? null,
  };
  const models: Ins<"models">[] = [];
  const modelById = new Map<string, Ins<"models">>();
  const aliases: Ins<"model_aliases">[] = [];
  const seenAliasText = new Set<string>();

  const addAlias = (modelId: string, aliasText: string, aliasKey: string): void => {
    if (byAliasKey.has(aliasKey)) return; // una clave, un modelo (UNIQUE global)
    byAliasKey.set(aliasKey, modelId);
    aliases.push({ id: randomUUID(), model_id: modelId, alias_text: aliasText, alias_key: aliasKey });
  };

  /** Resuelve un nombre; si es nuevo lo CREA (catálogo); siembra el alias de la variante vista. */
  const ensureModel = (rawName: string, ctx: { cat?: string; dept?: string }, source: string): string | null => {
    const name = String(rawName ?? "").trim();
    if (!name) return null;
    const res = resolveModel(name, {}, repo);
    if ("modelId" in res) {
      if (!seenAliasText.has(name)) {
        seenAliasText.add(name);
        addAlias(res.modelId, name, normalize(name)); // variante nueva del mismo modelo → alias
      }
      return res.modelId;
    }
    if (!res.aliasKey) {
      warn(`"${name}" (${source}) normaliza a vacío → salteado`);
      return null;
    }
    const id = randomUUID();
    const row: Ins<"models"> = {
      id,
      canonical_name: name,
      category_id: ctx.cat ? (catId.get(ctx.cat) ?? null) : null,
      department_id: deptId.get(ctx.dept ?? DEFAULT_DEPT) ?? null,
      active: true,
    };
    models.push(row);
    modelById.set(id, row);
    byCanonicalKey.set(res.aliasKey, id);
    seenAliasText.add(name);
    addAlias(id, name, res.aliasKey); // self-alias (contrato de resolverRepo.ts)
    return id;
  };

  /** Solo resuelve (facturas / priceHistory): lo no-resuelto va al reporte, NO crea catálogo. */
  const resolveOnly = (rawName: string, where: string): string | null => {
    const name = String(rawName ?? "").trim();
    if (!name) return null;
    const res = resolveModel(name, {}, repo);
    if ("modelId" in res) {
      if (!seenAliasText.has(name)) {
        seenAliasText.add(name);
        addAlias(res.modelId, name, normalize(name));
      }
      return res.modelId;
    }
    report.unresolved.push({ where, raw: name, aliasKey: res.aliasKey });
    return null;
  };

  // orden de siembra = prioridad canónica: CATALOG base → extraCatalog → precios/lista/tiers/times
  for (const c of OLD_BASE_CATALOG) ensureModel(c.name, { cat: c.cat, dept: DEFAULT_DEPT }, "CATALOG base");
  for (const c of kv.catalog) {
    if (!c.name) continue;
    ensureModel(c.name, { cat: c.cat ?? "Otros", dept: c.dept ?? DEFAULT_DEPT }, "extraCatalog");
  }
  const priceLikeKeys = [
    ...Object.keys(kv.prices),
    ...Object.keys(kv.tiers),
    ...Object.keys(kv.lista),
    ...Object.keys(kv.times),
  ];
  for (const sku of priceLikeKeys) {
    const before = models.length;
    ensureModel(sku, {}, "prices/tiers/lista/times");
    if (models.length > before) report.modelsCreatedOutsideCatalog.push(sku); // no venía del catálogo
  }

  // hiddenModels → active=false; modelos en trash (no hay kind "model" en el viejo) → nada
  for (const name of kv.hiddenModels) {
    const res = resolveModel(name, {}, repo);
    if ("modelId" in res) {
      const m = modelById.get(res.modelId);
      if (m) m.active = false;
    } else warn(`hiddenModels: "${name}" no resuelve a ningún modelo → ignorado`);
  }

  // ---------- 3. precios / tiers / lista / historial / snapshots ----------
  // frescura REAL: updated_at = times[sku][sup]; sin timestamp → sello del ciclo ANTERIOR
  // (domingo pasado), la misma semántica del viejo classifyFreshness(ts=null)="expired".
  const expiredStamp = new Date(mondayStart(new Date()) - 24 * 3600 * 1000).toISOString();
  let pricesWithoutStamp = 0;

  const priceRows = new Map<string, Ins<"prices">>(); // `${model}|${sup}` → fila (canónico GANA: primera escritura)
  for (const [sku, bySup] of Object.entries(kv.prices)) {
    const modelId = ensureModel(sku, {}, "prices");
    if (!modelId) continue;
    for (const [sup, price] of Object.entries(bySup)) {
      if (typeof price !== "number") continue;
      const supId = supplierId(sup);
      if (!supId) continue;
      const k = `${modelId}|${supId}`;
      if (priceRows.has(k)) {
        report.duplicatePriceCollisions.push(`prices: "${sku}" × ${sup} pisa un precio ya migrado del mismo modelo → gana el primero (canónico)`);
        continue;
      }
      const ts = kv.times[sku]?.[sup];
      if (typeof ts !== "number") pricesWithoutStamp++;
      priceRows.set(k, {
        model_id: modelId,
        supplier_id: supId,
        price,
        updated_at: typeof ts === "number" ? iso(ts) : expiredStamp,
      });
    }
  }

  const tierRows: Ins<"price_tiers">[] = [];
  const tierSeen = new Set<string>();
  for (const [sku, bySup] of Object.entries(kv.tiers)) {
    const modelId = ensureModel(sku, {}, "tiers");
    if (!modelId) continue;
    for (const [sup, ladder] of Object.entries(bySup)) {
      const supId = supplierId(sup);
      if (!supId || !Array.isArray(ladder)) continue;
      for (const t of ladder) {
        if (typeof t?.min !== "number" || typeof t?.price !== "number") continue;
        const k = `${modelId}|${supId}|${t.min}`;
        if (tierSeen.has(k)) {
          report.duplicatePriceCollisions.push(`tiers: "${sku}" × ${sup} min=${t.min} duplicado → gana el primero`);
          continue;
        }
        tierSeen.add(k);
        tierRows.push({ model_id: modelId, supplier_id: supId, min_qty: t.min, price: t.price });
      }
    }
  }

  // lista → sale_prices. El viejo solo guarda valores EXPLÍCITOS (lo no guardado se calcula
  // Mín+margen al vuelo) → todo lo migrado es manual=true, igual que el upsert de la Mesa nueva.
  const saleRows = new Map<string, Ins<"sale_prices">>();
  for (const [sku, price] of Object.entries(kv.lista)) {
    if (typeof price !== "number") continue;
    const modelId = ensureModel(sku, {}, "lista");
    if (!modelId) continue;
    if (saleRows.has(modelId)) {
      report.duplicatePriceCollisions.push(`lista: "${sku}" duplica la Lista del mismo modelo → gana el primero`);
      continue;
    }
    saleRows.set(modelId, { model_id: modelId, price, manual: true });
  }

  const historyRows: Ins<"price_history">[] = [];
  let historySkipped = 0;
  for (const h of kv.priceHistory) {
    const modelId = h.sku ? resolveOnly(h.sku, "priceHistory") : null;
    const supId = supplierId(h.sup);
    if (!modelId || !supId || typeof h.price !== "number") {
      historySkipped++;
      continue;
    }
    historyRows.push({ model_id: modelId, supplier_id: supId, price: h.price, ts: iso(h.ts, Date.now()) });
  }

  // snapshots: payload jsonb TAL CUAL (sigue keyeado por nombres — es una foto inmutable
  // del pasado; el reporte lo deja anotado), keyed por week (lunes del ciclo → date).
  const snapshotRows: Ins<"snapshots">[] = kv.snapshots
    .filter((s) => typeof s.week === "number")
    .map((s) => ({
      week: isoDateLocal(s.week as number),
      taken_at: iso(s.ts, s.week),
      payload: JSON.parse(JSON.stringify(s)) as Json,
    }));

  // ---------- 4. actores: clients / shippings ----------
  const clientIdByOldId = new Map<string, string>();
  const clientIdByName = new Map<string, string>();
  const clientRows: Ins<"clients">[] = kv.clients.map((c) => {
    const id = randomUUID();
    if (c.id) clientIdByOldId.set(c.id, id);
    if (c.name) clientIdByName.set(c.name.trim(), id);
    return {
      id,
      name: c.name ?? "—",
      address: c.address ?? null,
      ruc: c.ruc ?? null,
      phone: c.phone ?? null,
      cuenta_corriente: c.cuentaCorriente ?? false,
      es_nuestra: c.esNuestra ?? false,
    };
  });
  const shipIdByOldId = new Map<string, string>();
  const shipRows: Ins<"shippings">[] = kv.shippings.map((s) => {
    const id = randomUUID();
    if (s.id) shipIdByOldId.set(s.id, id);
    return {
      id,
      label: s.label ?? s.notify ?? "—",
      notify: s.notify ?? null,
      direccion: s.direccion ?? null,
      telefono: s.telefono ?? null,
      contacto: s.contacto ?? null,
    };
  });

  // ---------- 5. facturas + items + units + ops ----------
  const invoiceRows: Ins<"invoices">[] = [];
  const itemRows: Ins<"invoice_items">[] = [];
  const unitRows: Ins<"invoice_item_units">[] = [];
  const opsRows: Ins<"ops_tracking">[] = [];
  const invoiceIdByOldTs = new Map<number, string>();
  const invoiceIdByNo = new Map<string, string>();

  const migrateInvoice = (f: OldInvoice, deletedAt: number | null): void => {
    const id = randomUUID();
    if (typeof f.ts === "number") invoiceIdByOldTs.set(f.ts, id);
    if (f.no != null) invoiceIdByNo.set(String(f.no), id);
    const clientId =
      (f.clientId ? clientIdByOldId.get(f.clientId) : undefined) ??
      (f.client ? clientIdByName.get(f.client.trim()) : undefined) ??
      null;
    if ((f.clientId || (f.client && f.client !== "—")) && !clientId)
      report.unmappedParties.push({ where: `factura #${f.no}`, party: f.client ?? f.clientId ?? "?", side: "client" });
    // metadata del template sin columna propia → order_meta DENTRO de client_pdf (domain/orders.ts)
    const o = f.order ?? {};
    const clientPdf = {
      ...(f.clientPdf ?? {}),
      order_meta: {
        payment: o.payment ?? "W/T",
        fob: o.fob ?? "Miami",
        salesperson: o.salesperson ?? "",
        job: o.job ?? "",
        terms: o.terms ?? "Due upon receipt",
        dueDate: o.dueDate ?? "",
        deliveryAddr: o.deliveryAddr ?? "",
      },
    };
    invoiceRows.push({
      id,
      no: String(f.no ?? ""),
      date: dmyToISO(f.date, f.ts ?? Date.now()),
      type: f.type === "remito" ? "remito" : "factura",
      client_id: clientId,
      ship_id: (f.shipId ? shipIdByOldId.get(f.shipId) : undefined) ?? null,
      piezas: Math.round(num(f.piezas)),
      subtotal: num(f.subtotal),
      shipping: num(f.shipping),
      total: num(f.total),
      cost: num(f.cost),
      margin: num(f.margin),
      stage: o.stage ?? "cotizando",
      client_pdf: JSON.parse(JSON.stringify(clientPdf)) as Json,
      created_at: iso(f.ts, Date.now()),
      deleted_at: deletedAt != null ? iso(deletedAt) : null,
    });

    for (const it of f.items ?? []) {
      const itemId = randomUUID();
      const modelId = it.sku ? resolveOnly(it.sku, `items factura #${f.no}`) : null;
      itemRows.push({
        id: itemId,
        invoice_id: id,
        model_id: modelId,
        qty: Math.round(num(it.qty)) || 1,
        color: it.color || null,
        spec: it.spec || null,
        supplier_id: supplierId(it.supplier),
        cost: num(it.cost),
        price: num(it.price),
      });
      // arrays paralelos imeis[]/serials[] → UNA fila por unidad (semántica setUnitsForItem)
      const imeis = (Array.isArray(it.imeis) ? it.imeis : it.imei ? [it.imei] : [])
        .map((x) => String(x).trim())
        .filter(Boolean);
      const serials = (Array.isArray(it.serials) ? it.serials : []).map((x) => String(x).trim()).filter(Boolean);
      if (imeis.length === 0 && serials.length === 0) continue;
      const qty = Math.round(num(it.qty)) || 1;
      if ((imeis.length && imeis.length !== qty) || (serials.length && serials.length !== qty))
        report.unevenUnits.push({
          invoiceNo: String(f.no ?? "?"),
          sku: it.sku ?? "?",
          qty,
          imeis: imeis.length,
          serials: serials.length,
        });
      const units = Math.max(qty, imeis.length, serials.length);
      for (let u = 0; u < units; u++)
        unitRows.push({ item_id: itemId, imei: imeis[u] ?? null, serial: serials[u] ?? null });
    }

    // checkpoints post-venta: fila para toda factura (paridad con facturarOrder), con los
    // checks del viejo si existían (ops keyeado por ts de la factura)
    if (f.type !== "remito") {
      const t = (typeof f.ts === "number" ? kv.ops[String(f.ts)] : undefined) ?? {};
      opsRows.push({
        invoice_id: id,
        afuera: !!t.afuera,
        local: !!t.local,
        pago: !!t.pago,
        cargamos_nosotros: !!t.cargamosNosotros,
      });
    }
  };

  // cronológico (el array viejo viene newest-first)
  for (const f of [...kv.invoices].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) migrateInvoice(f, null);

  // papelero: lo borrado <24h conserva su soft-delete
  for (const t of kv.trash) {
    const d = t.data as Record<string, unknown> | undefined;
    if (t.kind === "invoice" && d) migrateInvoice(d as OldInvoice, t.deletedAt ?? Date.now());
    else if (t.kind === "client" && d) {
      const id = randomUUID();
      const c = d as OldClient;
      clientRows.push({
        id,
        name: c.name ?? "—",
        address: c.address ?? null,
        ruc: c.ruc ?? null,
        phone: c.phone ?? null,
        cuenta_corriente: c.cuentaCorriente ?? false,
        es_nuestra: c.esNuestra ?? false,
        deleted_at: iso(t.deletedAt, Date.now()),
      });
    } else if (t.kind === "shipping" && d) {
      const s = d as OldShip;
      shipRows.push({
        id: randomUUID(),
        label: s.label ?? s.notify ?? "—",
        notify: s.notify ?? null,
        direccion: s.direccion ?? null,
        telefono: s.telefono ?? null,
        contacto: s.contacto ?? null,
        deleted_at: iso(t.deletedAt, Date.now()),
      });
    } else if (t.kind != null) {
      warn(`trash: item kind="${t.kind}" sin equivalente soft-delete en el schema nuevo → queda solo en el reporte`);
    }
  }

  // ---------- 6. ledger (party por NOMBRE + aliases → party_id) ----------
  const ledgerRows: Ins<"ledger">[] = [];
  for (const e of kv.ledger) {
    const side: Side = e.side === "supplier" ? "supplier" : "client";
    // cargos automáticos legacy (type=cargo con ref a factura): la lógica vieja YA los
    // ignoraba (se derivan de la factura) y la nueva deriva el cargo por JOIN → no se migran.
    if (e.type === "cargo" && e.ref) {
      warn(`ledger ${e.id ?? "?"}: cargo automático legacy (ref #${e.ref}) → no migrado, el cargo se deriva de la factura`);
      continue;
    }
    const canon = canonName(kv.aliases, e.party);
    const partyId =
      side === "client"
        ? (clientIdByName.get(canon) ??
          [...clientIdByName.entries()].find(([n]) => n.toLowerCase() === canon.toLowerCase())?.[1] ??
          null)
        : supplierId(canon);
    if (!partyId) {
      report.unmappedParties.push({ where: `ledger ${e.id ?? "?"} (${e.type} ${e.amount})`, party: canon, side });
      continue;
    }
    ledgerRows.push({
      id: randomUUID(),
      ts: iso(e.ts, Date.now()),
      side,
      party_type: side,
      party_id: partyId,
      type: e.type ?? "pago",
      amount: num(e.amount),
      concept: e.concept ?? null,
      date: e.date ? dmyToISO(e.date, e.ts ?? Date.now()) : null,
      ref_invoice_id: (e.ref ? invoiceIdByNo.get(String(e.ref)) : undefined) ?? null,
    });
  }

  // ---------- 7. knowledge / chatLog / drafts ----------
  const knowledgeRows: Ins<"knowledge">[] = kv.knowledge.map((rule) => ({ rule_text: String(rule) }));
  const chatRows: Ins<"chat_log">[] = kv.chatLog.map((c) => ({
    ts: iso(c.ts, Date.now()),
    user_text: c.userText ?? null,
    actions: (c.actions ?? null) as Json,
    final_text: c.finalText ?? null,
  }));
  const draftRows: Ins<"drafts">[] = kv.drafts.map((d) => ({
    payload: JSON.parse(JSON.stringify(d)) as Json,
    updated_at: iso(d.ts, Date.now()),
  }));

  // ---------- 8. escribir en el proyecto nuevo ----------
  // wipe en orden FK-seguro (hijos → padres); pk de sale_prices es model_id y el de
  // ops_tracking es invoice_id (el filtro not.is.null va por esa columna).
  const WIPE_ORDER: Array<[table: string, pk: string]> = [
    ["invoice_item_units", "id"],
    ["invoice_items", "id"],
    ["ops_tracking", "invoice_id"],
    ["ledger", "id"],
    ["invoices", "id"],
    ["sale_prices", "model_id"],
    ["price_tiers", "id"],
    ["price_history", "id"],
    ["prices", "id"],
    ["snapshots", "id"],
    ["model_aliases", "id"],
    ["models", "id"],
    ["clients", "id"],
    ["shippings", "id"],
    ["suppliers", "id"],
    ["categories", "id"],
    ["departments", "id"],
    ["knowledge", "id"],
    ["chat_log", "id"],
    ["drafts", "id"],
  ];

  if (!dryRun) {
    if (wipe) {
      if (!yesWipe)
        throw new Error("--wipe borra TODO el proyecto nuevo: confirmá agregando --yes-wipe");
      console.log("Limpiando el proyecto nuevo (datos demo de fases 5-8 incluidos)…");
      for (const [table, pk] of WIPE_ORDER) await newDb.del(table, pk);
    } else {
      // re-corrible de forma determinística: sobre base NO vacía exigimos wipe explícito
      const existing = await Promise.all(["models", "invoices", "prices", "clients"].map((t) => newDb.count(t)));
      if (existing.some((n) => n > 0))
        throw new Error(
          "El proyecto nuevo ya tiene datos. La migración es un reemplazo total: corré con --wipe --yes-wipe",
        );
    }

    console.log("Insertando en el proyecto nuevo…");
    await newDb.insert("departments", departments);
    await newDb.insert("categories", categories);
    await newDb.insert("suppliers", suppliers);
    await newDb.insert("models", models);
    await newDb.insert("model_aliases", aliases);
    await newDb.insert("prices", [...priceRows.values()]);
    await newDb.insert("price_tiers", tierRows);
    await newDb.insert("sale_prices", [...saleRows.values()]);
    await newDb.insert("price_history", historyRows);
    await newDb.insert("snapshots", snapshotRows);
    await newDb.insert("clients", clientRows);
    await newDb.insert("shippings", shipRows);
    await newDb.insert("invoices", invoiceRows);
    await newDb.insert("invoice_items", itemRows);
    await newDb.insert("invoice_item_units", unitRows);
    await newDb.insert("ops_tracking", opsRows);
    await newDb.insert("ledger", ledgerRows);
    await newDb.insert("knowledge", knowledgeRows);
    await newDb.insert("chat_log", chatRows);
    await newDb.insert("drafts", draftRows);
  }

  // ---------- 9. VALIDACIÓN: totales viejos (lógica vieja) vs migrado (lógica nueva) ----------
  console.log("Validando totales…");

  // — lado viejo, directo de los blobs —
  const oldPriceSkus = Object.entries(kv.prices).filter(([, by]) =>
    Object.values(by).some((v) => typeof v === "number"),
  );
  const oldModelsWithPrice = new Set(
    oldPriceSkus.map(([sku]) => {
      const r = resolveModel(sku, {}, repo);
      return "modelId" in r ? r.modelId : `?${sku}`;
    }),
  ).size;
  const oldFacturas = kv.invoices.filter((f) => f.type === "factura");
  const oldTotals = {
    modelosConPrecio_skusCrudos: oldPriceSkus.length,
    modelosConPrecio_resueltos: oldModelsWithPrice,
    facturas: oldFacturas.length,
    remitos: kv.invoices.length - oldFacturas.length,
    totalFacturado: round2(oldFacturas.reduce((a, f) => a + num(f.total), 0)),
    piezasFacturadas: oldFacturas.reduce((a, f) => a + num(f.piezas), 0),
    ledger: kv.ledger.length,
    saldosClientes: oldSaldos(kv, "client"),
    saldosProveedores: oldSaldos(kv, "supplier"),
  };

  // — lado nuevo: leído DE VUELTA de la base (verifica lo realmente insertado) —
  let newTotals: Record<string, unknown> = {};
  const divergences = report.divergences;
  if (!dryRun) {
    const [nvInvoices, nvItems, nvLedger, nvPrices, nvClients, nvSuppliers] = await Promise.all([
      newDb.get<InvoiceRow[]>("invoices?select=*&order=created_at"),
      newDb.get<InvoiceItemRow[]>("invoice_items?select=*"),
      newDb.get<LedgerRow[]>("ledger?select=*"),
      newDb.get<Array<{ model_id: string }>>("prices?select=model_id"),
      newDb.get<Array<{ id: string; name: string }>>("clients?select=id,name"),
      newDb.get<Array<{ id: string; name: string }>>("suppliers?select=id,name"),
    ]);
    const counts: Record<string, number> = {};
    for (const [t] of WIPE_ORDER) counts[t] = await newDb.count(t);

    const liveInvoices = nvInvoices.filter((f) => !f.deleted_at);
    const facturas = liveInvoices.filter((f) => f.type === "factura");
    const deskInvoices = buildDeskInvoices(liveInvoices, nvItems);
    const ledgerEntries = buildLedgerEntries(nvLedger);
    const clientNameById = new Map(nvClients.map((c) => [c.id, c.name]));
    const supplierNameById = new Map(nvSuppliers.map((s) => [s.id, s.name]));

    // computeAccounts NUEVO (por party_id) → agrupado por nombre canónico (aliases del
    // viejo) para comparar manzanas con manzanas contra la lógica vieja.
    const saldosByCanon = (side: Side): { canon: Record<string, number>; porCuenta: Record<string, number> } => {
      const accs = computeAccounts({ invoices: deskInvoices, ledger: ledgerEntries }, side);
      const canon: Record<string, number> = {};
      const porCuenta: Record<string, number> = {};
      for (const [partyId, acc] of Object.entries(accs)) {
        const nm =
          (side === "client" ? clientNameById.get(partyId) : supplierNameById.get(partyId)) ?? partyId;
        porCuenta[nm] = round2((porCuenta[nm] ?? 0) + acc.saldo);
        const c = canonName(kv.aliases, nm);
        canon[c] = round2((canon[c] ?? 0) + acc.saldo);
      }
      return { canon, porCuenta };
    };
    const cli = saldosByCanon("client");
    const sup = saldosByCanon("supplier");

    newTotals = {
      counts,
      modelosConPrecio: new Set(nvPrices.map((p) => p.model_id)).size,
      facturas: facturas.length,
      remitos: liveInvoices.length - facturas.length,
      totalFacturado: round2(facturas.reduce((a, f) => a + num(f.total), 0)),
      piezasFacturadas: facturas.reduce((a, f) => a + num(f.piezas), 0),
      saldosClientes_porCuentaNueva: cli.porCuenta,
      saldosClientes_agrupadoAliasesViejos: cli.canon,
      saldosProveedores_porCuentaNueva: sup.porCuenta,
      saldosProveedores_agrupadoAliasesViejos: sup.canon,
    };

    // — comparaciones —
    const cmp = (label: string, a: number, b: number): void => {
      if (Math.abs(a - b) > 0.005) divergences.push(`${label}: viejo=${a} vs nuevo=${b}`);
    };
    cmp("modelos con precio", oldTotals.modelosConPrecio_resueltos, newTotals["modelosConPrecio"] as number);
    cmp("nº facturas", oldTotals.facturas, newTotals["facturas"] as number);
    cmp("Σ total facturado", oldTotals.totalFacturado, newTotals["totalFacturado"] as number);
    cmp("Σ piezas facturadas", oldTotals.piezasFacturadas, newTotals["piezasFacturadas"] as number);
    const cmpSaldos = (label: string, olds: Record<string, number>, news: Record<string, number>): void => {
      for (const k of new Set([...Object.keys(olds), ...Object.keys(news)]))
        cmp(`saldo ${label} "${k}"`, olds[k] ?? 0, news[k] ?? 0);
    };
    cmpSaldos("cliente", oldTotals.saldosClientes, cli.canon);
    cmpSaldos("proveedor", oldTotals.saldosProveedores, sup.canon);
    // divergencia ESPERABLE (informativa): las cuentas nuevas van por client_id, sin el
    // hack de aliases — si el agrupado por alias difiere del por-cuenta, avisamos.
    for (const [nm, v] of Object.entries(cli.porCuenta)) {
      const c = canonName(kv.aliases, nm);
      if (c !== nm && Math.abs(v) > 0.005)
        report.warnings.push(
          `NOTA cuentas: la app nueva muestra "${nm}" (saldo ${v}) como cuenta propia; el viejo la fusionaba en "${c}" vía aliases. Decidir en el cutover si se fusionan clientes.`,
        );
    }
  }

  report.totals = { viejo: oldTotals, nuevo: newTotals };
  report.accounts = {
    aliasesDeCuentasViejos: kv.aliases,
  };

  // ---------- 10. reporte ----------
  // agregación de no-resueltos (el mismo sku basura aparece N veces en priceHistory)
  const unresolvedAgg = new Map<string, Report["unresolved"][number]>();
  for (const u of report.unresolved) {
    const k = `${u.where}|${u.raw}`;
    const cur = unresolvedAgg.get(k);
    if (cur) cur.count = (cur.count ?? 1) + 1;
    else unresolvedAgg.set(k, { ...u, count: 1 });
  }
  report.unresolved = [...unresolvedAgg.values()];
  writeFileSync(new URL("../migration-report.json", import.meta.url), JSON.stringify(report, null, 2));

  const n = (x: unknown[]): number => x.length;
  console.log("\n================ RESUMEN MIGRACIÓN ================");
  console.log(`modo: ${report.mode}`);
  console.log(
    `modelos: ${models.length} (${models.filter((m) => m.active === false).length} ocultos) · aliases: ${aliases.length}`,
  );
  console.log(
    `precios: ${priceRows.size} (${pricesWithoutStamp} sin timestamp → sellados expirados) · tiers: ${tierRows.length} · lista: ${saleRows.size} · historial: ${historyRows.length} (${historySkipped} salteados) · snapshots: ${snapshotRows.length}`,
  );
  console.log(
    `clientes: ${clientRows.length} · envíos: ${shipRows.length} · proveedores: ${suppliers.length} · deptos: ${departments.length} · categorías: ${categories.length}`,
  );
  console.log(
    `facturas: ${invoiceRows.length} · items: ${itemRows.length} · unidades (IMEI/serie): ${unitRows.length} · ops: ${opsRows.length}`,
  );
  console.log(
    `ledger: ${ledgerRows.length}/${kv.ledger.length} · knowledge: ${knowledgeRows.length} · chat: ${chatRows.length} · drafts: ${draftRows.length}`,
  );
  console.log(
    `no-resueltos: ${n(report.unresolved)} · arrays desparejos: ${n(report.unevenUnits)} · parties sin mapear: ${n(report.unmappedParties)} · warnings: ${n(report.warnings)}`,
  );
  if (Object.keys(kv.supplierDepts).length)
    console.log(
      `NOTA supplierDepts (sin columna en el schema nuevo; la Mesa nueva asigna columnas por uso): ${JSON.stringify(kv.supplierDepts)}`,
    );
  if (divergences.length) {
    console.log("\n❌ DIVERGENCIAS DE VALIDACIÓN:");
    for (const d of divergences) console.log("   - " + d);
  } else if (!dryRun) {
    console.log("\n✅ VALIDACIÓN OK: totales viejos (lógica vieja) == migrado (lógica nueva).");
  }
  console.log("Reporte completo: migration-report.json");
  console.log("===================================================\n");
}

main().catch((e: unknown) => {
  console.error("MIGRACIÓN ABORTADA:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

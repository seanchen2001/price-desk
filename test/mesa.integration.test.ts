// Fase 5 — verificación del AC de la Mesa contra el Supabase REAL (service key):
// paste de un quote con variantes conflictivas → resolver → CERO modelos auto-creados,
// precios aplicados al model_id correcto, escalas en price_tiers (LA FILA ES UNA),
// lo genuinamente nuevo queda en cola (no en la base).
//
// DECISIÓN (anotada): el seed que deja este test ES la demo coherente de la base
// (departments/categories/proveedores/4 modelos con precios y escala) — se re-corre
// idempotente. Solo lo efímero (modelo del flujo "crear desde la cola" y el alias del
// flujo "vincular") se limpia al final.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WebSocketLike, WebSocketLikeConstructor } from "@supabase/realtime-js";
import type { Database } from "../src/data/database.types";
import type { Db } from "../src/data/supabase";
import { parseQuoteText } from "../src/domain/quoteParser";
import { normalize } from "../src/domain/normalize";

// createClient exige un WebSocket en el entorno (Node < 22); stub tipado, jamás conecta.
class StubWebSocket implements WebSocketLike {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly readyState = 3;
  readonly url = "";
  readonly protocol = "";
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  close(): void {}
  send(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
const stubTransport: WebSocketLikeConstructor = StubWebSocket;
(globalThis as { WebSocket?: unknown }).WebSocket ??= stubTransport;

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && !line.trim().startsWith("#")) {
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
  }
  for (const k of ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_KEY"]) {
    const v = process.env[k];
    if (v && !out[k]) out[k] = v;
  }
  return out;
}

const env = loadEnv();
const url = env["VITE_SUPABASE_URL"] ?? "";
const serviceKey = env["SUPABASE_SERVICE_KEY"] ?? "";
const hasEnv = url !== "" && serviceKey !== "";
const TIMEOUT = 30_000;

// el quote del AC: escalas + variante regional + prefijo "Galaxy" + un modelo nuevo
const QUOTE = [
  "S26 12+512 5G DS (20 pcs) 610",
  "S26 12+512 5G DS (50+ pcs) 595",
  "Galaxy S26 12+512 5G DS 620",
  "iPhone 17 Pro 256GB Blue US Specs 999",
  "iPhone 18 Fold 1TB 1500",
].join("\n");

// seed demo (queda en la base): modelos reales con depto/categoría
const DEMO_MODELS: ReadonlyArray<{ name: string; dept: string; cat: string }> = [
  { name: "S26 12+512 5G DS", dept: "Teléfonos", cat: "Samsung" },
  { name: "S26 ULTRA 12/512GB 5G", dept: "Teléfonos", cat: "Samsung" },
  { name: "iPhone 17 Pro 256GB Blue", dept: "iPhone", cat: "iPhone" },
  { name: "iPhone 17 Pro 256GB Orange", dept: "iPhone", cat: "iPhone" },
];

describe.skipIf(!hasEnv)("Fase 5 — Mesa: paste → resolver → cero duplicados (AC)", () => {
  let db: Db;
  let repo: typeof import("../src/data/resolverRepo");
  let apply: typeof import("../src/features/mesa/applyQuote");
  let departments: typeof import("../src/data/departments");

  const stamp = `f5it${Date.now()}`;
  let planetId = "";
  let vitelId = "";
  let s26Id = "";
  let iphoneBlueId = "";
  const ephemeralModelIds: string[] = [];
  const ephemeralAliasKeys: string[] = [];

  async function supplierIdByName(name: string): Promise<string> {
    const found = await db.from("suppliers").select("id").eq("name", name).maybeSingle();
    if (found.error) throw found.error;
    if (found.data) return found.data.id;
    const ins = await db.from("suppliers").insert({ name }).select("id").single();
    if (ins.error) throw ins.error;
    return ins.data.id;
  }

  async function idByName(table: "departments" | "categories", name: string): Promise<string> {
    const res = await db.from(table).select("id").eq("name", name).single();
    if (res.error) throw res.error;
    return res.data.id;
  }

  async function ensureModel(name: string, dept: string, cat: string): Promise<string> {
    const r = await repo.resolveModelAsync(name, {}, db);
    if ("modelId" in r) return r.modelId;
    const model = await repo.createModelWithAlias(
      name,
      { department_id: await idByName("departments", dept), category_id: await idByName("categories", cat) },
      db,
    );
    return model.id;
  }

  // OJO: nada de counts GLOBALES de models acá — la suite corre en paralelo contra la
  // misma base real (data.integration.test.ts crea modelos propios) y un count global es
  // carrera perdida. El AC "cero auto-creados" se prueba por IDENTIDAD: las líneas del
  // quote resuelven exactamente a los modelos sembrados y la nueva sigue sin existir.
  async function modelExistsForKey(aliasKey: string): Promise<boolean> {
    const res = await db
      .from("model_aliases")
      .select("model_id")
      .eq("alias_key", aliasKey)
      .maybeSingle();
    if (res.error) throw res.error;
    return res.data !== null;
  }

  async function countModelsNamed(name: string): Promise<number> {
    const res = await db
      .from("models")
      .select("id", { count: "exact", head: true })
      .eq("canonical_name", name);
    if (res.error) throw res.error;
    return res.count ?? 0;
  }

  beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    db = createClient<Database>(url, serviceKey);
    repo = await import("../src/data/resolverRepo");
    apply = await import("../src/features/mesa/applyQuote");
    departments = await import("../src/data/departments");

    // seed idempotente: departamentos + categorías + proveedores + modelos demo
    await departments.ensureCatalogSeed(db);
    planetId = await supplierIdByName("planET");
    vitelId = await supplierIdByName("VITEL");
    for (const m of DEMO_MODELS) await ensureModel(m.name, m.dept, m.cat);
    s26Id = await ensureModel("S26 12+512 5G DS", "Teléfonos", "Samsung");
    iphoneBlueId = await ensureModel("iPhone 17 Pro 256GB Blue", "iPhone", "iPhone");
  }, TIMEOUT);

  afterAll(async () => {
    // limpiar SOLO lo efímero; la demo queda
    for (const key of ephemeralAliasKeys) {
      await db.from("model_aliases").delete().eq("alias_key", key);
    }
    for (const id of ephemeralModelIds) {
      await db.from("models").delete().eq("id", id); // cascade: aliases/prices/tiers/history
    }
  }, TIMEOUT);

  it(
    "el quote conflictivo resuelve TODO al modelo base; el nuevo queda como candidato",
    async () => {
      const { entries, unparsed } = parseQuoteText(QUOTE);
      expect(unparsed).toEqual([]);
      // 5 líneas → 3 entradas (las 3 variantes S26 plegadas en una)
      expect(entries).toHaveLength(3);

      const plan = await apply.planQuote(entries, db);

      expect(plan.matched).toHaveLength(2);
      const byModel = new Map(plan.matched.map((m) => [m.modelId, m.entry]));
      expect([...byModel.keys()].sort()).toEqual([s26Id, iphoneBlueId].sort());
      // única candidata: la línea genuinamente nueva → cola, NO base
      expect(plan.candidates).toHaveLength(1);
      expect(plan.candidates[0]!.entry.rawName).toBe("iPhone 18 Fold 1TB");

      // aplicar los matches (lo que hace el botón "Aplicar")
      for (const m of plan.matched) await apply.applyEntry(m.modelId, planetId, m.entry, db);
      // precio de un segundo proveedor para que Mín/Medio tengan sentido en la demo
      await apply.applyEntry(
        s26Id,
        vitelId,
        { rawName: "S26 12+512 5G DS", aliasKey: normalize("S26 12+512 5G DS"), price: 618, tiers: [], lines: [] },
        db,
      );

      // ★ CERO modelos auto-creados: cada línea del quote sigue resolviendo a los modelos
      // sembrados (ninguna variante bifurcó) y el candidato nuevo NO existe en la base
      for (const line of ["S26 12+512 5G DS (20 pcs)", "Galaxy S26 12+512 5G DS"]) {
        expect(await repo.resolveModelAsync(line, {}, db)).toEqual({ modelId: s26Id });
      }
      expect(await repo.resolveModelAsync("iPhone 17 Pro 256GB Blue US Specs", {}, db)).toEqual({
        modelId: iphoneBlueId,
      });
      expect(await modelExistsForKey(normalize("iPhone 18 Fold 1TB"))).toBe(false);
      expect(await countModelsNamed("iPhone 18 Fold 1TB")).toBe(0);

      // precios al model_id correcto (S26: el mejor de la escalera, semántica del viejo)
      const s26Price = await db
        .from("prices")
        .select("price")
        .eq("model_id", s26Id)
        .eq("supplier_id", planetId)
        .single();
      expect(s26Price.error).toBeNull();
      expect(s26Price.data?.price).toBe(595);

      const bluePrice = await db
        .from("prices")
        .select("price")
        .eq("model_id", iphoneBlueId)
        .eq("supplier_id", planetId)
        .single();
      expect(bluePrice.data?.price).toBe(999);

      // escalas al par (modelo, proveedor): 1/20/50 — LA FILA ES UNA SOLA
      const tiers = await db
        .from("price_tiers")
        .select("min_qty, price")
        .eq("model_id", s26Id)
        .eq("supplier_id", planetId)
        .order("min_qty");
      expect(tiers.error).toBeNull();
      expect(tiers.data).toEqual([
        { min_qty: 1, price: 620 },
        { min_qty: 20, price: 610 },
        { min_qty: 50, price: 595 },
      ]);

      // el candidato NO existe en la base: re-resolver lo sigue dando como nuevo
      const again = await repo.resolveModelAsync("iPhone 18 Fold 1TB", {}, db);
      expect("candidateNew" in again).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "re-parsear el mismo quote es idempotente (aprendizaje del resolver, no duplica)",
    async () => {
      const { entries } = parseQuoteText(QUOTE);
      const plan = await apply.planQuote(entries, db);
      expect(plan.matched).toHaveLength(2);
      expect(plan.candidates).toHaveLength(1);
      for (const m of plan.matched) await apply.applyEntry(m.modelId, planetId, m.entry, db);
      // sigue habiendo UN solo modelo por identidad (upsert por fila, cero bifurcación)
      expect(await countModelsNamed("S26 12+512 5G DS")).toBe(1);
      expect(await countModelsNamed("iPhone 17 Pro 256GB Blue")).toBe(1);
      expect(await modelExistsForKey(normalize("iPhone 18 Fold 1TB"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "cola de confirmación — 'vincular a existente' escribe el alias y aplica el precio",
    async () => {
      const aliasText = `S26 12+512 5G DS PROMO ${stamp}`; // variante que normalize NO pliega
      const r = await repo.resolveModelAsync(aliasText, {}, db);
      expect("candidateNew" in r).toBe(true);

      await repo.confirmCandidate(aliasText, s26Id, db);
      ephemeralAliasKeys.push(normalize(aliasText));

      // determinístico para siempre
      const r2 = await repo.resolveModelAsync(aliasText, {}, db);
      expect(r2).toEqual({ modelId: s26Id });
    },
    TIMEOUT,
  );

  it(
    "cola de confirmación — 'crear modelo nuevo' crea UNA vez y aplica precio + tiers",
    async () => {
      const name = `Tablet Demo ${stamp} 8+256`;
      const model = await repo.createModelWithAlias(
        name,
        { department_id: await idByName("departments", "Otros") },
        db,
      );
      ephemeralModelIds.push(model.id);
      expect(await countModelsNamed(name)).toBe(1);

      await apply.applyEntry(
        model.id,
        planetId,
        {
          rawName: name,
          aliasKey: normalize(name),
          price: 300,
          tiers: [
            { min_qty: 1, price: 310 },
            { min_qty: 10, price: 300 },
          ],
          lines: [],
        },
        db,
      );
      const tiers = await db
        .from("price_tiers")
        .select("min_qty, price")
        .eq("model_id", model.id)
        .eq("supplier_id", planetId)
        .order("min_qty");
      expect(tiers.data).toEqual([
        { min_qty: 1, price: 310 },
        { min_qty: 10, price: 300 },
      ]);

      // volver a crear el MISMO modelo falla ruidoso (jamás duplicado)
      await expect(repo.createModelWithAlias(name, {}, db)).rejects.toThrow(/Ya existe/);
      expect(await countModelsNamed(name)).toBe(1);
    },
    TIMEOUT,
  );
});

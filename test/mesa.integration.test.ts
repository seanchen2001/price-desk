// Fase 5 — verificación del AC de la Mesa contra el Supabase REAL (service key):
// paste de un quote con variantes conflictivas → resolver → CERO modelos auto-creados,
// precios aplicados al model_id correcto, escalas en price_tiers (LA FILA ES UNA),
// lo genuinamente nuevo queda en cola (no en la base).
//
// DECISIÓN (Fase 9): la base ya tiene los datos REALES migrados — este test NO puede
// tocar modelos reales (antes sembraba "S26 12+512 5G DS" de verdad y pisaba precios y
// escalas migrados). Ahora TODOS los modelos del test llevan el stamp y se borran al
// final (cascade limpia aliases/prices/tiers/history). Los proveedores planET/VITEL se
// reutilizan si existen (solo se les agregan precios de modelos del test, que caen con
// el cascade del modelo).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { installWebSocketStub } from "../scripts/lib/db";
import { loadDeskEnv } from "../scripts/lib/env";
import type { Database } from "../src/data/database.types";
import type { Db } from "../src/data/supabase";
import { parseQuoteText } from "../src/domain/quoteParser";
import { normalize } from "../src/domain/normalize";

// createClient exige un WebSocket en el entorno (Node < 22); stub tipado, jamás conecta.
installWebSocketStub();


const env = loadDeskEnv();
const url = env["VITE_SUPABASE_URL"] ?? "";
const serviceKey = env["SUPABASE_SERVICE_KEY"] ?? "";
const hasEnv = url !== "" && serviceKey !== "";
const TIMEOUT = 30_000;

describe.skipIf(!hasEnv)("Fase 5 — Mesa: paste → resolver → cero duplicados (AC)", () => {
  let db: Db;
  let repo: typeof import("../src/data/resolverRepo");
  let apply: typeof import("../src/features/mesa/applyQuote");
  let departments: typeof import("../src/data/departments");

  const stamp = `f5it${Date.now()}`;

  // modelos DEL TEST (stampeados — jamás nombres reales del catálogo migrado)
  const S26 = `S26 ${stamp} 12+512 5G DS`;
  const IPHONE_BLUE = `iPhone ${stamp} 17 Pro 256GB Blue`;
  const IPHONE_ORANGE = `iPhone ${stamp} 17 Pro 256GB Orange`;
  const S26_ULTRA = `S26 ULTRA ${stamp} 12/512GB 5G`;
  const NEW_MODEL = `iPhone ${stamp} 18 Fold 1TB`;

  // el quote del AC: escalas + variante regional + prefijo "Galaxy" + un modelo nuevo
  const QUOTE = [
    `${S26} (20 pcs) 610`,
    `${S26} (50+ pcs) 595`,
    `Galaxy ${S26} 620`,
    `${IPHONE_BLUE} US Specs 999`,
    `${NEW_MODEL} 1500`,
  ].join("\n");

  const DEMO_MODELS: ReadonlyArray<{ name: string; dept: string; cat: string }> = [
    { name: S26, dept: "Teléfonos", cat: "Samsung" },
    { name: S26_ULTRA, dept: "Teléfonos", cat: "Samsung" },
    { name: IPHONE_BLUE, dept: "iPhone", cat: "iPhone" },
    { name: IPHONE_ORANGE, dept: "iPhone", cat: "iPhone" },
  ];
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
    ephemeralModelIds.push(model.id); // stampeado: se limpia SIEMPRE al final
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

    // seed: departamentos + categorías (idempotente) + modelos DEL TEST (stampeados)
    await departments.ensureCatalogSeed(db);
    planetId = await supplierIdByName("planET");
    vitelId = await supplierIdByName("VITEL");
    for (const m of DEMO_MODELS) await ensureModel(m.name, m.dept, m.cat);
    s26Id = await ensureModel(S26, "Teléfonos", "Samsung");
    iphoneBlueId = await ensureModel(IPHONE_BLUE, "iPhone", "iPhone");
  }, TIMEOUT);

  afterAll(async () => {
    // limpiar TODO lo del test (models cascadea aliases/prices/tiers/history)
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
      expect(plan.candidates[0]!.entry.rawName).toBe(NEW_MODEL);

      // aplicar los matches (lo que hace el botón "Aplicar")
      for (const m of plan.matched) await apply.applyEntry(m.modelId, planetId, m.entry, db);
      // precio de un segundo proveedor para que Mín/Medio tengan sentido
      await apply.applyEntry(
        s26Id,
        vitelId,
        { rawName: S26, aliasKey: normalize(S26), price: 618, tiers: [], lines: [] },
        db,
      );

      // ★ CERO modelos auto-creados: cada línea del quote sigue resolviendo a los modelos
      // sembrados (ninguna variante bifurcó) y el candidato nuevo NO existe en la base
      for (const line of [`${S26} (20 pcs)`, `Galaxy ${S26}`]) {
        expect(await repo.resolveModelAsync(line, {}, db)).toEqual({ modelId: s26Id });
      }
      expect(await repo.resolveModelAsync(`${IPHONE_BLUE} US Specs`, {}, db)).toEqual({
        modelId: iphoneBlueId,
      });
      expect(await modelExistsForKey(normalize(NEW_MODEL))).toBe(false);
      expect(await countModelsNamed(NEW_MODEL)).toBe(0);

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
      const again = await repo.resolveModelAsync(NEW_MODEL, {}, db);
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
      expect(await countModelsNamed(S26)).toBe(1);
      expect(await countModelsNamed(IPHONE_BLUE)).toBe(1);
      expect(await modelExistsForKey(normalize(NEW_MODEL))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "cola de confirmación — 'vincular a existente' escribe el alias y aplica el precio",
    async () => {
      const aliasText = `${S26} PROMO`; // variante que normalize NO pliega
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

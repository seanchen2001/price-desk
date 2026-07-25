// Fase 4 — test de integración contra el Supabase REAL (service key): simula DOS
// clientes (dos dispositivos) mutando precios del MISMO modelo. El bug viejo era el
// whole-object overwrite (guardar un mapa entero pisaba las filas del otro); acá se
// verifica que las mutaciones POR FILA no se pisan.
//
// Se SKIPEA si no hay .env (CI de GitHub sin secrets): los módulos de src/data/ se
// importan DINÁMICAMENTE dentro del describe para no evaluar src/data/supabase.ts
// (que exige las env vars) durante la colección.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { installWebSocketStub } from "../scripts/lib/db";
import { loadDeskEnv } from "../scripts/lib/env";
import type { Database } from "../src/data/database.types";
import type { Db } from "../src/data/supabase";

// Este test NO usa Realtime, pero createClient exige un WebSocket en el entorno
// (Node < 22 no trae uno nativo). Stub tipado, jamás se conecta; se registra como
// global ANTES de importar src/data/ (cuyo cliente compartido también lo exige).
installWebSocketStub();


const env = loadDeskEnv();
const url = env["VITE_SUPABASE_URL"] ?? "";
const serviceKey = env["SUPABASE_SERVICE_KEY"] ?? "";
const hasEnv = url !== "" && serviceKey !== "";

const TIMEOUT = 30_000;

describe.skipIf(!hasEnv)("Fase 4 — capa de datos: dos clientes contra Supabase real", () => {
  // dos createClient independientes = dos pestañas/dispositivos
  let A: Db;
  let B: Db;
  let prices: typeof import("../src/data/prices");
  let repo: typeof import("../src/data/resolverRepo");
  let suppliersMod: typeof import("../src/data/suppliers");

  const stamp = `f4it${Date.now()}`;
  const createdModelIds: string[] = [];
  const createdSupplierIds: string[] = [];
  let modelId = "";
  let s1 = "";
  let s2 = "";

  beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const opts = {
      auth: { persistSession: false, autoRefreshToken: false },
    };
    A = createClient<Database>(url, serviceKey, opts);
    B = createClient<Database>(url, serviceKey, opts);
    prices = await import("../src/data/prices");
    repo = await import("../src/data/resolverRepo");
    suppliersMod = await import("../src/data/suppliers");

    const model = await repo.createModelWithAlias(`Modelo IT ${stamp}`, {}, A);
    createdModelIds.push(model.id);
    modelId = model.id;
    const sa = await suppliersMod.insertSupplier({ name: `Prov IT A ${stamp}` }, A);
    const sb = await suppliersMod.insertSupplier({ name: `Prov IT B ${stamp}` }, B);
    createdSupplierIds.push(sa.id, sb.id);
    s1 = sa.id;
    s2 = sb.id;
  }, TIMEOUT);

  afterAll(async () => {
    // limpieza: models cascadea aliases/prices/tiers; después los suppliers
    for (const id of createdModelIds) {
      await A.from("models").delete().eq("id", id);
    }
    for (const id of createdSupplierIds) {
      await A.from("suppliers").delete().eq("id", id);
    }
  }, TIMEOUT);

  it(
    "cliente A y cliente B upsertean precios de proveedores DISTINTOS del mismo modelo → ambos sobreviven",
    async () => {
      await Promise.all([
        prices.upsertPrice({ model_id: modelId, supplier_id: s1, price: 100 }, A),
        prices.upsertPrice({ model_id: modelId, supplier_id: s2, price: 200 }, B),
      ]);
      const rows = await prices.listPrices(modelId, A);
      expect(rows).toHaveLength(2); // el bug viejo (whole-object overwrite) dejaba UNA
      const p1 = rows.find((r) => r.supplier_id === s1);
      const p2 = rows.find((r) => r.supplier_id === s2);
      expect(p1?.price).toBe(100);
      expect(p2?.price).toBe(200);
    },
    TIMEOUT,
  );

  it(
    "update concurrente de la MISMA fila: last-writer gana ESA fila, la otra fila queda intacta",
    async () => {
      await Promise.all([
        prices.upsertPrice({ model_id: modelId, supplier_id: s1, price: 111 }, A),
        prices.upsertPrice({ model_id: modelId, supplier_id: s1, price: 222 }, B),
      ]);
      let rows = await prices.listPrices(modelId, A);
      expect(rows).toHaveLength(2); // nada se borró
      const concurrent = rows.find((r) => r.supplier_id === s1);
      expect([111, 222]).toContain(concurrent?.price); // uno de los dos ganó la fila

      // determinístico: B escribe último → gana B, y la fila de s2 sigue intacta
      await prices.upsertPrice({ model_id: modelId, supplier_id: s1, price: 333 }, A);
      await prices.upsertPrice({ model_id: modelId, supplier_id: s1, price: 444 }, B);
      rows = await prices.listPrices(modelId, B);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.supplier_id === s1)?.price).toBe(444);
      expect(rows.find((r) => r.supplier_id === s2)?.price).toBe(200);
    },
    TIMEOUT,
  );

  it(
    "escalas por cantidad: tiers por fila del par (model, supplier), sin tocar otros pares",
    async () => {
      await prices.setTiersForPair(
        { model_id: modelId, supplier_id: s1 },
        [
          { min_qty: 10, price: 95 },
          { min_qty: 20, price: 90 },
        ],
        A,
      );
      await prices.upsertTier({ model_id: modelId, supplier_id: s2, min_qty: 5, price: 195 }, B);
      const tiers = await prices.listTiers(modelId, A);
      expect(tiers.filter((t) => t.supplier_id === s1)).toHaveLength(2);
      expect(tiers.filter((t) => t.supplier_id === s2)).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "resolverRepo real: self-alias al crear + variantes mecánicas + confirmCandidate aprendido",
    async () => {
      const model = await repo.createModelWithAlias(`S26 Ultra 12/512 ${stamp}`, {}, A);
      createdModelIds.push(model.id);

      // variantes mecánicas (mayúsculas, "(20 pcs)", "US SPECS", prefijo Galaxy) → mismo model
      const variantes = [
        `S26 ULTRA 12/512 ${stamp}`,
        `S26 Ultra 12/512 ${stamp} (20 pcs)`,
        `Galaxy S26 Ultra 12/512 ${stamp} US SPECS`,
      ];
      for (const v of variantes) {
        expect(await repo.resolveModelAsync(v, {}, B)).toEqual({ modelId: model.id });
      }

      // duplicado canónico → falla ruidoso, NO crea otro modelo
      await expect(repo.createModelWithAlias(`s26 ultra 12/512 ${stamp}`, {}, B)).rejects.toThrow();

      // variante NO mecánica → candidateNew → confirmCandidate → determinístico para siempre
      const raro = `Galaxy S26 Ultra 12GB/512GB ${stamp}`;
      const r1 = await repo.resolveModelAsync(raro, {}, B);
      expect(r1).toHaveProperty("candidateNew");
      await repo.confirmCandidate(raro, model.id, B);
      expect(await repo.resolveModelAsync(raro, {}, A)).toEqual({ modelId: model.id });
    },
    TIMEOUT,
  );
});

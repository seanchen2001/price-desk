// Cotizador (sourcing planner) — portado de cotizador.test.mjs (repo viejo), con las
// claves de fixture actuando como supplierId/modelId (la matemática es la misma).
// PORT-NOTE: las líneas del plan usan { modelId, qty, price } (viejo: sku).
import { describe, it, expect } from "vitest";
import {
  planBestPrice,
  planMinSuppliers,
  costForQty,
  hasTiers,
  bestSuppliers,
  type PriceMatrix,
  type TierMatrix,
} from "../src/domain/planning";

// Fixture donde mejor-precio y mínimos-proveedores DIVERGEN.
// VITEL solo cubre A,B,C (costo 66); el más barato de cada uno usa 3 proveedores (costo 60).
const prices: PriceMatrix = {
  A: { planET: 10, VITEL: 11 },
  B: { SH: 20, VITEL: 22 },
  C: { Bax: 30, VITEL: 33 },
  D: {}, // nadie tiene D
};
const needed = { A: 1, B: 1, C: 1, D: 1 };

describe("planBestPrice", () => {
  it("cada modelo al proveedor más barato", () => {
    const bp = planBestPrice(needed, prices);
    expect(bp.total).toBe(60); // 10+20+30
    expect(bp.suppliers).toHaveLength(3);
    expect(bp.suppliers).toEqual(expect.arrayContaining(["planET", "SH", "Bax"]));
    expect(bp.uncoverable).toEqual(["D"]);
    expect(bp.bySupplier["planET"]).toEqual([{ modelId: "A", qty: 1, price: 10 }]);
  });

  it("la cantidad escala el costo", () => {
    expect(planBestPrice({ A: 2, C: 3 }, prices).total).toBe(2 * 10 + 3 * 30);
  });

  it("modelo con un solo candidato barato va al más barato", () => {
    expect(planBestPrice({ B: 1 }, prices).suppliers).toEqual(["SH"]);
  });
});

describe("planMinSuppliers", () => {
  it("mínimos proveedores a contactar, desempate por costo", () => {
    const ms = planMinSuppliers(needed, prices);
    expect(ms.suppliers).toEqual(["VITEL"]);
    expect(ms.total).toBe(66); // 11+22+33
    expect(ms.uncoverable).toEqual(["D"]);
    // menos proveedores cuesta un poco más (el trade-off)
    expect(ms.total).toBeGreaterThan(planBestPrice(needed, prices).total);
  });

  it("proveedor obligatorio: único que tiene un modelo entra sí o sí", () => {
    const p2: PriceMatrix = { X: { planET: 5, VITEL: 6 }, Y: { Bax: 9 } };
    const ms2 = planMinSuppliers({ X: 1, Y: 1 }, p2);
    expect(ms2.suppliers).toContain("Bax");
    expect(ms2.suppliers).toHaveLength(2); // nadie tiene X e Y juntos
  });
});

describe("tiers (escalas por cantidad)", () => {
  const tprices: PriceMatrix = { m1: { s1: 100, s2: 95 } };
  const tiers: TierMatrix = { m1: { s1: [{ min: 1, price: 100 }, { min: 10, price: 90 }] } };

  it("costForQty usa la escala si existe, si no el precio base", () => {
    expect(costForQty(tprices, tiers, "m1", "s1", 1)).toBe(100);
    expect(costForQty(tprices, tiers, "m1", "s1", 10)).toBe(90);
    expect(costForQty(tprices, tiers, "m1", "s2", 10)).toBe(95);
    expect(costForQty(tprices, tiers, "m1", "sX", 1)).toBe(0);
  });

  it("hasTiers pide más de un escalón", () => {
    expect(hasTiers(tiers, "m1", "s1")).toBe(true);
    expect(hasTiers(tiers, "m1", "s2")).toBe(false);
  });

  it("bestSuppliers rankea por costo a la cantidad (respeta tiers)", () => {
    const env = { prices: tprices, tiers, prevSnap: null, supplierList: ["s1", "s2"] };
    expect(bestSuppliers(env, "m1", 1).mejor).toEqual({ supplierId: "s2", costo: 95 });
    const at10 = bestSuppliers(env, "m1", 10);
    expect(at10.mejor).toEqual({ supplierId: "s1", costo: 90 });
    expect(at10.brecha_con_alternativa).toBe(5);
    expect(at10.un_solo_proveedor).toBe(false);
  });
});

// P4 — QA de precios: golden con UN defecto plantado por detector (y un modelo limpio
// que no dispara nada). runQa es puro y determinístico: ids estables, severidades y
// suggestedFix como tool call gateado.
import { describe, expect, it } from "vitest";
import { qaCounts, runQa, type QaSnapshot } from "../src/domain/qa";

const NOW = Date.parse("2026-07-22T15:00:00");
const FRESH = new Date(NOW - 3600_000).toISOString(); // 1h — mismo ciclo
const EXPIRED = new Date(NOW - 8 * 86400_000).toISOString(); // 8 días — ciclo vencido

function snapshot(): QaSnapshot {
  return {
    now: NOW,
    models: [
      { id: "ok", canonical_name: "Limpio 8+256", category_id: "c1", department_id: "d1" },
      { id: "mL", canonical_name: "Escalera 8+256", category_id: "c1", department_id: "d1" },
      { id: "mU", canonical_name: "Unidad 8+256", category_id: "c1", department_id: "d1" },
      { id: "mM", canonical_name: "Mediana 8+256", category_id: "c1", department_id: "d1" },
      { id: "mLB", canonical_name: "ListaBaja 8+256", category_id: "c1", department_id: "d1" },
      { id: "mNC", canonical_name: "SinCategoria 8+256", category_id: null, department_id: "d1" },
      // par de duplicados sospechosos (mismo equipo escrito distinto)
      { id: "dupA", canonical_name: "S26 12/512GB 5G", category_id: "c1", department_id: "d1" },
      { id: "dupB", canonical_name: "S26 12+512 5G DS", category_id: "c1", department_id: "d1" },
    ],
    categories: [{ id: "c1", name: "Samsung" }],
    suppliers: [
      { id: "sp1", name: "Bax", active: true },
      { id: "sp2", name: "South", active: true },
      { id: "sp3", name: "Planet", active: true },
      { id: "spStale", name: "Viejo", active: true },
    ],
    prices: [
      // limpio: dos precios frescos, parejos, con Lista sana
      { model_id: "ok", supplier_id: "sp1", price: 100, updated_at: FRESH },
      { model_id: "ok", supplier_id: "sp2", price: 102, updated_at: FRESH },
      // stale: DOS precios vencidos del mismo proveedor (agrega por proveedor)
      { model_id: "mL", supplier_id: "spStale", price: 90, updated_at: EXPIRED },
      { model_id: "mM", supplier_id: "spStale", price: 95, updated_at: EXPIRED },
      // escalera invertida: el par mL:sp1 (precio base sano)
      { model_id: "mL", supplier_id: "sp1", price: 100, updated_at: FRESH },
      // unit outlier: 1000 vs mediana de otros (100/105) ≈ 10×
      { model_id: "mU", supplier_id: "sp1", price: 100, updated_at: FRESH },
      { model_id: "mU", supplier_id: "sp2", price: 105, updated_at: FRESH },
      { model_id: "mU", supplier_id: "sp3", price: 1000, updated_at: FRESH },
      // off median (+37%, competencia fresca, NO banda de unidad)
      { model_id: "mM", supplier_id: "sp1", price: 100, updated_at: FRESH },
      { model_id: "mM", supplier_id: "sp2", price: 104, updated_at: FRESH },
      { model_id: "mM", supplier_id: "sp3", price: 140, updated_at: FRESH },
      // lista debajo del costo
      { model_id: "mLB", supplier_id: "sp1", price: 200, updated_at: FRESH },
    ],
    tiers: [
      { model_id: "mL", supplier_id: "sp1", min_qty: 1, price: 100 },
      { model_id: "mL", supplier_id: "sp1", min_qty: 20, price: 110 }, // invertida
    ],
    sales: [
      { model_id: "ok", price: 105 },
      { model_id: "mLB", price: 150 }, // debajo del costo 200
      { model_id: "mU", price: 110 },
      { model_id: "mM", price: 110 },
      { model_id: "mL", price: 104 },
      { model_id: "dupA", price: 1 }, // sin precios de proveedor: no evalúa lista
    ],
    aliases: [
      { alias_key: "limpio8256", model_id: "ok" },
      { alias_key: "zombie", model_id: "modelo-que-no-existe" }, // huérfano
    ],
  };
}

describe("P4 — runQa: un defecto plantado por detector", () => {
  const findings = runQa(snapshot());
  const byTipo = (t: string) => findings.filter((f) => f.tipo === t);

  it("stale agregado POR PROVEEDOR con el conteo", () => {
    const stale = byTipo("stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ id: "stale:spStale", proveedor: "Viejo", severidad: "bajo" });
    expect(stale[0]?.detalle).toMatch(/2 precio/);
  });

  it("escalera invertida en tiers guardados → alto", () => {
    const inv = byTipo("inverted_ladder");
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ id: "inverted_ladder:mL:sp1", severidad: "alto", proveedor: "Bax" });
  });

  it("unit_outlier → crítico con fix set_price al valor corregido (gateado aguas abajo)", () => {
    const unit = byTipo("unit_outlier");
    expect(unit).toHaveLength(1);
    expect(unit[0]?.id).toBe("unit_outlier:mU:sp3");
    expect(unit[0]?.severidad).toBe("critico");
    expect(unit[0]?.suggestedFix).toEqual({
      tool: "set_price",
      args: { model: "Unidad 8+256", supplier: "Planet", price: 100 },
    });
  });

  it("supplier_off_median (>30% con competencia fresca) → alto; el outlier de unidad NO duplica acá", () => {
    const off = byTipo("supplier_off_median");
    expect(off.map((f) => f.id)).toEqual(["supplier_off_median:mM:sp3"]);
    expect(off[0]?.severidad).toBe("alto");
    expect(off[0]?.detalle).toMatch(/ARRIBA/);
  });

  it("lista_below_cost → crítico con Lista sugerida sobre el costo", () => {
    const lb = byTipo("lista_below_cost");
    expect(lb).toHaveLength(1);
    expect(lb[0]?.id).toBe("lista_below_cost:mLB");
    expect(lb[0]?.suggestedFix?.args["price"]).toBe(206); // ceil(200×1.03)
  });

  it("missing_lista → bajo con sugerida Mín+3% (solo el que no tiene Lista)", () => {
    const ml = byTipo("missing_lista");
    // mLB tiene lista (baja) y ok/mU/mM/mL también: el ÚNICO sin lista con precios es… ninguno
    // — plantamos el caso sacándole la Lista al limpio:
    const snap2 = snapshot();
    snap2.sales = snap2.sales.filter((s) => s.model_id !== "ok");
    const ml2 = runQa(snap2).filter((f) => f.tipo === "missing_lista");
    expect(ml).toHaveLength(0);
    expect(ml2).toHaveLength(1);
    expect(ml2[0]).toMatchObject({ id: "missing_lista:ok", severidad: "bajo" });
    expect(ml2[0]?.suggestedFix?.args["price"]).toBe(103); // round(100×1.03)
  });

  it("higiene: sin_categoria, duplicado_sospechoso y alias_huerfano", () => {
    expect(byTipo("sin_categoria").map((f) => f.id)).toEqual(["sin_categoria:mNC"]);
    const dup = byTipo("duplicado_sospechoso");
    expect(dup).toHaveLength(1);
    expect(dup[0]?.detalle).toContain("S26 12/512GB 5G");
    expect(dup[0]?.detalle).toContain("S26 12+512 5G DS");
    expect(byTipo("alias_huerfano").map((f) => f.id)).toEqual(["alias_huerfano:zombie"]);
  });

  it("orden por severidad, ids determinísticos y el modelo limpio no dispara nada", () => {
    expect(findings[0]?.severidad).toBe("critico");
    expect(findings.some((f) => f.modelo === "Limpio 8+256" || f.id.includes(":ok"))).toBe(false);
    // determinismo: dos corridas → mismos ids en el mismo orden
    expect(runQa(snapshot()).map((f) => f.id)).toEqual(findings.map((f) => f.id));
    const counts = qaCounts(findings);
    expect(counts.total).toBe(findings.length);
    expect(counts.por_severidad.critico).toBe(2); // unit_outlier + lista_below_cost
  });
});

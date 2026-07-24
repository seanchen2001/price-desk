// Fase 7 — PnL + Analítica + Inventario + Arbitraje (domain puro, por ID).
// Fijan la paridad con el viejo: pnlView (memo), lib/analytics.js analyticsData,
// lib/inventory.js computeInventory y lib/arbitrage.js arbitrageScan.
import { describe, it, expect } from "vitest";
import type { LedgerEntry } from "../src/domain/accounts";
import { analyticsData, computePnl, periodStart, type DeskInvoice } from "../src/domain/analytics";
import { arbitrageScan } from "../src/domain/arbitrage";
import { computeInventory } from "../src/domain/inventory";

const inv = (over: Partial<DeskInvoice> & Pick<DeskInvoice, "id" | "no" | "date">): DeskInvoice => ({
  type: "factura",
  ts: new Date(2026, 6, 10).getTime(),
  clientId: "c1",
  ...over,
});

describe("computePnl (paridad con el pnlView viejo)", () => {
  const invoices: DeskInvoice[] = [
    inv({ id: "a", no: "1", date: "2026-07-10", subtotal: 1000, total: 1050, cost: 700, piezas: 10, supplierCosts: { s1: 700 } }),
    inv({ id: "b", no: "2", date: "2026-06-05", subtotal: 500, total: 500, cost: 300, piezas: 5, supplierCosts: { s1: 200, s2: 100 } }),
    inv({ id: "c", no: "3", date: "2026-07-11", type: "remito", subtotal: 999 }), // remito afuera
  ];
  const ledger: LedgerEntry[] = [
    { id: "g1", partyType: "supplier", partyId: "s1", type: "gasto", amount: 50, date: "2026-07-12" },
    { id: "g2", partyType: "client", partyId: "c1", type: "gasto", amount: 10, date: "2026-06-06" },
    { id: "p1", partyType: "client", partyId: "c1", type: "pago", amount: 400, date: "2026-07-12" }, // pago NO es gasto
  ];

  it("sin filtro (todo): venta = subtotal ?? total; margen = ventas − costo − gastos (ambos lados)", () => {
    const pnl = computePnl({ invoices, ledger });
    expect(pnl.ventas).toBe(1500);
    expect(pnl.costo).toBe(1000);
    expect(pnl.gastos).toBe(60);
    expect(pnl.margen).toBe(440);
    expect(pnl.piezas).toBe(15);
    expect(pnl.sales).toHaveLength(2);
    // proveedores ordenados por costo desc
    expect(pnl.supplierRows).toEqual([
      { supplierId: "s1", c: 900 },
      { supplierId: "s2", c: 100 },
    ]);
  });

  it("con período: filtra facturas Y gastos por fecha", () => {
    const from = new Date(2026, 6, 1).getTime(); // julio
    const pnl = computePnl({ invoices, ledger }, from);
    expect(pnl.ventas).toBe(1000);
    expect(pnl.gastos).toBe(50); // el gasto de junio queda afuera
    expect(pnl.margen).toBe(250);
  });

  it("periodStart: mes = 1° del mes; todo = 0 (idéntico al viejo sin filtro)", () => {
    const now = new Date(2026, 6, 21, 15, 30);
    expect(periodStart("mes", now)).toBe(new Date(2026, 6, 1).getTime());
    expect(periodStart("semana", now)).toBe(new Date(2026, 6, 20).getTime()); // lunes 20/7
    expect(periodStart("todo", now)).toBe(0);
  });
});

describe("analyticsData (paridad con lib/analytics.js, por ID)", () => {
  const invoices: DeskInvoice[] = [
    inv({
      id: "a", no: "1", date: "2026-07-10", clientId: "c1", subtotal: 1000, cost: 700, piezas: 10,
      supplierCosts: { s1: 700 },
      items: [{ modelId: "m1", qty: 10, price: 100, cost: 70 }],
    }),
    inv({
      id: "b", no: "2", date: "2026-06-05", clientId: "c2", subtotal: 500, cost: 300, piezas: 5,
      supplierCosts: { s2: 300 },
      items: [{ modelId: "m2", qty: 5, price: 100, cost: 60 }],
    }),
    inv({ id: "d", no: "4", date: "2026-07-12", clientId: null, subtotal: 200, cost: 150, piezas: 2 }),
  ];

  it("KPIs + monthly + tops (cliente null cae en '—', margen = ventas − costo sin gastos)", () => {
    const d = analyticsData({ invoices });
    expect(d.facturas).toBe(3);
    expect(d.ventas).toBe(1700);
    expect(d.costo).toBe(1150);
    expect(d.margen).toBe(550);
    expect(d.monthly.map((m) => m.label)).toEqual(["Jun 26", "Jul 26"]);
    expect(d.monthly[1]!.ventas).toBe(1200); // julio: 1000 + 200
    expect(d.topClientes[0]).toMatchObject({ clientId: "c1", ventas: 1000 });
    expect(d.topClientes.map((c) => c.clientId)).toContain("—");
    expect(d.topProveedores[0]).toMatchObject({ supplierId: "s1", compra: 700 });
    expect(d.topModelos[0]).toMatchObject({ modelId: "m1", piezas: 10, margen: 300 });
  });
});

describe("computeInventory (paridad con lib/inventory.js, por ID)", () => {
  it("entradas = docs a cuentas nuestras; salidas = ventas; avgCost ponderado de entradas", () => {
    const invoices: DeskInvoice[] = [
      // compra a inventario (cliente nuestro), remito también cuenta
      inv({ id: "a", no: "1", date: "2026-07-01", clientId: "own", ts: 100, items: [{ modelId: "m1", qty: 10, cost: 70 }] }),
      inv({ id: "b", no: "2", date: "2026-07-02", clientId: "own", ts: 200, type: "remito", items: [{ modelId: "m1", qty: 10, cost: 80 }] }),
      // venta real
      inv({ id: "c", no: "3", date: "2026-07-03", clientId: "c1", ts: 300, items: [{ modelId: "m1", qty: 5, cost: 75 }] }),
    ];
    const out = computeInventory({ invoices, ownClientIds: new Set(["own"]) });
    expect(out["m1"]).toMatchObject({ onHand: 15, entradas: 20, salidas: 5, avgCost: 75, lastTs: 300 });
  });

  it("modelo que solo se vendió (sin entradas): onHand negativo, avgCost null", () => {
    const invoices: DeskInvoice[] = [
      inv({ id: "c", no: "3", date: "2026-07-03", clientId: "c1", items: [{ modelId: "m2", qty: 3, cost: 50 }] }),
    ];
    const out = computeInventory({ invoices, ownClientIds: new Set(["own"]) });
    expect(out["m2"]).toMatchObject({ onHand: -3, entradas: 0, salidas: 3, avgCost: null });
  });
});

describe("arbitrageScan (paridad con lib/arbitrage.js, por ID)", () => {
  const now = new Date(2026, 6, 22).getTime(); // miércoles 22/7; el ciclo corta el lunes 20/7
  const fresh = new Date(2026, 6, 21).getTime();
  const stale = new Date(2026, 6, 17).getTime(); // semana anterior → expirado

  it("detecta gap ≥3% vs mediana y marca stale si el precio bajo es viejo", () => {
    const hits = arbitrageScan(
      [
        {
          modelId: "m1",
          prices: [
            { supplierId: "s1", price: 131, ts: stale }, // el caso Planet A17
            { supplierId: "s2", price: 138, ts: fresh },
            { supplierId: "s3", price: 139, ts: fresh },
          ],
        },
        {
          modelId: "m2", // gap chico → no alerta
          prices: [
            { supplierId: "s1", price: 100, ts: fresh },
            { supplierId: "s2", price: 101, ts: fresh },
          ],
        },
        { modelId: "m3", prices: [{ supplierId: "s1", price: 50, ts: fresh }] }, // sin comparación
      ],
      { now },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ modelId: "m1", lowSupplierId: "s1", lowPrice: 131, median: 138, stale: true });
    expect(hits[0]!.gapPct).toBeCloseTo(5.1, 1);
    expect(hits[0]!.nota).toMatch(/desactualizado/);
  });

  it("precio bajo fresco → oportunidad real", () => {
    const hits = arbitrageScan(
      [
        {
          modelId: "m1",
          prices: [
            { supplierId: "s1", price: 90, ts: fresh },
            { supplierId: "s2", price: 100, ts: fresh },
            { supplierId: "s3", price: 100, ts: fresh },
          ],
        },
      ],
      { now },
    );
    expect(hits[0]).toMatchObject({ stale: false });
    expect(hits[0]!.nota).toMatch(/oportunidad/);
  });
});

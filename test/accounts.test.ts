// Cuentas corrientes por ID + timeline de trades. El viejo no tenía tests de esto;
// estos fijan el comportamiento portado (misma matemática que lib/accounts.js y
// lib/trades.js, keyeado por party_id / invoice.id).
import { describe, it, expect } from "vitest";
import { computeAccounts, parseWhen, type AccountsInvoice, type LedgerEntry } from "../src/domain/accounts";
import { tradeStatus, type TradeClient, type TradeInvoice } from "../src/domain/trades";

const invoices: AccountsInvoice[] = [
  { id: "inv1", no: "2427", type: "factura", ts: 1000, date: "10/7/2026", clientId: "c1", total: 100, supplierCosts: { s1: 70 } },
  { id: "inv2", no: "2428", type: "remito", ts: 2000, date: "11/7/2026", clientId: "c1", total: 50 }, // remito NO genera cargo
];
const ledger: LedgerEntry[] = [
  { id: "l1", ts: 3000, partyType: "client", partyId: "c1", type: "pago", amount: 40, concept: "pago parcial", date: "12/7/2026" },
  { id: "l2", ts: 4000, partyType: "supplier", partyId: "s1", type: "pago", amount: 70, concept: "pago proveedor", date: "13/7/2026" },
  // cargo automático viejo (con ref a factura) → se deriva de la factura, se ignora acá
  { id: "l3", ts: 5000, partyType: "client", partyId: "c1", type: "cargo", amount: 999, refInvoiceId: "inv1", date: "12/7/2026" },
];

describe("computeAccounts (por ID)", () => {
  it("lado cliente: cargo de factura + pago manual, saldo corriente por fecha", () => {
    const accs = computeAccounts({ invoices, ledger }, "client");
    const c1 = accs["c1"]!;
    expect(c1.rows).toHaveLength(2); // factura + pago (remito y cargo-ref excluidos)
    expect(c1.rows[0]!.concept).toBe("Factura #2427");
    expect(c1.rows[0]!.saldo).toBe(100);
    expect(c1.rows[1]!.saldo).toBe(60);
    expect(c1.saldo).toBe(60);
  });

  it("lado proveedor: compra derivada de supplierCosts + pago manual", () => {
    const accs = computeAccounts({ invoices, ledger }, "supplier");
    const s1 = accs["s1"]!;
    expect(s1.rows).toHaveLength(2);
    expect(s1.rows[0]!.concept).toBe("Compra fact. #2427");
    expect(s1.rows[0]!.cargo).toBe(70);
    expect(s1.saldo).toBe(0);
  });

  it("un gasto manual suma al cargo (como en el viejo)", () => {
    const accs = computeAccounts(
      { invoices: [], ledger: [{ id: "g1", partyType: "client", partyId: "c9", type: "gasto", amount: 25, date: "1/7/2026" }] },
      "client",
    );
    expect(accs["c9"]!.saldo).toBe(25);
  });

  it("parseWhen acepta d/m/aaaa (legacy) e ISO aaaa-mm-dd (schema nuevo) con igual resultado", () => {
    expect(parseWhen("12/7/2026")).toBe(parseWhen("2026-07-12"));
    expect(parseWhen("12/7/26")).toBe(parseWhen("12/7/2026"));
    expect(parseWhen(null, 12345)).toBe(new Date(12345).getTime());
  });
});

describe("tradeStatus (por ID)", () => {
  const clients: TradeClient[] = [
    { id: "c1", name: "Juan", cuentaCorriente: false },
    { id: "c2", name: "Pedro", cuentaCorriente: true },
  ];
  const inv: TradeInvoice = {
    id: "inv1", no: "2427", type: "factura", ts: Date.now(), clientId: "c1", total: 100,
    items: [{ modelId: "m1", modelName: "S26 12+512 5G DS", qty: 2, imeis: ["111"] }],
  };

  it("factura sin IMEIs completos: abierta, próximo paso = IMEIs; sin cuenta corriente paga ANTES del envío", () => {
    const [tr] = tradeStatus({ drafts: [], invoices: [inv], opsTracking: {}, clients });
    expect(tr).toBeDefined();
    expect(tr!.abierto).toBe(true);
    expect(tr!.actual).toBe("Facturado");
    expect(tr!.proximo_paso).toBe("IMEIs (por unidad)");
    expect(tr!.checkpoints.map((s) => s.id)).toEqual(
      ["cotizado", "confirmado", "facturado", "datos", "pago", "afuera", "local"],
    );
    expect(tr!.modelos).toEqual(["S26 12+512 5G DS"]);
  });

  it("con cuenta corriente el pago va al FINAL; completo y sin cargar nosotros → cerrado", () => {
    const invCC: TradeInvoice = { ...inv, id: "inv2", no: "2428", clientId: "c2", items: [{ modelId: "m1", modelName: "S26", qty: 1, imeis: ["111"] }] };
    const ops = { inv2: { afuera: true, local: false, pago: true, cargamosNosotros: false } };
    const abiertos = tradeStatus({ drafts: [], invoices: [invCC], opsTracking: ops, clients });
    expect(abiertos).toHaveLength(0); // "local" está salteado → todo lo activo hecho
    const [tr] = tradeStatus({ drafts: [], invoices: [invCC], opsTracking: ops, clients }, "2428");
    expect(tr!.checkpoints.map((s) => s.id)).toEqual(
      ["cotizado", "confirmado", "facturado", "datos", "afuera", "local", "pago"],
    );
  });

  it("búsqueda por ref: número de factura, cliente o modelo", () => {
    const input = { drafts: [], invoices: [inv], opsTracking: {}, clients };
    expect(tradeStatus(input, "#2427")).toHaveLength(1);
    expect(tradeStatus(input, "juan")).toHaveLength(1);
    expect(tradeStatus(input, "s26")).toHaveLength(1);
    expect(tradeStatus(input, "nada")).toHaveLength(0);
  });

  it("draft con items = pedido abierto; confirmado según stage", () => {
    const drafts = [{ id: "d1", ts: Date.now(), clientId: "c1", order: { stage: "confirmada", items: [{ modelId: "m1", modelName: "S26", qty: 1 }] } }];
    const [tr] = tradeStatus({ drafts, invoices: [], opsTracking: {}, clients });
    expect(tr!.tipo).toBe("pedido");
    expect(tr!.actual).toBe("Confirmado");
    expect(tr!.proximo_paso).toBe("Facturado");
  });
});

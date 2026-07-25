// Fase 7 — AC de Cuentas: valida el CABLEADO data→domain→UI de las cuentas corrientes.
// El domain (computeAccounts) ya está testeado en accounts.test.ts; acá se verifica que
// el mapeo de filas de la base (features/shared/invoiceInputs.ts: supplierCosts desde
// invoice_items, ledger por party_id) produce los saldos EXACTOS que daría el
// computeAccounts del viejo sobre el mismo escenario:
//   · cliente con cuenta corriente: 2 facturas (1000 + 500) + 1 pago (400) → saldo 1100
//   · proveedor: costos derivados de items (700 + 300) + 1 gasto (50)      → saldo 1050
// Parte 1: puro (fixtures con la forma EXACTA de las filas de la base) — corre siempre.
// Parte 2: contra el Supabase REAL (service key) escribiendo por la capa de datos —
// se SKIPEA sin .env, igual que data.integration.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { installWebSocketStub } from "../scripts/lib/db";
import { loadDeskEnv } from "../scripts/lib/env";
import type { Database } from "../src/data/database.types";
import type { Db } from "../src/data/supabase";
import { computeAccounts } from "../src/domain/accounts";
import { computePnl } from "../src/domain/analytics";
import { buildDeskInvoices, buildLedgerEntries } from "../src/features/shared/invoiceInputs";

// ---------- Parte 1: cableado puro (filas DB-shaped → builders → computeAccounts) ----------

type InvoiceRow = Database["public"]["Tables"]["invoices"]["Row"];
type InvoiceItemRow = Database["public"]["Tables"]["invoice_items"]["Row"];
type LedgerRow = Database["public"]["Tables"]["ledger"]["Row"];

const invoiceRow = (over: Partial<InvoiceRow> & Pick<InvoiceRow, "id" | "no" | "date" | "total">): InvoiceRow => ({
  type: "factura",
  client_id: null,
  ship_id: null,
  piezas: null,
  subtotal: null,
  shipping: 0,
  cost: null,
  margin: null,
  stage: "enviada",
  client_pdf: null,
  created_at: "2026-07-10T12:00:00.000Z",
  deleted_at: null,
  ...over,
});

const itemRow = (
  over: Partial<InvoiceItemRow> & Pick<InvoiceItemRow, "id" | "invoice_id" | "qty">,
): InvoiceItemRow => ({
  model_id: null,
  color: null,
  spec: null,
  supplier_id: null,
  cost: null,
  price: null,
  ...over,
});

const ledgerRow = (
  over: Partial<LedgerRow> & Pick<LedgerRow, "id" | "party_type" | "party_id" | "type" | "amount">,
): LedgerRow => ({
  ts: "2026-07-12T12:00:00.000Z",
  side: over.party_type,
  concept: null,
  date: null,
  ref_invoice_id: null,
  ...over,
});

describe("Fase 7 — cableado data→domain de Cuentas (puro, escenario conocido)", () => {
  // cliente cc con 2 facturas + 1 pago; proveedor con costos derivados + 1 gasto
  const invoices: InvoiceRow[] = [
    invoiceRow({ id: "inv-a", no: "2427", date: "2026-07-10", client_id: "cli-1", total: 1000, subtotal: 1000, piezas: 10, cost: 700 }),
    invoiceRow({ id: "inv-b", no: "2428", date: "2026-07-11", client_id: "cli-1", total: 500, subtotal: 500, piezas: 5, cost: 300 }),
    // un remito NO genera cargo (mismo comportamiento que el viejo)
    invoiceRow({ id: "inv-c", no: "2429", date: "2026-07-11", client_id: "cli-1", total: 999, type: "remito" }),
  ];
  const items: InvoiceItemRow[] = [
    itemRow({ id: "it-1", invoice_id: "inv-a", qty: 10, supplier_id: "sup-1", cost: 70, price: 100, model_id: "mod-1" }),
    itemRow({ id: "it-2", invoice_id: "inv-b", qty: 5, supplier_id: "sup-1", cost: 60, price: 100, model_id: "mod-1" }),
  ];
  const ledger: LedgerRow[] = [
    ledgerRow({ id: "led-1", party_type: "client", party_id: "cli-1", type: "pago", amount: 400, date: "2026-07-12" }),
    ledgerRow({ id: "led-2", party_type: "supplier", party_id: "sup-1", type: "gasto", amount: 50, date: "2026-07-13" }),
  ];

  const deskInvoices = buildDeskInvoices(invoices, items);
  const deskLedger = buildLedgerEntries(ledger);

  it("supplierCosts se deriva de invoice_items (Σ cost×qty por supplier_id)", () => {
    expect(deskInvoices.find((f) => f.id === "inv-a")?.supplierCosts).toEqual({ "sup-1": 700 });
    expect(deskInvoices.find((f) => f.id === "inv-b")?.supplierCosts).toEqual({ "sup-1": 300 });
  });

  it("cliente cc: 1000 + 500 − 400 = 1100 (saldo EXACTO del computeAccounts viejo)", () => {
    const accs = computeAccounts({ invoices: deskInvoices, ledger: deskLedger }, "client");
    const c = accs["cli-1"]!;
    expect(c.saldo).toBe(1100);
    expect(c.rows).toHaveLength(3); // 2 facturas + 1 pago; el remito queda afuera
    expect(c.rows.map((r) => r.saldo)).toEqual([1000, 1500, 1100]);
    expect(c.rows[0]!.concept).toBe("Factura #2427");
  });

  it("proveedor: 700 + 300 + gasto 50 = 1050 (el gasto sube lo adeudado, como el viejo)", () => {
    const accs = computeAccounts({ invoices: deskInvoices, ledger: deskLedger }, "supplier");
    const p = accs["sup-1"]!;
    expect(p.saldo).toBe(1050);
    expect(p.rows).toHaveLength(3); // 2 compras derivadas + 1 gasto manual
    expect(p.rows.filter((r) => r.derived)).toHaveLength(2);
  });

  it("PnL sobre el mismo cableado: ventas 1500, costo 1000, gastos 50, margen 450", () => {
    const pnl = computePnl({ invoices: deskInvoices, ledger: deskLedger });
    expect(pnl.ventas).toBe(1500);
    expect(pnl.costo).toBe(1000);
    expect(pnl.gastos).toBe(50);
    expect(pnl.margen).toBe(450);
    expect(pnl.piezas).toBe(15);
    expect(pnl.supplierRows).toEqual([{ supplierId: "sup-1", c: 1000 }]);
  });
});

// ---------- Parte 2: mismo escenario contra el Supabase real (service key) ----------

installWebSocketStub();


const env = loadDeskEnv();
const url = env["VITE_SUPABASE_URL"] ?? "";
const serviceKey = env["SUPABASE_SERVICE_KEY"] ?? "";
const hasEnv = url !== "" && serviceKey !== "";
const TIMEOUT = 30_000;

describe.skipIf(!hasEnv)("Fase 7 — cuentas corrientes contra Supabase real", () => {
  let db: Db;
  let clientsMod: typeof import("../src/data/clients");
  let suppliersMod: typeof import("../src/data/suppliers");
  let invoicesMod: typeof import("../src/data/invoices");
  let ledgerMod: typeof import("../src/data/ledger");

  const stamp = `f7it${Date.now()}`;
  let clientId = "";
  let supplierId = "";
  const invoiceIds: string[] = [];
  const ledgerIds: string[] = [];

  beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    db = createClient<Database>(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    clientsMod = await import("../src/data/clients");
    suppliersMod = await import("../src/data/suppliers");
    invoicesMod = await import("../src/data/invoices");
    ledgerMod = await import("../src/data/ledger");

    const cli = await clientsMod.insertClient({ name: `Cliente CC ${stamp}`, cuenta_corriente: true }, db);
    clientId = cli.id;
    const sup = await suppliersMod.insertSupplier({ name: `Proveedor ${stamp}` }, db);
    supplierId = sup.id;

    const invA = await invoicesMod.insertInvoice(
      { no: `9001${stamp}`, date: "2026-07-10", type: "factura", client_id: clientId, piezas: 10, subtotal: 1000, total: 1000, cost: 700 },
      db,
    );
    const invB = await invoicesMod.insertInvoice(
      { no: `9002${stamp}`, date: "2026-07-11", type: "factura", client_id: clientId, piezas: 5, subtotal: 500, total: 500, cost: 300 },
      db,
    );
    invoiceIds.push(invA.id, invB.id);
    await invoicesMod.insertInvoiceItem(
      { invoice_id: invA.id, qty: 10, supplier_id: supplierId, cost: 70, price: 100 },
      db,
    );
    await invoicesMod.insertInvoiceItem(
      { invoice_id: invB.id, qty: 5, supplier_id: supplierId, cost: 60, price: 100 },
      db,
    );
    const pago = await ledgerMod.insertLedgerEntry(
      { side: "client", party_type: "client", party_id: clientId, type: "pago", amount: 400, concept: "Pago", date: "2026-07-12" },
      db,
    );
    const gasto = await ledgerMod.insertLedgerEntry(
      { side: "supplier", party_type: "supplier", party_id: supplierId, type: "gasto", amount: 50, concept: "Gasto envío proveedor", date: "2026-07-13" },
      db,
    );
    ledgerIds.push(pago.id, gasto.id);
  }, TIMEOUT);

  afterAll(async () => {
    for (const id of ledgerIds) await db.from("ledger").delete().eq("id", id);
    for (const id of invoiceIds) await db.from("invoices").delete().eq("id", id); // cascade items
    if (clientId) await db.from("clients").delete().eq("id", clientId);
    if (supplierId) await db.from("suppliers").delete().eq("id", supplierId);
  }, TIMEOUT);

  it(
    "leyendo por la MISMA capa de datos de la UI, los saldos dan 1100 (cliente) y 1050 (proveedor)",
    async () => {
      // mismas lecturas que hace useDeskData
      const [invoices, items, ledger] = await Promise.all([
        invoicesMod.listInvoices(db),
        invoicesMod.listInvoiceItems(undefined, db),
        ledgerMod.listLedger({}, db),
      ]);
      // scoped al escenario del test (la base real puede tener más datos)
      const ourInvoices = invoices.filter((f) => invoiceIds.includes(f.id));
      const ourLedger = ledger.filter((e) => ledgerIds.includes(e.id));
      const deskInvoices = buildDeskInvoices(ourInvoices, items);
      const deskLedger = buildLedgerEntries(ourLedger);

      const cliAccs = computeAccounts({ invoices: deskInvoices, ledger: deskLedger }, "client");
      expect(cliAccs[clientId]?.saldo).toBe(1100);
      expect(cliAccs[clientId]?.rows).toHaveLength(3);

      const supAccs = computeAccounts({ invoices: deskInvoices, ledger: deskLedger }, "supplier");
      expect(supAccs[supplierId]?.saldo).toBe(1050);
      expect(supAccs[supplierId]?.rows.filter((r) => r.derived).map((r) => r.cargo)).toEqual(
        expect.arrayContaining([700, 300]),
      );
    },
    TIMEOUT,
  );
});

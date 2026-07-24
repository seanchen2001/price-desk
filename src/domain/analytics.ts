// Agregados del Historial: PnL (memo pnlView del viejo) + Analítica (lib/analytics.js).
// Misma matemática, REESCRITO por ID: clientes/proveedores/modelos se agrupan por
// client_id / supplier_id / model_id — la UI resuelve los nombres para mostrar.
// Funciones puras, sin React ni storage propio.
import { parseWhen, type AccountsInvoice, type LedgerEntry } from "./accounts";
import { mondayStart } from "./pricing";

export const MONTHS_ES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
] as const;

export type DeskInvoiceItem = {
  modelId: string | null;
  supplierId?: string | null;
  qty?: number | null;
  price?: number | null;
  cost?: number | null;
};

/** Factura "rica" para los agregados: AccountsInvoice + totales + items por model_id.
 *  La capa de datos la arma desde invoices + invoice_items (features/shared). */
export type DeskInvoice = AccountsInvoice & {
  piezas?: number | null;
  subtotal?: number | null;
  cost?: number | null;
  items?: readonly DeskInvoiceItem[] | null;
};

// ---------- PnL ----------

export type PnlPeriod = "todo" | "mes" | "semana";

/** Comienzo (ms) del período. "todo" = 0 → reproduce EXACTO el pnlView viejo (sin filtro). */
export function periodStart(period: PnlPeriod, now: Date = new Date()): number {
  if (period === "semana") return mondayStart(now);
  if (period === "mes") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return 0;
}

export type PnlData = {
  sales: DeskInvoice[];
  ventas: number;
  costo: number;
  gastos: number;
  margen: number;
  margenPct: number;
  piezas: number;
  supplierRows: Array<{ supplierId: string; c: number }>;
};

// PORT-NOTE: fidelidad al pnlView viejo — venta = subtotal ?? total; gastos = TODOS los
// gastos del ledger (ambos lados, como el viejo); margen = ventas − costo − gastos.
export function computePnl(
  { invoices, ledger }: { invoices: readonly DeskInvoice[]; ledger: readonly LedgerEntry[] },
  from = 0,
): PnlData {
  const sales = invoices.filter((h) => h.type === "factura" && parseWhen(h.date, h.ts) >= from);
  let ventas = 0;
  let costo = 0;
  let piezas = 0;
  const bySupplier: Record<string, number> = {};
  for (const s of sales) {
    ventas += Number(s.subtotal ?? s.total) || 0;
    costo += Number(s.cost) || 0;
    piezas += Number(s.piezas) || 0;
    for (const [sp, c] of Object.entries(s.supplierCosts ?? {})) {
      bySupplier[sp] = (bySupplier[sp] ?? 0) + (Number(c) || 0);
    }
  }
  const gastos = ledger
    .filter((e) => e.type === "gasto" && parseWhen(e.date, e.ts) >= from)
    .reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const margen = ventas - costo - gastos;
  const margenPct = ventas ? (margen / ventas) * 100 : 0;
  const supplierRows = Object.entries(bySupplier)
    .map(([supplierId, c]) => ({ supplierId, c }))
    .sort((a, b) => b.c - a.c);
  return { sales, ventas, costo, gastos, margen, margenPct, piezas, supplierRows };
}

// ---------- Analítica ----------

export type MonthAgg = {
  mk: number;
  year: number;
  month: number;
  label: string;
  ventas: number;
  costo: number;
  margen: number;
  piezas: number;
  facturas: number;
};

export type ClientAgg = {
  clientId: string;
  ventas: number;
  margen: number;
  piezas: number;
  facturas: number;
};

export type SupplierAgg = { supplierId: string; compra: number };
export type ModelAgg = { modelId: string; piezas: number; margen: number };

export type AnalyticsData = {
  facturas: number;
  ventas: number;
  costo: number;
  margen: number;
  margenPct: number;
  piezas: number;
  monthly: MonthAgg[];
  topClientes: ClientAgg[];
  topClientesPorMargen: ClientAgg[];
  topProveedores: SupplierAgg[];
  topModelos: ModelAgg[];
};

// PORT-NOTE: puerto 1:1 de analyticsData (lib/analytics.js) — margen acá = ventas − costo
// (los gastos NO entran, como el viejo). Factura sin cliente/modelo cae en la key "—".
export function analyticsData(
  { invoices }: { invoices: readonly DeskInvoice[] },
  months = 6,
): AnalyticsData {
  const sales = invoices.filter((h) => h.type === "factura");
  const byMonth = new Map<number, Omit<MonthAgg, "label" | "margen">>();
  const byClient: Record<string, ClientAgg> = {};
  const bySupplier: Record<string, SupplierAgg> = {};
  const byModel: Record<string, ModelAgg> = {};
  let ventas = 0;
  let costo = 0;
  let piezas = 0;
  for (const f of sales) {
    const d = new Date(parseWhen(f.date, f.ts));
    const mk = d.getFullYear() * 12 + d.getMonth();
    const venta = Number(f.subtotal ?? f.total) || 0;
    const c = Number(f.cost) || 0;
    const pz = Number(f.piezas) || 0;
    ventas += venta;
    costo += c;
    piezas += pz;
    const m = byMonth.get(mk) ?? {
      mk,
      year: d.getFullYear(),
      month: d.getMonth(),
      ventas: 0,
      costo: 0,
      piezas: 0,
      facturas: 0,
    };
    m.ventas += venta;
    m.costo += c;
    m.piezas += pz;
    m.facturas += 1;
    byMonth.set(mk, m);
    const cl = f.clientId ?? "—";
    const bc = (byClient[cl] ??= { clientId: cl, ventas: 0, margen: 0, piezas: 0, facturas: 0 });
    bc.ventas += venta;
    bc.margen += venta - c;
    bc.piezas += pz;
    bc.facturas += 1;
    for (const [sp, sc] of Object.entries(f.supplierCosts ?? {})) {
      (bySupplier[sp] ??= { supplierId: sp, compra: 0 }).compra += Number(sc) || 0;
    }
    for (const it of f.items ?? []) {
      const q = Number(it.qty) || 0;
      const key = it.modelId ?? "—";
      const bm = (byModel[key] ??= { modelId: key, piezas: 0, margen: 0 });
      bm.piezas += q;
      bm.margen += ((Number(it.price) || 0) - (Number(it.cost) || 0)) * q;
    }
  }
  const monthly: MonthAgg[] = [...byMonth.values()]
    .sort((a, b) => a.mk - b.mk)
    .slice(-months)
    .map((m) => ({
      ...m,
      label: `${MONTHS_ES[m.month]!.slice(0, 3)} ${String(m.year).slice(2)}`,
      margen: m.ventas - m.costo,
    }));
  const margen = ventas - costo;
  return {
    facturas: sales.length,
    ventas,
    costo,
    margen,
    margenPct: ventas ? (margen / ventas) * 100 : 0,
    piezas,
    monthly,
    topClientes: Object.values(byClient).sort((a, b) => b.ventas - a.ventas),
    topClientesPorMargen: Object.values(byClient)
      .slice()
      .sort((a, b) => b.margen - a.margen),
    topProveedores: Object.values(bySupplier).sort((a, b) => b.compra - a.compra),
    topModelos: Object.values(byModel).sort((a, b) => b.piezas - a.piezas),
  };
}

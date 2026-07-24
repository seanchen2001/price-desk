// Estado del trade end-to-end. Unifica la etapa pre-venta (order.stage de los drafts) con
// el seguimiento post-venta (opsTracking) en UNA línea de tiempo por trade: cotizado →
// confirmado → facturado → datos (IMEIs por unidad, derivado) → [pago si no tiene cuenta
// corriente] → Miami FOB → [Argentina si cargamos nosotros] → [pago si tiene cuenta corriente].
// Portado de lib/trades.js — misma matemática, por ID:
//  - opsTracking se keyea por invoice.id (el viejo usaba f.ts como id improvisado);
//  - items llevan modelId (+ modelName opcional para mostrar/buscar; el viejo usaba i.sku).
// Función pura, sin storage propio.

const CONFIRMED_STAGES = new Set(["confirmada", "esperando_pago", "a_enviar", "enviada"]);

export type TradeItem = {
  modelId?: string | null;
  /** nombre canónico, opcional: se usa para `modelos` (display y búsqueda por ref) */
  modelName?: string | null;
  qty?: number | null;
  /** un IMEI por unidad (schema nuevo: invoice_item_units → la capa de datos arma el array) */
  imeis?: readonly string[] | null;
  /** compatibilidad: un solo IMEI viejo */
  imei?: string | null;
};

export type TradeClient = {
  id: string;
  name?: string | null;
  cuentaCorriente?: boolean | null;
  esNuestra?: boolean | null;
};

export type TradeInvoice = {
  id: string;
  no: string;
  type: string;
  ts?: number | null;
  clientId?: string | null;
  total?: number | null;
  items?: readonly TradeItem[] | null;
};

export type TradeDraft = {
  id: string;
  ts?: number | null;
  clientId?: string | null;
  order?: { stage?: string | null; items?: readonly TradeItem[] | null } | null;
};

export type OpsFlags = {
  afuera?: boolean; // Miami
  local?: boolean; // Argentina
  pago?: boolean;
  cargamosNosotros?: boolean;
};

export type Step = { id: string; label: string; done: boolean; derivado?: boolean; skipped?: boolean };

// ¿Todos los items tienen sus IMEI? (checkpoint "Datos", derivado — no se setea a mano)
// El COLOR ya viene cargado con la orden, así que NO se exige. Los IMEI son POR UNIDAD:
// completo = cada línea tiene un IMEI por cada unidad (imeis.length >= qty). Legacy: un solo imei.
function datosCompletos(items: readonly TradeItem[] | null | undefined): boolean {
  const list = items || [];
  if (!list.length) return false;
  return list.every((it) => {
    const qty = Number(it.qty) || 0;
    const arr = Array.isArray(it.imeis) ? it.imeis.filter((x) => String(x).trim()) : [];
    if (arr.length) return qty ? arr.length >= qty : arr.length > 0; // un IMEI por unidad
    return !!String(it.imei || "").trim(); // compatibilidad: un solo IMEI viejo
  });
}

// Construye la línea de tiempo de UN trade facturado.
function invoiceTimeline(f: TradeInvoice, t: OpsFlags, cli: TradeClient | undefined): Step[] {
  const cc = !!cli?.cuentaCorriente;
  const cargamos = !!t.cargamosNosotros;
  const datos = datosCompletos(f.items);
  const steps: Step[] = [
    { id: "cotizado", label: "Cotizado", done: true },
    { id: "confirmado", label: "Confirmado", done: true },
    { id: "facturado", label: "Facturado", done: true },
    { id: "datos", label: "IMEIs (por unidad)", done: datos, derivado: true },
  ];
  const pago: Step = { id: "pago", label: "Pagado", done: !!t.pago };
  const miami: Step = { id: "afuera", label: "Miami FOB", done: !!t.afuera };
  const argentina: Step = { id: "local", label: "En Argentina", done: !!t.local, skipped: !cargamos };
  // sin cuenta corriente: paga ANTES del envío; con cuenta: paga al final
  if (cc) steps.push(miami, argentina, pago);
  else steps.push(pago, miami, argentina);
  return steps;
}

type TradeBase = {
  tipo: "pedido" | "factura";
  ref: string;
  id: string;
  cliente: string;
  ts?: number | null;
  invoiceNo?: string;
  total?: number | null;
  modelos: string[];
  cargamosNosotros?: boolean;
};

export type Trade = Omit<TradeBase, "ts"> & {
  dias: number;
  checkpoints: Step[];
  progreso: string;
  actual: string;
  proximo_paso: string | null;
  abierto: boolean;
};

const itemLabel = (i: TradeItem): string => String(i.modelName ?? i.modelId ?? "");

export type TradeStatusInput = {
  drafts?: readonly TradeDraft[] | null;
  invoices?: readonly TradeInvoice[] | null;
  /** invoice.id → flags post-venta (schema: ops_tracking) */
  opsTracking?: Record<string, OpsFlags> | null;
  clients?: readonly TradeClient[] | null;
};

// Trades abiertos (o uno puntual por ref: factura#, cliente o modelo), con checkpoint
// actual, próximo paso pendiente y días desde el último avance.
export function tradeStatus(
  { drafts, invoices, opsTracking, clients }: TradeStatusInput,
  ref?: string | null,
): Trade[] {
  const now = Date.now();
  const out: Trade[] = [];

  // pre-factura: pedidos en armado
  for (const d of drafts || []) {
    const o = d.order || {};
    const items = o.items || [];
    if (!items.length) continue;
    const cli = (clients || []).find((c) => c.id === d.clientId);
    if (cli?.esNuestra) continue;
    const confirmado = CONFIRMED_STAGES.has(o.stage ?? "");
    const steps: Step[] = [
      { id: "cotizado", label: "Cotizado", done: true },
      { id: "confirmado", label: "Confirmado", done: confirmado },
      { id: "facturado", label: "Facturado", done: false },
      { id: "datos", label: "IMEIs (por unidad)", done: false, derivado: true },
      { id: "pago", label: "Pagado", done: false },
      { id: "afuera", label: "Miami FOB", done: false },
      { id: "local", label: "En Argentina", done: false, skipped: true },
    ];
    out.push(
      buildTrade({
        tipo: "pedido",
        ref: `pedido de ${cli?.name || "(sin cliente)"}`,
        id: d.id,
        cliente: cli?.name || "(sin cliente)",
        ts: d.ts ?? null,
        modelos: [...new Set(items.map(itemLabel))],
        steps,
        now,
      }),
    );
  }

  // facturados: abiertos mientras falte algún checkpoint no salteado
  for (const f of invoices || []) {
    if (f.type !== "factura") continue;
    const cli = (clients || []).find((c) => c.id === f.clientId);
    if (cli?.esNuestra) continue;
    const t = (opsTracking || {})[f.id] || {};
    const steps = invoiceTimeline(f, t, cli);
    const trade = buildTrade({
      tipo: "factura",
      ref: `factura #${f.no}`,
      id: f.id,
      invoiceNo: f.no,
      cliente: cli?.name || "—",
      ts: f.ts ?? null,
      total: f.total ?? null,
      modelos: [...new Set((f.items || []).map(itemLabel))],
      steps,
      now,
      cargamosNosotros: !!t.cargamosNosotros,
    });
    if (trade.abierto || ref) out.push(trade);
  }

  if (ref) {
    const q = String(ref).toLowerCase().replace(/^#/, "");
    return out.filter(
      (tr) =>
        String(tr.invoiceNo || "").toLowerCase() === q ||
        tr.cliente.toLowerCase().includes(q) ||
        tr.modelos.some((m) => m.toLowerCase().includes(q)),
    );
  }
  return out.filter((tr) => tr.abierto).sort((a, b) => b.dias - a.dias);
}

function buildTrade(args: TradeBase & { steps: Step[]; now: number }): Trade {
  const { steps, now, ts, ...rest } = args;
  const activos = steps.filter((s) => !s.skipped);
  const pendientes = activos.filter((s) => !s.done);
  const hechos = activos.filter((s) => s.done);
  return {
    ...rest,
    dias: Math.floor((now - (ts || now)) / 86400000),
    checkpoints: steps,
    progreso: `${hechos.length}/${activos.length}`,
    actual: hechos.length ? hechos[hechos.length - 1]!.label : "—",
    proximo_paso: pendientes.length ? pendientes[0]!.label : null,
    abierto: pendientes.length > 0,
  };
}

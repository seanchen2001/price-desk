// Lógica pura de Órdenes / Historial (sin React, sin Supabase): numeración de factura,
// fechas d/m/yyyy del template, totales, agrupado por proveedor para remitos y las filas
// del Excel IMEI+Serie. Portado de lib/helpers.js + lib/constants.js + la lógica embebida
// en electronics-price-tool.jsx (imeiRows/brandFor/remitoGroups) — misma matemática, por ID.

// ---------- etapas de un pedido (order.stage) ----------

export type OrderStage = {
  id: string;
  label: string;
  emoji: string;
};

export const ORDER_STAGES: readonly OrderStage[] = [
  { id: "cotizando", label: "Cotizando", emoji: "💬" },
  { id: "negociando", label: "Negociando proveedor", emoji: "🤝" },
  { id: "confirmada", label: "Confirmada", emoji: "✅" },
  { id: "esperando_pago", label: "Esperando pago", emoji: "💰" },
  { id: "a_enviar", label: "A enviar", emoji: "📦" },
  { id: "enviada", label: "Enviada", emoji: "🚚" },
];

export function stageInfo(id: string | null | undefined): OrderStage {
  return ORDER_STAGES.find((x) => x.id === id) ?? ORDER_STAGES[0]!;
}

export const COMPANY = { name: "PHOTO IMAGEN & VIDEO EXPORT LLC" };

// ---------- numeración visible (correlativa, arranca en 2427 como el viejo) ----------

export function nextInvoiceNo(existing: ReadonlyArray<{ no: string | null }>): number {
  const nums = existing
    .map((h) => parseInt(String(h.no ?? ""), 10))
    .filter((n) => !Number.isNaN(n));
  return nums.length ? Math.max(...nums) + 1 : 2427;
}

// ---------- fechas del template (d/m/yyyy, como las escribe el trader) ----------

export function fmtDMY(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

export function todayDMY(): string {
  return fmtDMY(Date.now());
}

/** "21/7/2026" → Date; si no parsea, cae al fallback (o época 0). */
export function parseDMY(s: string | null | undefined, fallbackTs?: number): Date {
  const m = String(s ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(y, Number(m[2]) - 1, Number(m[1]));
  }
  return new Date(fallbackTs ?? 0);
}

/** Fecha del template → ISO yyyy-mm-dd para la columna `date` de la base. */
export function dmyToISO(s: string | null | undefined, fallbackTs: number = Date.now()): string {
  const d = parseDMY(s, fallbackTs);
  const valid = !Number.isNaN(d.getTime()) && d.getTime() !== 0 ? d : new Date(fallbackTs);
  const mm = String(valid.getMonth() + 1).padStart(2, "0");
  const dd = String(valid.getDate()).padStart(2, "0");
  return `${valid.getFullYear()}-${mm}-${dd}`;
}

export const money = (n: number | null | undefined): string =>
  n == null || Number.isNaN(n) ? "—" : "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });

// ---------- líneas de la orden (el shape que viaja en drafts.payload y arma la factura) ----------

export type OrderLine = {
  /** invoice_items.id cuando la línea viene de una factura ya generada (modo edición) */
  itemId?: string;
  /** identidad estable; null solo para líneas legacy sin resolver */
  modelId: string | null;
  /** nombre canónico al momento (display + PDF) */
  modelName: string;
  /** categoría (display + marca del PDF/Excel: "Samsung", "iPhone", …) */
  category: string;
  qty: number;
  color: string;
  spec: string;
  supplierId: string | null;
  /** nombre del proveedor al momento (display; el remito agrupa por supplierId) */
  supplierName: string;
  cost: number;
  price: number;
  /** IMEI legacy de una sola unidad (sale en la descripción del PDF si está) */
  imei: string;
  /** un IMEI por unidad (pre-factura; al facturar se vuelcan a invoice_item_units) */
  imeis: string[];
  serials: string[];
};

export type OrderState = {
  items: OrderLine[];
  invoiceNo: string;
  date: string; // d/m/yyyy (texto del template)
  payment: string;
  fob: string;
  salesperson: string;
  job: string;
  terms: string;
  dueDate: string;
  shippingCost: number;
  deliveryAddr: string;
  stage: string;
};

export function blankOrder(invoiceNo: number): OrderState {
  return {
    items: [],
    invoiceNo: String(invoiceNo),
    date: todayDMY(),
    payment: "W/T",
    fob: "Miami",
    salesperson: "",
    job: "",
    terms: "Due upon receipt",
    dueDate: todayDMY(),
    shippingCost: 0,
    deliveryAddr: "",
    stage: "cotizando",
  };
}

// ---------- totales ----------

export type OrderTotals = {
  piezas: number;
  subtotal: number;
  shipping: number;
  total: number;
  cost: number;
  margin: number;
};

export function orderTotals(
  items: ReadonlyArray<Pick<OrderLine, "qty" | "price" | "cost">>,
  shippingCost: number | null | undefined,
): OrderTotals {
  const piezas = items.reduce((a, i) => a + (Number(i.qty) || 0), 0);
  const subtotal = items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  const cost = items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.cost) || 0), 0);
  const shipping = Number(shippingCost) || 0;
  return { piezas, subtotal, shipping, total: subtotal + shipping, cost, margin: subtotal - cost };
}

// ---------- remitos por proveedor ----------

export type SupplierGroup<T> = { supplierId: string | null; supplierName: string; items: T[] };

/** Agrupa líneas por proveedor (las sin proveedor van juntas al final). */
export function groupBySupplier<T extends Pick<OrderLine, "supplierId" | "supplierName">>(
  items: readonly T[],
): SupplierGroup<T>[] {
  const by = new Map<string, SupplierGroup<T>>();
  for (const it of items) {
    const key = it.supplierId ?? "(sin proveedor)";
    const g = by.get(key);
    if (g) g.items.push(it);
    else
      by.set(key, {
        supplierId: it.supplierId,
        supplierName: it.supplierId ? it.supplierName : "(sin proveedor)",
        items: [it],
      });
  }
  return [...by.values()];
}

/** Código corto para el nombre de archivo del remito: suppliers.code o el nombre saneado. */
export function supplierFileCode(code: string | null | undefined, name: string | null | undefined): string {
  const c = String(code ?? "").trim();
  if (c) return c;
  return String(name ?? "").replace(/[^\w-]+/g, "_") || "prov";
}

// ---------- snapshot de cliente para el PDF (invoices.client_pdf) ----------

/** Datos del cliente al momento de facturar — mismo shape que el clientPdf del viejo. */
export type ClientPdf = {
  name: string;
  ruc: string;
  phone: string;
  addressLines: string[];
  notify: string;
  direccion: string;
  telefono: string;
  contacto: string;
};

type ClientLike = { name?: string | null; address?: string | null; ruc?: string | null; phone?: string | null };
type ShippingLike = {
  notify?: string | null;
  direccion?: string | null;
  telefono?: string | null;
  contacto?: string | null;
};

/**
 * Igual que el viejo: dirección de entrega = campo explícito de la orden, luego el Envío,
 * luego la dirección del cliente; teléfono = del envío, luego del cliente.
 */
export function buildClientPdf(
  client: ClientLike | null | undefined,
  shipping: ShippingLike | null | undefined,
  deliveryAddr: string | null | undefined,
): ClientPdf {
  const addressLines = String(client?.address ?? "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    name: String(client?.name ?? ""),
    ruc: String(client?.ruc ?? ""),
    phone: String(client?.phone ?? ""),
    addressLines,
    notify: String(shipping?.notify ?? ""),
    direccion: String(deliveryAddr ?? "") || String(shipping?.direccion ?? "") || addressLines.join(", "),
    telefono: String(shipping?.telefono ?? "") || String(client?.phone ?? ""),
    contacto: String(shipping?.contacto ?? ""),
  };
}

/** Decodifica el jsonb invoices.client_pdf (tolerante: campos faltantes → ""). */
export function parseClientPdf(raw: unknown): ClientPdf {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
  const lines = Array.isArray(o["addressLines"])
    ? (o["addressLines"] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return {
    name: str("name"),
    ruc: str("ruc"),
    phone: str("phone"),
    addressLines: lines,
    notify: str("notify"),
    direccion: str("direccion"),
    telefono: str("telefono"),
    contacto: str("contacto"),
  };
}

// ---------- metadata de la orden dentro del snapshot (re-descarga fiel) ----------
// El viejo guardaba la orden completa en el registro; acá los campos del template que no
// tienen columna propia (payment/FOB/salesperson/terms/dueDate/deliveryAddr) viajan como
// `order_meta` DENTRO del jsonb client_pdf — así la re-descarga reproduce el documento
// original sin migración de schema. parseClientPdf ignora la clave extra.

export type OrderMeta = {
  payment: string;
  fob: string;
  salesperson: string;
  job: string;
  terms: string;
  dueDate: string;
  deliveryAddr: string;
};

export function orderMetaOf(order: OrderState): OrderMeta {
  return {
    payment: order.payment,
    fob: order.fob,
    salesperson: order.salesperson,
    job: order.job,
    terms: order.terms,
    dueDate: order.dueDate,
    deliveryAddr: order.deliveryAddr,
  };
}

/** Decodifica order_meta del jsonb client_pdf; faltante → defaults del template. */
export function parseOrderMeta(raw: unknown): OrderMeta {
  const outer = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const metaRaw = outer["order_meta"];
  const o = (metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw) ? metaRaw : {}) as Record<
    string,
    unknown
  >;
  const str = (k: string, fallback: string): string => (typeof o[k] === "string" ? (o[k] as string) : fallback);
  return {
    payment: str("payment", "W/T"),
    fob: str("fob", "Miami"),
    salesperson: str("salesperson", ""),
    job: str("job", ""),
    terms: str("terms", "Due upon receipt"),
    dueDate: str("dueDate", ""),
    deliveryAddr: str("deliveryAddr", ""),
  };
}

// ---------- Excel IMEI + Serie (una fila por unidad) ----------

/** Marca (mayúsculas) para la columna PRODUCTO; se deriva de la categoría/nombre. */
export function brandFor(category: string | null | undefined, modelName: string | null | undefined): string {
  const c = String(category ?? "");
  if (/^\s*samsung/i.test(c)) return "SAMSUNG";
  if (/motorola/i.test(c) || /motorola/i.test(String(modelName ?? ""))) return "MOTOROLA";
  if (/iphone|apple/i.test(c) || /iphone/i.test(String(modelName ?? ""))) return "APPLE";
  return c.toUpperCase() || "—";
}

export type ImeiExportLine = {
  modelName: string;
  category: string;
  qty: number;
  imeis: readonly string[];
  serials: readonly string[];
};

export type ImeiExportRow = [number, string, string, string, string];

export const IMEI_EXPORT_HEADER = ["N°", "PRODUCTO", "MODELO", "IMEI", "NRO DE SERIE"] as const;

/**
 * Filas [N°, PRODUCTO, MODELO, IMEI, NRO DE SERIE] — N° es contador global 1..N;
 * unidades = max(qty, imeis, serials) para no perder datos pegados de más.
 * IMEI y serie SIEMPRE string (el Excel las escribe como texto, no número).
 */
export function buildImeiRows(lines: readonly ImeiExportLine[]): ImeiExportRow[] {
  const rows: ImeiExportRow[] = [];
  let n = 0;
  for (const l of lines) {
    const units = Math.max(Number(l.qty) || 0, l.imeis.length, l.serials.length);
    for (let u = 0; u < units; u++) {
      rows.push([++n, brandFor(l.category, l.modelName), l.modelName, String(l.imeis[u] ?? ""), String(l.serials[u] ?? "")]);
    }
  }
  return rows;
}

/** Split de un textarea pegado del Excel: un valor por renglón, sin vacíos. */
export function splitUnits(text: string | null | undefined): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

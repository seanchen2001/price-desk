// Orquestación FACTURAR / editar factura: OrderState (domain) → invoices + invoice_items
// (+ invoice_item_units si la línea ya trae IMEIs) + ops_tracking, todo por fila.
// Sin React: db inyectable para que el test de integración corra el flujo end-to-end.
import type { Json } from "./database.types";
import {
  deleteInvoiceItem,
  insertInvoice,
  insertInvoiceItem,
  listInvoiceItems,
  setUnitsForItem,
  updateInvoice,
  updateInvoiceItem,
  type InvoiceItemRow,
  type InvoiceRow,
} from "./invoices";
import { upsertOps } from "./misc";
import { supabase, type Db } from "./supabase";
import {
  dmyToISO,
  orderMetaOf,
  orderTotals,
  type ClientPdf,
  type OrderLine,
  type OrderState,
} from "../domain/orders";

export type FacturarArgs = {
  order: OrderState;
  type: "factura" | "remito";
  clientId: string | null;
  shipId: string | null;
  clientPdf: ClientPdf;
};

export type FacturarResult = { invoice: InvoiceRow; items: InvoiceItemRow[] };


/** Snapshot jsonb: datos del cliente al momento + order_meta (re-descarga fiel). */
function snapshotJson(args: FacturarArgs): Json {
  return { ...args.clientPdf, order_meta: orderMetaOf(args.order) } as unknown as Json;
}

function itemInsertFromLine(invoiceId: string, l: OrderLine) {
  return {
    invoice_id: invoiceId,
    model_id: l.modelId,
    qty: Number(l.qty) || 0,
    color: l.color || null,
    spec: l.spec || null,
    supplier_id: l.supplierId,
    cost: Number(l.cost) || 0,
    price: Number(l.price) || 0,
  };
}

/** Vuelca los IMEIs/series pegados en la línea a invoice_item_units (si trajo alguno). */
async function writeUnitsIfAny(itemId: string, l: OrderLine, db: Db): Promise<void> {
  if (l.imeis.length === 0 && l.serials.length === 0) return;
  await setUnitsForItem({ itemId, qty: Number(l.qty) || 0, imeis: l.imeis, serials: l.serials }, db);
}

/**
 * Crea la factura completa: invoice (con snapshot client_pdf y stage de la orden) +
 * un invoice_item por línea (por model_id) + units para las líneas con IMEIs pegados +
 * la fila de ops_tracking (checkpoints post-venta en false).
 */
export async function facturarOrder(args: FacturarArgs, db: Db = supabase): Promise<FacturarResult> {
  const t = orderTotals(args.order.items, args.order.shippingCost);
  const invoice = await insertInvoice(
    {
      no: args.order.invoiceNo,
      date: dmyToISO(args.order.date),
      type: args.type,
      client_id: args.clientId,
      ship_id: args.shipId,
      piezas: t.piezas,
      subtotal: t.subtotal,
      shipping: t.shipping,
      total: t.total,
      cost: t.cost,
      margin: t.margin,
      stage: args.order.stage,
      client_pdf: snapshotJson(args),
    },
    db,
  );
  const items: InvoiceItemRow[] = [];
  for (const line of args.order.items) {
    const item = await insertInvoiceItem(itemInsertFromLine(invoice.id, line), db);
    items.push(item);
    await writeUnitsIfAny(item.id, line, db);
  }
  await upsertOps({ invoice_id: invoice.id }, db);
  return { invoice, items };
}

/**
 * Guarda los cambios de una factura ya generada: actualiza el invoice y reconcilia los
 * items POR FILA (update por itemId, insert de líneas nuevas, delete de las quitadas —
 * el cascade borra sus units).
 */
export async function updateInvoiceFromOrder(
  invoiceId: string,
  args: FacturarArgs,
  db: Db = supabase,
): Promise<FacturarResult> {
  const t = orderTotals(args.order.items, args.order.shippingCost);
  const invoice = await updateInvoice(
    invoiceId,
    {
      no: args.order.invoiceNo,
      date: dmyToISO(args.order.date),
      type: args.type,
      client_id: args.clientId,
      ship_id: args.shipId,
      piezas: t.piezas,
      subtotal: t.subtotal,
      shipping: t.shipping,
      total: t.total,
      cost: t.cost,
      margin: t.margin,
      stage: args.order.stage,
      client_pdf: snapshotJson(args),
    },
    db,
  );

  const existing = await listInvoiceItems(invoiceId, db);
  const keptIds = new Set(args.order.items.map((l) => l.itemId).filter((x): x is string => !!x));
  for (const row of existing) {
    if (!keptIds.has(row.id)) await deleteInvoiceItem(row.id, db);
  }
  const items: InvoiceItemRow[] = [];
  for (const line of args.order.items) {
    if (line.itemId && existing.some((r) => r.id === line.itemId)) {
      const patch = itemInsertFromLine(invoiceId, line);
      items.push(await updateInvoiceItem(line.itemId, patch, db));
      await writeUnitsIfAny(line.itemId, line, db);
    } else {
      const item = await insertInvoiceItem(itemInsertFromLine(invoiceId, line), db);
      items.push(item);
      await writeUnitsIfAny(item.id, line, db);
    }
  }
  return { invoice, items };
}

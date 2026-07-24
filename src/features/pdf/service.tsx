// Generación y descarga de PDFs en el browser (la vista solo llama a estas funciones).
// Mapea OrderState (domain) → props del InvoiceDoc y arma el remito POR PROVEEDOR:
// un archivo por proveedor (solo sus líneas, sin precios), código corto en el filename.
// @react-pdf/renderer se carga on-demand (import dinámico): pesa ~1.3 MB y solo hace
// falta al apretar "Descargar" — igual que xlsx en el Excel.
import {
  COMPANY,
  groupBySupplier,
  supplierFileCode,
  type ClientPdf,
  type OrderLine,
  type OrderState,
} from "../../domain/orders";
import type { PdfItem, PdfOrder } from "./InvoiceDoc";

async function loadPdf() {
  const [{ pdf }, { InvoiceDoc }] = await Promise.all([
    import("@react-pdf/renderer"),
    import("./InvoiceDoc"),
  ]);
  return { pdf, InvoiceDoc };
}

export function lineToPdfItem(l: OrderLine): PdfItem {
  return {
    qty: Number(l.qty) || 0,
    modelName: l.modelName,
    category: l.category,
    color: l.color,
    imei: l.imei,
    spec: l.spec,
    price: Number(l.price) || 0,
  };
}

export function orderToPdfOrder(order: OrderState, items?: readonly OrderLine[]): PdfOrder {
  return {
    invoiceNo: order.invoiceNo,
    date: order.date,
    payment: order.payment,
    fob: order.fob,
    salesperson: order.salesperson,
    job: order.job,
    terms: order.terms,
    dueDate: order.dueDate,
    shippingCost: Number(order.shippingCost) || 0,
    items: (items ?? order.items).map(lineToPdfItem),
  };
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Factura (con precios) o remito único (sin precios) — descarga `<tipo>-<no>.pdf`. */
export async function downloadInvoicePdf(
  order: OrderState,
  client: ClientPdf,
  mode: "factura" | "remito",
): Promise<void> {
  const { pdf, InvoiceDoc } = await loadPdf();
  const blob = await pdf(
    <InvoiceDoc company={COMPANY} client={client} order={orderToPdfOrder(order)} mode={mode} />,
  ).toBlob();
  saveBlob(blob, `${mode}-${order.invoiceNo}.pdf`);
}

/**
 * Remitos por proveedor: un archivo por proveedor (solo sus items). Adentro se ve igual
 * que la factura pero sin precios y SIN datos del proveedor — el código corto va solo en
 * el nombre del archivo: Remito_<Factura#>_<code>.pdf.
 */
export async function downloadSupplierRemitos(
  order: OrderState,
  client: ClientPdf,
  codeForSupplier: (supplierId: string | null, supplierName: string) => string,
): Promise<number> {
  const { pdf, InvoiceDoc } = await loadPdf();
  const groups = groupBySupplier(order.items);
  for (const [i, g] of groups.entries()) {
    const code = codeForSupplier(g.supplierId, g.supplierName);
    const blob = await pdf(
      <InvoiceDoc
        company={COMPANY}
        client={client}
        order={orderToPdfOrder(order, g.items)}
        mode="remito"
      />,
    ).toBlob();
    saveBlob(blob, `Remito_${order.invoiceNo}_${code}.pdf`);
    if (i < groups.length - 1) await new Promise((r) => setTimeout(r, 450)); // separar descargas
  }
  return groups.length;
}

/** Código corto del proveedor para el filename del remito (suppliers.code o nombre saneado). */
export function makeCodeResolver(
  supplierById: Map<string, { code: string | null; name: string }>,
): (supplierId: string | null, supplierName: string) => string {
  return (supplierId, supplierName) => {
    const sup = supplierId ? supplierById.get(supplierId) : undefined;
    return supplierFileCode(sup?.code ?? null, sup?.name ?? supplierName);
  };
}

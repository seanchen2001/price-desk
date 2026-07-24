// Cableado data→domain compartido por Cuentas / PnL / Analítica: filas de la base
// (invoices + invoice_items + ledger) → los inputs por ID que consumen computeAccounts,
// computePnl y analyticsData. Puro (sin React): el test de integración de Fase 7 valida
// exactamente este mapeo (los saldos deben dar lo mismo que el computeAccounts del viejo).
import type { InvoiceItemRow, InvoiceRow } from "../../data/invoices";
import type { LedgerRow } from "../../data/ledger";
import type { LedgerEntry, Side } from "../../domain/accounts";
import type { DeskInvoice, DeskInvoiceItem } from "../../domain/analytics";

/** supplierCosts derivado de los items: Σ cost×qty por supplier_id (reemplaza el mapa
 *  por nombre que el viejo congelaba al facturar). */
export function buildDeskInvoices(
  invoices: readonly InvoiceRow[],
  items: readonly InvoiceItemRow[],
): DeskInvoice[] {
  const itemsByInvoice = new Map<string, InvoiceItemRow[]>();
  for (const it of items) {
    const arr = itemsByInvoice.get(it.invoice_id);
    if (arr) arr.push(it);
    else itemsByInvoice.set(it.invoice_id, [it]);
  }
  return invoices.map((f) => {
    const its = itemsByInvoice.get(f.id) ?? [];
    const supplierCosts: Record<string, number> = {};
    for (const it of its) {
      if (it.supplier_id === null) continue; // línea sin proveedor → no genera deuda con nadie
      supplierCosts[it.supplier_id] =
        (supplierCosts[it.supplier_id] ?? 0) + (Number(it.qty) || 0) * (Number(it.cost) || 0);
    }
    const deskItems: DeskInvoiceItem[] = its.map((it) => ({
      modelId: it.model_id,
      supplierId: it.supplier_id,
      qty: it.qty,
      price: it.price,
      cost: it.cost,
    }));
    return {
      id: f.id,
      no: f.no,
      type: f.type,
      ts: Date.parse(f.created_at),
      date: f.date,
      clientId: f.client_id,
      total: f.total,
      piezas: f.piezas,
      subtotal: f.subtotal,
      cost: f.cost,
      supplierCosts,
      items: deskItems,
    };
  });
}

export function buildLedgerEntries(rows: readonly LedgerRow[]): LedgerEntry[] {
  return rows.map((e) => {
    const partyType: Side = e.party_type === "supplier" ? "supplier" : "client";
    return {
      id: e.id,
      ts: Date.parse(e.ts),
      partyType,
      partyId: e.party_id,
      type: e.type,
      amount: e.amount,
      concept: e.concept,
      date: e.date,
      refInvoiceId: e.ref_invoice_id,
    };
  });
}

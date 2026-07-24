// Inventario y costo promedio REAL, derivados del historial. Sin storage propio.
// Entrada = facturas/remitos a cuentas NUESTRAS (cliente con es_nuestra=true): compramos
// para stock. Salida = ventas a clientes reales. Portado de lib/inventory.js — misma
// matemática, por ID: cuentas propias por client_id y stock por model_id (el viejo
// también matcheaba por nombre; acá la identidad la da la FK).
import type { DeskInvoice } from "./analytics";

export type InventoryRow = {
  modelId: string;
  onHand: number;
  avgCost: number | null; // promedio ponderado del costo de las ENTRADAS
  entradas: number;
  salidas: number;
  lastTs: number;
};

export function computeInventory({
  invoices,
  ownClientIds,
}: {
  invoices: readonly DeskInvoice[];
  ownClientIds: ReadonlySet<string>;
}): Record<string, InventoryRow> {
  const byModel: Record<
    string,
    { modelId: string; entradas: number; salidas: number; costEntradas: number; lastTs: number }
  > = {};
  for (const inv of invoices) {
    if (inv.type !== "factura" && inv.type !== "remito") continue;
    const inbound = inv.clientId != null && ownClientIds.has(inv.clientId);
    for (const it of inv.items ?? []) {
      // PORT-NOTE: sin model_id no hay identidad de stock → se saltea (el viejo keyeaba
      // por el string sku, que siempre existía; acá el string ya no es identidad).
      if (!it.modelId) continue;
      const s = (byModel[it.modelId] ??= {
        modelId: it.modelId,
        entradas: 0,
        salidas: 0,
        costEntradas: 0,
        lastTs: 0,
      });
      const q = Number(it.qty) || 0;
      if (inbound) {
        s.entradas += q;
        s.costEntradas += q * (Number(it.cost) || 0);
      } else {
        s.salidas += q;
      }
      s.lastTs = Math.max(s.lastTs, inv.ts ?? 0);
    }
  }
  const out: Record<string, InventoryRow> = {};
  for (const s of Object.values(byModel)) {
    out[s.modelId] = {
      modelId: s.modelId,
      onHand: s.entradas - s.salidas,
      avgCost: s.entradas ? +(s.costEntradas / s.entradas).toFixed(2) : null,
      entradas: s.entradas,
      salidas: s.salidas,
      lastTs: s.lastTs,
    };
  }
  return out;
}

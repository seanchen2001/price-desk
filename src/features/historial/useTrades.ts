// Ensambla el estado de los trades (domain/trades.tradeStatus) desde la base:
// invoices + invoice_items + invoice_item_units (IMEIs por unidad) + ops_tracking +
// drafts + clients. Compartido por Órdenes (timeline arriba) e Historial (stage por fila).
import { useMemo } from "react";
import { useClients } from "../../data/clients";
import { useInvoiceItems, useInvoices, useItemUnits, type InvoiceItemRow, type InvoiceRow, type ItemUnitRow } from "../../data/invoices";
import { useAllOps, useDrafts, type OpsRow } from "../../data/misc";
import { useModels } from "../../data/models";
import { tradeStatus, type OpsFlags, type Trade, type TradeClient, type TradeDraft, type TradeInvoice } from "../../domain/trades";
import { parseDraftPayload } from "../ordenes/draftPayload";

export type ImeiProgress = { loaded: number; total: number };

export type TradesData = {
  loading: boolean;
  invoices: InvoiceRow[];
  itemsByInvoice: Map<string, InvoiceItemRow[]>;
  unitsByItem: Map<string, ItemUnitRow[]>;
  opsByInvoice: Map<string, OpsRow>;
  clientNameById: Map<string, string>;
  modelNameById: Map<string, string>;
  openTrades: Trade[];
  /** IMEIs cargados / unidades totales de una factura (unidades = suma de qty) */
  imeiProgress: (invoiceId: string) => ImeiProgress;
};

export function useTrades(): TradesData {
  const invoices = useInvoices();
  const items = useInvoiceItems();
  const units = useItemUnits();
  const ops = useAllOps();
  const clients = useClients();
  const models = useModels();
  const drafts = useDrafts();

  const loading =
    invoices.isLoading ||
    items.isLoading ||
    units.isLoading ||
    ops.isLoading ||
    clients.isLoading ||
    models.isLoading ||
    drafts.isLoading;

  return useMemo(() => {
    const invoiceRows = invoices.data ?? [];
    const itemRows = items.data ?? [];
    const unitRows = units.data ?? [];
    const opsRows = ops.data ?? [];
    const clientRows = clients.data ?? [];
    const modelRows = models.data ?? [];
    const draftRows = drafts.data ?? [];

    const itemsByInvoice = new Map<string, InvoiceItemRow[]>();
    for (const it of itemRows) {
      const arr = itemsByInvoice.get(it.invoice_id);
      if (arr) arr.push(it);
      else itemsByInvoice.set(it.invoice_id, [it]);
    }
    const unitsByItem = new Map<string, ItemUnitRow[]>();
    for (const u of unitRows) {
      const arr = unitsByItem.get(u.item_id);
      if (arr) arr.push(u);
      else unitsByItem.set(u.item_id, [u]);
    }
    const opsByInvoice = new Map(opsRows.map((o) => [o.invoice_id, o]));
    const clientNameById = new Map(clientRows.map((c) => [c.id, c.name]));
    const modelNameById = new Map(modelRows.map((m) => [m.id, m.canonical_name]));

    const tradeClients: TradeClient[] = clientRows.map((c) => ({
      id: c.id,
      name: c.name,
      cuentaCorriente: c.cuenta_corriente,
      esNuestra: c.es_nuestra,
    }));

    const tradeInvoices: TradeInvoice[] = invoiceRows.map((f) => ({
      id: f.id,
      no: f.no,
      type: f.type,
      ts: Date.parse(f.created_at),
      clientId: f.client_id,
      total: f.total,
      items: (itemsByInvoice.get(f.id) ?? []).map((it) => ({
        modelId: it.model_id,
        modelName: it.model_id ? (modelNameById.get(it.model_id) ?? null) : null,
        qty: it.qty,
        imeis: (unitsByItem.get(it.id) ?? [])
          .map((u) => u.imei ?? "")
          .filter((x) => x.trim() !== ""),
      })),
    }));

    const tradeDrafts: TradeDraft[] = draftRows.map((d) => {
      const p = parseDraftPayload(d.payload);
      return {
        id: d.id,
        ts: p.ts,
        clientId: p.clientId,
        order: {
          stage: p.order.stage,
          items: p.order.items.map((l) => ({
            modelId: l.modelId,
            modelName: l.modelName,
            qty: l.qty,
            imeis: l.imeis,
          })),
        },
      };
    });

    const opsFlags: Record<string, OpsFlags> = {};
    for (const o of opsRows) {
      opsFlags[o.invoice_id] = {
        afuera: o.afuera,
        local: o.local,
        pago: o.pago,
        cargamosNosotros: o.cargamos_nosotros,
      };
    }

    const openTrades = tradeStatus({
      drafts: tradeDrafts,
      invoices: tradeInvoices,
      opsTracking: opsFlags,
      clients: tradeClients,
    });

    const imeiProgress = (invoiceId: string): ImeiProgress => {
      const its = itemsByInvoice.get(invoiceId) ?? [];
      const total = its.reduce((a, it) => a + (Number(it.qty) || 0), 0);
      const loaded = its.reduce(
        (a, it) =>
          a + (unitsByItem.get(it.id) ?? []).filter((u) => (u.imei ?? "").trim() !== "").length,
        0,
      );
      return { loaded, total };
    };

    return {
      loading,
      invoices: invoiceRows,
      itemsByInvoice,
      unitsByItem,
      opsByInvoice,
      clientNameById,
      modelNameById,
      openTrades,
      imeiProgress,
    };
  }, [loading, invoices.data, items.data, units.data, ops.data, clients.data, models.data, drafts.data]);
}

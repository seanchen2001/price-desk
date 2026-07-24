// Pestaña Historial: facturas / remitos generados — re-descarga de PDFs (factura y
// remitos por proveedor), edición (abre Órdenes en modo edición), papelero (soft-delete),
// editor de IMEI + Nº de serie por unidad y export Excel. Timeline del trade por factura
// con los checkpoints de ops_tracking (afuera / local / pago / cargamos nosotros) editables.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { reportDataError } from "../../data/errors";
import { useSoftDeleteInvoice, type InvoiceRow } from "../../data/invoices";
import { useUpsertOps } from "../../data/misc";
import {
  money,
  nextInvoiceNo,
  parseClientPdf,
  parseOrderMeta,
  type ImeiExportLine,
  type OrderLine,
  type OrderState,
} from "../../domain/orders";
import type { Trade } from "../../domain/trades";
import s from "../mesa/styles";
import { useOrdenesData } from "../ordenes/useOrdenesData";
import { downloadInvoicePdf, downloadSupplierRemitos, makeCodeResolver } from "../pdf/service";
import { exportImeiExcel } from "./imeiExcel";
import { buildEditorLines, ImeiEditorModal } from "./ImeiEditorModal";
import { useTrades } from "./useTrades";

const chipX = { color: "#f87171", cursor: "pointer", fontWeight: 700, padding: "0 4px" } as const;
const miniBtn = {
  ...s.toolBtn,
  padding: "2px 8px",
  fontSize: 11,
} as const;

export type HistorialViewProps = {
  onEdit: (invoiceId: string) => void;
  /** abrir el editor de IMEIs de esta factura al montar (viene del timeline de Órdenes) */
  autoImeiInvoiceId: string | null;
  onAutoImeiHandled: () => void;
};

export function HistorialView({ onEdit, autoImeiInvoiceId, onAutoImeiHandled }: HistorialViewProps) {
  const trades = useTrades();
  const data = useOrdenesData();
  const softDelete = useSoftDeleteInvoice();
  const upsertOps = useUpsertOps();
  const [pdfBusy, setPdfBusy] = useState(false);
  const [imeiInvoice, setImeiInvoice] = useState<InvoiceRow | null>(null);

  // trade por factura (checkpoints); las cerradas no vienen en openTrades
  const tradeByInvoice = useMemo(() => {
    const m = new Map<string, Trade>();
    for (const t of trades.openTrades) if (t.tipo === "factura") m.set(t.id, t);
    return m;
  }, [trades.openTrades]);

  // apertura automática del editor de IMEIs (desde el timeline de Órdenes)
  useEffect(() => {
    if (!autoImeiInvoiceId || trades.loading) return;
    const inv = trades.invoices.find((x) => x.id === autoImeiInvoiceId);
    if (inv) setImeiInvoice(inv);
    onAutoImeiHandled();
  }, [autoImeiInvoiceId, trades.loading, trades.invoices, onAutoImeiHandled]);

  const modelInfo = (modelId: string | null): { name: string; category: string } => {
    const model = modelId ? data.modelById.get(modelId) : undefined;
    return {
      name: model?.canonical_name ?? "(modelo)",
      category: model ? data.categoryNameOf(model) : "",
    };
  };

  const clienteName = (inv: InvoiceRow): string => {
    const snap = parseClientPdf(inv.client_pdf);
    if (snap.name) return snap.name;
    return inv.client_id ? (trades.clientNameById.get(inv.client_id) ?? "—") : "—";
  };

  // Reconstruye la orden para regenerar PDFs desde el registro (items desde la base)
  const orderStateFor = (inv: InvoiceRow): OrderState => {
    const d = new Date(inv.date + "T00:00:00");
    const dmy = Number.isNaN(d.getTime())
      ? inv.date
      : `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
    const items: OrderLine[] = (trades.itemsByInvoice.get(inv.id) ?? []).map((it) => {
      const info = modelInfo(it.model_id);
      return {
        itemId: it.id,
        modelId: it.model_id,
        modelName: info.name,
        category: info.category,
        qty: it.qty,
        color: it.color ?? "",
        spec: it.spec ?? "",
        supplierId: it.supplier_id,
        supplierName: it.supplier_id ? (data.supplierById.get(it.supplier_id)?.name ?? "") : "",
        cost: it.cost ?? 0,
        price: it.price ?? 0,
        imei: "",
        imeis: [],
        serials: [],
      };
    });
    // los campos del template sin columna propia viajan en client_pdf.order_meta
    const meta = parseOrderMeta(inv.client_pdf);
    return {
      items,
      invoiceNo: inv.no,
      date: dmy,
      payment: meta.payment,
      fob: meta.fob,
      salesperson: meta.salesperson,
      job: meta.job,
      terms: meta.terms,
      dueDate: meta.dueDate || dmy,
      shippingCost: inv.shipping ?? 0,
      deliveryAddr: meta.deliveryAddr,
      stage: inv.stage,
    };
  };

  const download = async (inv: InvoiceRow, mode: "factura" | "remitos") => {
    setPdfBusy(true);
    try {
      const order = orderStateFor(inv);
      const client = parseClientPdf(inv.client_pdf);
      if (mode === "remitos") {
        await downloadSupplierRemitos(order, client, makeCodeResolver(data.supplierById));
      } else {
        await downloadInvoicePdf(order, client, "factura");
      }
    } catch (error) {
      reportDataError({ operation: "regenerar PDF", error });
    } finally {
      setPdfBusy(false);
    }
  };

  const exportExcel = async (inv: InvoiceRow) => {
    const lines: ImeiExportLine[] = (trades.itemsByInvoice.get(inv.id) ?? []).map((it) => {
      const info = modelInfo(it.model_id);
      const units = trades.unitsByItem.get(it.id) ?? [];
      return {
        modelName: info.name,
        category: info.category,
        qty: it.qty,
        imeis: units.map((u) => u.imei ?? ""),
        serials: units.map((u) => u.serial ?? ""),
      };
    });
    const ok = await exportImeiExcel(inv.no, lines);
    if (!ok) alert("Esta factura no tiene unidades para exportar.");
  };

  const setOpsCheck = (inv: InvoiceRow, key: "afuera" | "local" | "pago" | "cargamos_nosotros", val: boolean) => {
    const cur = trades.opsByInvoice.get(inv.id);
    upsertOps.mutate({
      invoice_id: inv.id,
      afuera: cur?.afuera ?? false,
      local: cur?.local ?? false,
      pago: cur?.pago ?? false,
      cargamos_nosotros: cur?.cargamos_nosotros ?? false,
      [key]: val,
    });
  };

  const invoices = trades.invoices;

  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>
        HISTORIAL — facturas / remitos generados · próximo Invoice # {nextInvoiceNo(invoices)}
      </div>
      {trades.loading ? (
        <div style={s.hint}>Cargando el historial…</div>
      ) : invoices.length === 0 ? (
        <div style={s.hint}>
          Todavía no generaste ningún documento. El Invoice # se cuenta solo a medida que generás facturas.
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={{ ...s.table, minWidth: 860 }}>
            <thead>
              <tr>
                <th style={{ ...s.th, textAlign: "left" }}>Invoice #</th>
                <th style={{ ...s.th, textAlign: "left" }}>Fecha</th>
                <th style={{ ...s.th, textAlign: "left" }}>Tipo</th>
                <th style={{ ...s.th, textAlign: "left" }}>Cliente</th>
                <th style={s.th}>Piezas</th>
                <th style={s.th}>Total</th>
                <th style={s.th}>Costo</th>
                <th style={s.th}>Margen</th>
                <th style={{ ...s.th, textAlign: "left" }}>Descargar</th>
                <th style={s.th}></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((h) => {
                const p = trades.imeiProgress(h.id);
                const done = p.total > 0 && p.loaded >= p.total;
                const trade = tradeByInvoice.get(h.id);
                const ops = trades.opsByInvoice.get(h.id);
                return (
                  <FragmentRows key={h.id}>
                    <tr>
                      <td style={{ ...s.td, textAlign: "left", color: "#cfd6e4", fontWeight: 600 }}>{h.no}</td>
                      <td style={{ ...s.td, textAlign: "left" }}>{h.date}</td>
                      <td style={{ ...s.td, textAlign: "left" }}>{h.type}</td>
                      <td style={{ ...s.td, textAlign: "left" }}>{clienteName(h)}</td>
                      <td style={{ ...s.td, textAlign: "right" }}>{h.piezas ?? "—"}</td>
                      <td style={{ ...s.td, textAlign: "right", color: "#fbbf24" }}>{money(h.total)}</td>
                      <td style={{ ...s.td, textAlign: "right", color: "#9aa4b2" }}>
                        {h.cost != null ? money(h.cost) : "—"}
                      </td>
                      <td
                        style={{
                          ...s.td,
                          textAlign: "right",
                          color: (h.margin ?? 0) >= 0 ? "#4ade80" : "#f87171",
                        }}
                      >
                        {h.margin != null ? money(h.margin) : "—"}
                      </td>
                      <td style={{ ...s.td, textAlign: "left", whiteSpace: "nowrap" }}>
                        <button
                          onClick={() => onEdit(h.id)}
                          style={{ ...miniBtn, borderColor: "#3a5", color: "#8ee0a8" }}
                          title="Editar esta factura (items, colores, cantidades, cliente, envío)"
                        >
                          ✏️ Editar
                        </button>{" "}
                        {h.type === "factura" && (
                          <>
                            <button
                              onClick={() => setImeiInvoice(h)}
                              style={{
                                ...miniBtn,
                                borderColor: done ? "#3a5" : "#5a4a1d",
                                color: done ? "#8ee0a8" : "#e0b34d",
                              }}
                              title="Cargar los IMEIs y Nº de serie por unidad (agrupados por modelo)"
                            >
                              📱 IMEIs {p.loaded}/{p.total}
                            </button>{" "}
                            <button
                              onClick={() => void exportExcel(h)}
                              style={{ ...miniBtn, borderColor: "#2f6d4a", color: "#8ee0a8" }}
                              title="Bajar Excel .xlsx con PRODUCTO / MODELO / IMEI / Nº de serie (una fila por unidad)"
                            >
                              ⬇ Excel IMEI+Serie
                            </button>{" "}
                          </>
                        )}
                        <button
                          onClick={() => void download(h, "factura")}
                          disabled={pdfBusy}
                          style={miniBtn}
                          title="Factura (con precios)"
                        >
                          Factura
                        </button>{" "}
                        <button
                          onClick={() => void download(h, "remitos")}
                          disabled={pdfBusy}
                          style={miniBtn}
                          title="Remitos por proveedor (sin precios)"
                        >
                          Rem. x prov.
                        </button>
                      </td>
                      <td style={s.td}>
                        <span
                          style={chipX}
                          title="Mandar al papelero (soft-delete)"
                          onClick={() => {
                            if (confirm(`¿Borrar la factura #${h.no}? Queda en el papelero (deleted_at).`))
                              softDelete.mutate(h.id);
                          }}
                        >
                          ×
                        </span>
                      </td>
                    </tr>
                    {h.type === "factura" && (
                      <tr>
                        <td colSpan={10} style={{ ...s.td, paddingTop: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                            {(trade
                              ? trade.checkpoints.filter((c) => !c.skipped)
                              : [{ id: "done", label: "✓ trade completo", done: true, derivado: false, skipped: false }]
                            ).map((c, i, arr) => (
                              <span key={c.id} style={{ display: "contents" }}>
                                <span
                                  style={{
                                    fontSize: 10,
                                    padding: "1px 6px",
                                    borderRadius: 10,
                                    whiteSpace: "nowrap",
                                    background: c.done ? "#14331f" : "#1a1f2b",
                                    color: c.done ? "#8ee0a8" : "#6b7385",
                                    border: `1px solid ${c.done ? "#2f9e57" : "#242b3a"}`,
                                  }}
                                >
                                  {c.done ? "✓ " : "· "}
                                  {c.label}
                                </span>
                                {i < arr.length - 1 && <span style={{ color: "#3a4356", fontSize: 10 }}>—</span>}
                              </span>
                            ))}
                            <span style={{ marginLeft: 10, display: "inline-flex", gap: 10, fontSize: 10.5, color: "#8b94a7" }}>
                              {(
                                [
                                  ["afuera", "Miami FOB"],
                                  ["local", "En Argentina"],
                                  ["pago", "Pagado"],
                                  ["cargamos_nosotros", "cargamos nosotros"],
                                ] as Array<["afuera" | "local" | "pago" | "cargamos_nosotros", string]>
                              ).map(([k, lbl]) => (
                                <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
                                  <input
                                    type="checkbox"
                                    checked={ops ? ops[k] : false}
                                    onChange={(e) => setOpsCheck(h, k, e.target.checked)}
                                    style={s.chk}
                                  />
                                  {lbl}
                                </label>
                              ))}
                            </span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </FragmentRows>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {imeiInvoice && (
        <ImeiEditorModal
          key={imeiInvoice.id}
          invoice={imeiInvoice}
          clienteName={clienteName(imeiInvoice)}
          initialLines={buildEditorLines(
            trades.itemsByInvoice.get(imeiInvoice.id) ?? [],
            trades.unitsByItem,
            modelInfo,
          )}
          onClose={() => setImeiInvoice(null)}
        />
      )}
    </section>
  );
}

function FragmentRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

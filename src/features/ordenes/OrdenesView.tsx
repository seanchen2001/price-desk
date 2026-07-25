// Pestaña Órdenes (factura / remito): pedidos pendientes (drafts retomables en la base),
// cliente/envío, líneas de items (modelo por ID, qty, color con split, proveedor + costo
// autocompletado con escalas, precio de venta) y generación de PDFs. Al FACTURAR crea
// invoice + invoice_items (+ units si ya se pegaron IMEIs) + ops_tracking (data/facturar.ts).
// Cuando se edita una factura del Historial, la misma sección funciona en modo edición.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { reportDataError } from "../../data/errors";
import { facturarOrder, updateInvoiceFromOrder, type FacturarArgs } from "../../data/facturar";
import { keys } from "../../data/keys";
import { useDeleteDraft, useDrafts, useUpsertDraft } from "../../data/misc";
import type { ModelRow } from "../../data/models";
import {
  blankOrder,
  buildClientPdf,
  groupBySupplier,
  money,
  orderTotals,
  parseOrderMeta,
  splitUnits,
  type OrderLine,
  type OrderState,
} from "../../domain/orders";
import type { Trade } from "../../domain/trades";
import { useTrades } from "../historial/useTrades";
import s from "../mesa/styles";
import { downloadInvoicePdf, downloadSupplierRemitos, makeCodeResolver } from "../pdf/service";
import { parseDraftPayload, serializeDraftPayload, type DraftPayload } from "./draftPayload";
import { useOrdenesData } from "./useOrdenesData";

const cellInput = {
  background: "#0b0e14",
  color: "#e6ebf5",
  border: "1px solid #232a3a",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 12,
  fontFamily: "inherit",
} as const;

const invTh = {
  ...s.th,
  textAlign: "center" as const,
};

const invTd = {
  ...s.td,
  textAlign: "center" as const,
};

const chipX = {
  color: "#f87171",
  cursor: "pointer",
  fontWeight: 700,
  padding: "0 4px",
} as const;

type DraftEntry = { id: string; payload: DraftPayload };

function specForCategory(category: string): string {
  return category === "Motorola LATIN" ? "LATIN" : category === "Motorola EURO" ? "EURO" : "";
}

// ---- timeline de trades en curso (arriba de la sección, como el viejo) ----
function TradeTimeline({
  trades,
  imeiProgress,
  onLoadImeis,
}: {
  trades: Trade[];
  imeiProgress: (invoiceId: string) => { loaded: number; total: number };
  onLoadImeis: (invoiceId: string) => void;
}) {
  if (trades.length === 0) return null;
  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>TRADES EN CURSO — próximo paso por operación</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {trades.slice(0, 8).map((t) => (
          <div
            key={`${t.tipo}-${t.id}`}
            style={{ background: "#11151f", border: "1px solid #1c2230", borderRadius: 6, padding: "8px 12px" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ color: "#cfd6e4", fontSize: 12.5, fontWeight: 600 }}>{t.ref}</span>
              <span style={{ color: "#8b94a7", fontSize: 11.5 }}>{t.cliente}</span>
              {t.total != null && <span style={{ color: "#fbbf24", fontSize: 11.5 }}>{money(t.total)}</span>}
              <span style={{ color: "#6b7385", fontSize: 11 }}>{t.dias} día(s)</span>
              <span style={{ marginLeft: "auto", color: "#8ee0a8", fontSize: 11.5 }}>
                → {t.proximo_paso || "completo"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
              {t.checkpoints
                .filter((c) => !c.skipped)
                .map((c, i, arr) => {
                  const isImei = c.id === "datos" && t.tipo === "factura";
                  const cnt = isImei ? imeiProgress(t.id) : null;
                  return (
                    <span key={c.id} style={{ display: "contents" }}>
                      <span
                        title={isImei ? "Cargar IMEIs (uno por unidad)" : c.label}
                        onClick={isImei ? () => onLoadImeis(t.id) : undefined}
                        style={{
                          fontSize: 10.5,
                          padding: "2px 7px",
                          borderRadius: 10,
                          whiteSpace: "nowrap",
                          cursor: isImei ? "pointer" : "default",
                          background: c.done ? "#14331f" : "#1a1f2b",
                          color: c.done ? "#8ee0a8" : isImei ? "#e0b34d" : "#6b7385",
                          border: `1px solid ${c.done ? "#2f9e57" : isImei ? "#5a4a1d" : "#242b3a"}`,
                        }}
                      >
                        {c.done ? "✓ " : "· "}
                        {c.label}
                        {cnt ? ` ${cnt.loaded}/${cnt.total}` : ""}
                        {isImei ? " ✎" : ""}
                      </span>
                      {i < arr.length - 1 && <span style={{ color: "#3a4356", fontSize: 10 }}>—</span>}
                    </span>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export type OrdenesViewProps = {
  /** factura del Historial que se está editando (null = armado normal de órdenes) */
  editInvoiceId: string | null;
  onDoneEditing: () => void;
  /** abrir el editor de IMEIs de una factura (vive en Historial) */
  onLoadImeis: (invoiceId: string) => void;
};

export function OrdenesView({ editInvoiceId, onDoneEditing, onLoadImeis }: OrdenesViewProps) {
  const data = useOrdenesData();
  const trades = useTrades();
  const qc = useQueryClient();
  const upsertDraft = useUpsertDraft();
  const deleteDraftMut = useDeleteDraft();

  const [order, setOrder] = useState<OrderState>(() => blankOrder(2427));
  const [clientId, setClientId] = useState("");
  const [shipId, setShipId] = useState("");
  const [docType, setDocType] = useState<"factura" | "remito">("factura");
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [orderQuery, setOrderQuery] = useState("");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [imeiLine, setImeiLine] = useState<{ idx: number; label: string; qty: number; text: string } | null>(null);
  const editing = editInvoiceId !== null;

  // número inicial: cuando llega el historial, si la orden está intacta tomar el próximo correlativo
  const seededNo = useRef(false);
  useEffect(() => {
    if (!seededNo.current && !data.loading && order.items.length === 0 && !editing) {
      seededNo.current = true;
      setOrder((p) => ({ ...p, invoiceNo: String(data.nextNo) }));
    }
  }, [data.loading, data.nextNo, order.items.length, editing]);

  // ---- modo edición: cargar la factura del Historial en el editor ----
  const loadedEditId = useRef<string | null>(null);
  useEffect(() => {
    if (!editInvoiceId || trades.loading) return;
    if (loadedEditId.current === editInvoiceId) return;
    const inv = trades.invoices.find((x) => x.id === editInvoiceId);
    if (!inv) return;
    loadedEditId.current = editInvoiceId;
    const items = (trades.itemsByInvoice.get(inv.id) ?? []).map((it): OrderLine => {
      const model = it.model_id ? data.modelById.get(it.model_id) : undefined;
      const units = trades.unitsByItem.get(it.id) ?? [];
      return {
        itemId: it.id,
        modelId: it.model_id,
        modelName: model?.canonical_name ?? "(modelo)",
        category: model ? data.categoryNameOf(model) : "",
        qty: it.qty,
        color: it.color ?? "",
        spec: it.spec ?? "",
        supplierId: it.supplier_id,
        supplierName: it.supplier_id ? (data.supplierById.get(it.supplier_id)?.name ?? "") : "",
        cost: it.cost ?? 0,
        price: it.price ?? 0,
        imei: "",
        imeis: units.map((u) => u.imei ?? "").filter((x) => x.trim() !== ""),
        serials: units.map((u) => u.serial ?? "").filter((x) => x.trim() !== ""),
      };
    });
    const d = new Date(inv.date + "T00:00:00");
    const dmy = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
    const meta = parseOrderMeta(inv.client_pdf); // campos del template guardados al facturar
    setOrder({
      ...blankOrder(0),
      ...meta,
      items,
      invoiceNo: inv.no,
      date: dmy,
      dueDate: meta.dueDate || dmy,
      shippingCost: inv.shipping ?? 0,
      stage: inv.stage,
    });
    setClientId(inv.client_id ?? "");
    setShipId(inv.ship_id ?? "");
    setDocType(inv.type === "remito" ? "remito" : "factura");
  }, [editInvoiceId, trades, data]);

  const selClient = data.clients.find((c) => c.id === clientId) ?? null;
  const selShip = data.shippings.find((x) => x.id === shipId) ?? null;
  const totals = orderTotals(order.items, order.shippingCost);
  const remitoGroups = groupBySupplier(order.items);

  const setOrderField = (k: keyof OrderState, v: string | number) =>
    setOrder((p) => ({ ...p, [k]: v }));

  // ---- items ----
  const addOrderItem = (model: ModelRow) => {
    setOrder((p) => {
      if (p.items.some((i) => i.modelId === model.id)) return p;
      const category = data.categoryNameOf(model);
      const cheapest = data.suppliersFor(model.id)[0] ?? null;
      const supplierId = cheapest ? cheapest.supplier.id : null;
      const line: OrderLine = {
        modelId: model.id,
        modelName: model.canonical_name,
        category,
        qty: 1,
        color: "",
        spec: model.spec ?? specForCategory(category),
        supplierId,
        supplierName: cheapest ? cheapest.supplier.name : "",
        cost: supplierId ? data.costFor(model.id, supplierId, 1) : 0,
        price: data.defaultSalePrice(model.id),
        imei: "",
        imeis: [],
        serials: [],
      };
      return { ...p, items: [...p.items, line] };
    });
    setOrderQuery("");
  };

  const setItem = (idx: number, patch: Partial<OrderLine>) =>
    setOrder((p) => ({
      ...p,
      items: p.items.map((it, i) => {
        if (i !== idx) return it;
        const next = { ...it, ...patch };
        // si el proveedor tiene escala por cantidad, el costo sigue a la cantidad
        if (patch.qty !== undefined && next.modelId && data.hasTiersFor(next.modelId, next.supplierId)) {
          next.cost = data.costFor(next.modelId, next.supplierId, next.qty);
        }
        return next;
      }),
    }));

  const setItemSupplier = (idx: number, supplierId: string | null) =>
    setOrder((p) => ({
      ...p,
      items: p.items.map((it, i) => {
        if (i !== idx) return it;
        const supplierName = supplierId ? (data.supplierById.get(supplierId)?.name ?? "") : "";
        const cost = it.modelId && supplierId ? data.costFor(it.modelId, supplierId, it.qty) : it.cost;
        return { ...it, supplierId, supplierName, cost: cost || it.cost || 0 };
      }),
    }));

  const splitItem = (idx: number) =>
    setOrder((p) => {
      const src = p.items[idx];
      if (!src) return p;
      const items = [...p.items];
      items.splice(idx + 1, 0, { ...src, qty: 1, color: "", imeis: [], serials: [] });
      const dup = items[idx + 1];
      if (dup) delete dup.itemId; // la línea nueva es un item nuevo
      return { ...p, items };
    });

  const removeItem = (idx: number) =>
    setOrder((p) => ({ ...p, items: p.items.filter((_, i) => i !== idx) }));

  const numVal = (v: string): number => parseFloat(v.replace(/[^0-9.]/g, "")) || 0;

  // ---- reset / draft ----
  const resetOrder = () => {
    setOrder(blankOrder(data.nextNo));
    setClientId("");
    setShipId("");
    setActiveDraftId(null);
    setDocType("factura");
    setExpanded({});
    loadedEditId.current = null;
    if (editing) onDoneEditing();
  };

  // autosave del pedido activo (retomable): debounce 800ms, upsert POR FILA en `drafts`
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftIdRef = useRef<string | null>(null);
  draftIdRef.current = activeDraftId;
  useEffect(() => {
    if (editing) return;
    if (order.items.length === 0 && !clientId) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      const payload = serializeDraftPayload({
        order,
        clientId: clientId || null,
        shipId: shipId || null,
        ts: Date.now(),
      });
      upsertDraft.mutate(
        draftIdRef.current ? { id: draftIdRef.current, payload } : { payload },
        {
          onSuccess: (row) => {
            if (!draftIdRef.current) setActiveDraftId(row.id);
          },
        },
      );
    }, 800);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
    // deps: solo el contenido de la orden dispara el autosave (upsertDraft es estable)
  }, [order, clientId, shipId, editing]);

  const switchOrder = (id: string, payload: DraftPayload) => {
    setOrder(payload.order);
    setClientId(payload.clientId ?? "");
    setShipId(payload.shipId ?? "");
    setActiveDraftId(id);
    setDocType("factura");
  };

  const deleteDraft = (id: string) => {
    if (!confirm("¿Borrar este pedido pendiente?")) return;
    deleteDraftMut.mutate(id);
    if (id === activeDraftId) resetOrder();
  };

  // ---- facturar / PDFs ----
  const clientPdf = buildClientPdf(selClient, selShip, order.deliveryAddr);
  const facturarArgs = (): FacturarArgs => ({
    order,
    type: docType,
    clientId: clientId || null,
    shipId: shipId || null,
    clientPdf,
  });

  const invalidateInvoiceKeys = () => {
    void qc.invalidateQueries({ queryKey: keys.invoices });
    void qc.invalidateQueries({ queryKey: keys.invoiceItems() });
    void qc.invalidateQueries({ queryKey: keys.itemUnits() });
    void qc.invalidateQueries({ queryKey: keys.opsTracking });
    void qc.invalidateQueries({ queryKey: keys.drafts });
  };

  const commitNew = async (): Promise<boolean> => {
    try {
      await facturarOrder(facturarArgs());
      if (activeDraftId) deleteDraftMut.mutate(activeDraftId);
      return true;
    } catch (error) {
      reportDataError({ operation: "facturar", error });
      return false;
    } finally {
      invalidateInvoiceKeys();
    }
  };

  const doDownloadFactura = async () => {
    if (order.items.length === 0) return;
    setPdfBusy(true);
    try {
      await downloadInvoicePdf(order, clientPdf, docType);
      if (editing && editInvoiceId) {
        await updateInvoiceFromOrder(editInvoiceId, facturarArgs());
        invalidateInvoiceKeys();
        setNotice(`Factura #${order.invoiceNo} actualizada y descargada.`);
        resetOrder();
      } else {
        const ok = await commitNew();
        if (ok) {
          setNotice(`Factura #${order.invoiceNo} generada y guardada en el Historial.`);
          resetOrder();
        }
      }
    } catch (error) {
      reportDataError({ operation: "generar PDF", error });
    } finally {
      setPdfBusy(false);
    }
  };

  const doDownloadRemitos = async () => {
    if (order.items.length === 0) return;
    setPdfBusy(true);
    try {
      const n = await downloadSupplierRemitos(order, clientPdf, makeCodeResolver(data.supplierById));
      setNotice(`${n} remito(s) por proveedor descargado(s).`);
    } catch (error) {
      reportDataError({ operation: "generar remitos", error });
    } finally {
      setPdfBusy(false);
    }
  };

  const registerPastOperation = async () => {
    if (order.items.length === 0) return;
    const ok = await commitNew();
    if (ok) {
      setNotice(
        `Operación registrada (venta ${money(totals.subtotal)}, costo ${money(totals.cost)}, margen ${money(totals.margin)}).`,
      );
      resetOrder();
    }
  };

  const saveEditChanges = async () => {
    if (!editInvoiceId) return;
    try {
      await updateInvoiceFromOrder(editInvoiceId, facturarArgs());
      invalidateInvoiceKeys();
      setNotice(`Cambios guardados en la factura #${order.invoiceNo}.`);
      resetOrder();
    } catch (error) {
      reportDataError({ operation: "guardar cambios de factura", error });
    }
  };

  // ---- render ----
  const draftRows = useDraftRows(editing);

  const detailCols = docType === "factura" ? 8 : 6;
  const editRow = (it: OrderLine, idx: number, descNode: ReactNode) => {
    const sups = it.modelId ? data.suppliersFor(it.modelId) : [];
    const hasCurrent = it.supplierId && sups.some((x) => x.supplier.id === it.supplierId);
    const tierList = it.modelId ? data.tiersFor(it.modelId, it.supplierId) : [];
    const imeiCount = it.imeis.filter((x) => x.trim()).length;
    const imeiDone = it.qty > 0 && imeiCount >= it.qty;
    return (
      <tr key={`${it.modelId}-${idx}`}>
        <td style={invTd}>
          <input
            value={it.qty}
            onChange={(e) => setItem(idx, { qty: numVal(e.target.value) })}
            style={{ ...cellInput, width: 44 }}
          />
        </td>
        <td style={{ ...invTd, textAlign: "left" }}>{descNode}</td>
        <td style={invTd}>
          <input
            value={it.color}
            onChange={(e) => setItem(idx, { color: e.target.value })}
            placeholder="—"
            style={{ ...cellInput, width: 72 }}
          />
          <span
            style={{ ...chipX, color: "#8ee0a8" }}
            title="Splitear: duplica esta línea para otro color"
            onClick={() => splitItem(idx)}
          >
            +
          </span>
        </td>
        <td style={invTd}>
          <button
            onClick={() =>
              setImeiLine({
                idx,
                label: it.modelName + (it.color ? ` · ${it.color}` : ""),
                qty: it.qty,
                text: it.imeis.join("\n"),
              })
            }
            title="Cargar los IMEIs de esta línea (pegá la columna de Excel, uno por renglón)"
            style={{
              ...s.toolBtn,
              padding: "2px 8px",
              fontSize: 11,
              borderColor: imeiDone ? "#3a5" : "#5a4a1d",
              color: imeiDone ? "#8ee0a8" : "#e0b34d",
            }}
          >
            📱 {imeiCount}/{it.qty || "?"}
          </button>
        </td>
        <td style={invTd}>
          <input
            value={it.spec}
            onChange={(e) => setItem(idx, { spec: e.target.value })}
            placeholder="—"
            style={{ ...cellInput, width: 60 }}
          />
        </td>
        <td style={invTd}>
          <select
            value={it.supplierId ?? ""}
            onChange={(e) => setItemSupplier(idx, e.target.value || null)}
            style={{ ...cellInput, width: 140 }}
          >
            <option value="">—</option>
            {!hasCurrent && it.supplierId && (
              <option value={it.supplierId}>{it.supplierName || "(proveedor)"}</option>
            )}
            {sups.map(({ supplier, price }) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name} · ${Math.round(price)}
              </option>
            ))}
          </select>
        </td>
        <td style={invTd}>
          <input
            value={it.cost}
            onChange={(e) => setItem(idx, { cost: numVal(e.target.value) })}
            style={{ ...cellInput, width: 64, color: "#9aa4b2" }}
          />
          {tierList.length > 1 && (
            <span
              title={
                `Escala x cantidad (${it.supplierName}):\n` +
                tierList.map((t) => `${t.min}+ pzs → $${t.price}`).join("\n")
              }
              style={{ color: "#c084fc", fontSize: 10, marginLeft: 3, cursor: "help" }}
            >
              ⇙
            </span>
          )}
        </td>
        {docType === "factura" && (
          <td style={invTd}>
            <input
              value={it.price}
              onChange={(e) => setItem(idx, { price: numVal(e.target.value) })}
              style={{ ...cellInput, width: 70 }}
            />
          </td>
        )}
        {docType === "factura" && (
          <td style={{ ...invTd, color: "#fbbf24" }}>{money((Number(it.qty) || 0) * (Number(it.price) || 0))}</td>
        )}
        <td style={invTd}>
          <span style={chipX} onClick={() => removeItem(idx)}>
            ×
          </span>
        </td>
      </tr>
    );
  };

  // agrupar líneas por modelo (varios colores → fila total + desglose colapsable)
  const grouped = useMemo(() => {
    const groups = new Map<string, Array<{ it: OrderLine; idx: number }>>();
    order.items.forEach((it, idx) => {
      const key = it.modelId ?? `?${it.modelName}`;
      const arr = groups.get(key);
      if (arr) arr.push({ it, idx });
      else groups.set(key, [{ it, idx }]);
    });
    return [...groups.entries()];
  }, [order.items]);

  return (
    <div>
      {!editing && (
        <TradeTimeline trades={trades.openTrades} imeiProgress={trades.imeiProgress} onLoadImeis={onLoadImeis} />
      )}

      <section style={s.section}>
        <div style={s.sectionTitle}>
          {editing ? `EDITAR FACTURA #${order.invoiceNo}` : "ÓRDENES — Factura / Remito"}
        </div>

        {notice && (
          <div style={{ ...s.okMsg, marginBottom: 8 }}>
            {notice}{" "}
            <span style={chipX} onClick={() => setNotice(null)}>
              ×
            </span>
          </div>
        )}

        {/* pedidos pendientes (solo al armar órdenes nuevas) */}
        {!editing && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 10.5, color: "#6b7385" }}>PEDIDOS:</span>
            {draftRows.map((d) => {
              const on = d.id === activeDraftId;
              const cli = data.clients.find((c) => c.id === d.payload.clientId)?.name;
              const pzs = d.payload.order.items.reduce((a, i) => a + (Number(i.qty) || 0), 0);
              const names = [...new Set(d.payload.order.items.map((i) => i.modelName))];
              const hint = names.slice(0, 2).map((m) => m.split(" ")[0]).join("/") + (names.length > 2 ? "+" : "");
              const idle = Date.now() - d.payload.ts;
              const age =
                idle < 3600e3
                  ? `${Math.max(1, Math.round(idle / 60e3))}m`
                  : idle < 86400e3
                    ? `${Math.floor(idle / 3600e3)}h`
                    : `${Math.floor(idle / 86400e3)}d`;
              return (
                <span
                  key={d.id}
                  style={{
                    ...s.planTab,
                    ...(on ? s.planTabOn : {}),
                    display: "inline-flex",
                    gap: 6,
                    alignItems: "center",
                  }}
                  title={names.join(", ")}
                >
                  <span onClick={() => switchOrder(d.id, d.payload)} style={{ cursor: "pointer" }}>
                    {cli || "sin cliente"} · {hint || "—"} · {pzs}u{on ? "" : ` · ${age}`}
                  </span>
                  <span style={chipX} onClick={() => deleteDraft(d.id)}>
                    ×
                  </span>
                </span>
              );
            })}
            <button onClick={resetOrder} style={s.toolBtn}>
              + Nuevo pedido
            </button>
          </div>
        )}

        {editing && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: "#1d2740",
              border: "1px solid #3a5b8f",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 12,
              marginBottom: 8,
            }}
          >
            ✏️ Estás editando una factura ya generada — al guardar se actualiza esa misma. No afecta tus
            pedidos pendientes.
            <span style={{ flex: 1 }} />
            <button onClick={resetOrder} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
              ✕ Cerrar sin guardar
            </button>
          </div>
        )}

        {!editing && clientId && selClient && (
          <div style={{ fontSize: 11, margin: "4px 0", color: selClient.cuenta_corriente ? "#8ee0a8" : "#e0b48e" }}>
            {selClient.cuenta_corriente
              ? "🟢 con cuenta corriente"
              : "🟠 sin cuenta — cobra antes de enviar"}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
          <button
            onClick={() => setDocType("factura")}
            style={{ ...s.planTab, ...(docType === "factura" ? s.planTabOn : {}) }}
          >
            Factura (con precios)
          </button>
          <button
            onClick={() => setDocType("remito")}
            style={{ ...s.planTab, ...(docType === "remito" ? s.planTabOn : {}) }}
          >
            Remito x proveedor (sin precios)
          </button>
        </div>

        {/* cliente / envío / datos */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          <div>
            <div style={s.sectionTitle}>CLIENTE</div>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} style={{ ...s.select, width: "100%" }}>
              <option value="">— sin cliente —</option>
              {data.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {selClient && (
              <div style={{ fontSize: 11.5, marginTop: 6, color: "#8b94a7" }}>
                <div style={{ fontWeight: 600, color: "#cfd6e4" }}>{selClient.name}</div>
                {selClient.address ? <div>{selClient.address}</div> : null}
                {selClient.ruc ? <div>RUC: {selClient.ruc}</div> : null}
                {selClient.phone ? <div>Tel: {selClient.phone}</div> : null}
              </div>
            )}
            <div style={s.hint}>Agregar / editar clientes → Fase 7 (tab Clientes)</div>
          </div>

          <div>
            <div style={s.sectionTitle}>ENTREGA / SHIPPING</div>
            <select
              value={shipId}
              onChange={(e) => {
                const id = e.target.value;
                setShipId(id);
                const sh = data.shippings.find((x) => x.id === id);
                if (sh?.direccion) setOrderField("deliveryAddr", sh.direccion);
              }}
              style={{ ...s.select, width: "100%" }}
            >
              <option value="">— sin envío guardado —</option>
              {data.shippings.map((sh) => (
                <option key={sh.id} value={sh.id}>
                  {sh.label || sh.notify}
                </option>
              ))}
            </select>
            <label style={{ display: "block", marginTop: 6 }}>
              <span style={{ fontSize: 10.5, color: "#8b94a7" }}>
                Dirección de entrega (depósito) — aparece en el remito
              </span>
              <textarea
                value={order.deliveryAddr}
                onChange={(e) => setOrderField("deliveryAddr", e.target.value)}
                rows={2}
                placeholder="Dirección del depósito / destino…"
                style={{ ...s.textarea, minHeight: 40 }}
              />
            </label>
          </div>

          <div>
            <div style={s.sectionTitle}>DATOS</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {(
                [
                  ["invoiceNo", "Invoice #"],
                  ["date", "Date"],
                  ["payment", "Payment"],
                  ["fob", "FOB"],
                  ["salesperson", "Salesperson"],
                  ["terms", "Payment Terms"],
                  ["dueDate", "Due Date"],
                ] as Array<[keyof OrderState, string]>
              ).map(([k, lbl]) => (
                <label key={k} style={{ display: "block" }}>
                  <span style={{ fontSize: 10.5, color: "#8b94a7" }}>{lbl}</span>
                  <input
                    value={String(order[k])}
                    onChange={(e) => setOrderField(k, e.target.value)}
                    style={{ ...s.textInput, width: "100%", boxSizing: "border-box" }}
                  />
                </label>
              ))}
              {docType === "factura" && (
                <label style={{ display: "block" }}>
                  <span style={{ fontSize: 10.5, color: "#8b94a7" }}>Shipping $</span>
                  <input
                    value={order.shippingCost}
                    onChange={(e) => setOrderField("shippingCost", numVal(e.target.value))}
                    style={{ ...s.textInput, width: "100%", boxSizing: "border-box" }}
                  />
                </label>
              )}
            </div>
          </div>
        </div>

        {/* items */}
        <div style={{ ...s.sectionTitle, marginTop: 12 }}>ITEMS</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input
            list="catalog-dl"
            value={orderQuery}
            onChange={(e) => {
              const v = e.target.value;
              setOrderQuery(v);
              const m = data.modelByName.get(v);
              if (m) addOrderItem(m);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const q = orderQuery.trim().toLowerCase();
                const m = data.models.find((x) => x.canonical_name.toLowerCase() === q);
                if (m) addOrderItem(m);
              }
            }}
            placeholder="Agregar modelo (Enter)…"
            style={{ ...s.textInput, flex: 1, maxWidth: 420 }}
          />
          <datalist id="catalog-dl">
            {data.models.map((m) => (
              <option key={m.id} value={m.canonical_name} />
            ))}
          </datalist>
        </div>

        {order.items.length > 0 && (
          <div style={s.tableWrap}>
            <table style={{ ...s.table, minWidth: 760 }}>
              <thead>
                <tr>
                  <th style={invTh}>Qty</th>
                  <th style={{ ...invTh, textAlign: "left" }}>Descripción</th>
                  <th style={invTh}>Color</th>
                  <th style={invTh}>IMEI</th>
                  <th style={invTh}>Spec</th>
                  <th style={invTh}>Proveedor</th>
                  <th style={invTh} title="Costo del proveedor elegido × cantidad">
                    Costo
                  </th>
                  {docType === "factura" && <th style={invTh}>Precio</th>}
                  {docType === "factura" && <th style={invTh}>Line Total</th>}
                  <th style={invTh}></th>
                </tr>
              </thead>
              <tbody>
                {grouped.map(([key, rows]) => {
                  const first = rows[0];
                  if (!first) return null;
                  if (rows.length === 1) {
                    const c = first.it.color;
                    return editRow(
                      first.it,
                      first.idx,
                      <span style={{ color: "#cfd6e4" }}>
                        {first.it.modelName}
                        {c ? <span style={{ color: "#8b94a7" }}> · {c}</span> : ""}
                      </span>,
                    );
                  }
                  const totalQty = rows.reduce((a, r) => a + (Number(r.it.qty) || 0), 0);
                  const colorsTxt = rows.map((r) => `${r.it.qty} ${r.it.color || "—"}`).join(", ");
                  const open = !!expanded[key];
                  return (
                    <FragmentRows
                      key={key}
                      header={
                        <tr
                          onClick={() => setExpanded((m) => ({ ...m, [key]: !open }))}
                          style={{ cursor: "pointer", background: "#131823" }}
                        >
                          <td style={{ ...invTd, fontWeight: 700 }}>{totalQty}</td>
                          <td style={{ ...invTd, textAlign: "left", color: "#e8ecf3" }}>
                            {open ? "▾ " : "▸ "}
                            {first.it.modelName}
                          </td>
                          <td colSpan={detailCols} style={{ ...invTd, textAlign: "left", color: "#8b94a7" }}>
                            {!open ? colorsTxt : ""}
                          </td>
                        </tr>
                      }
                      rows={
                        open
                          ? rows.map((r) =>
                              editRow(
                                r.it,
                                r.idx,
                                <span style={{ color: "#6b7385", paddingLeft: 18 }}>{r.it.color || "↳"}</span>,
                              ),
                            )
                          : []
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* footer: totales + acciones */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 10,
            fontSize: 12.5,
          }}
        >
          <span>
            Total piezas: <b>{totals.piezas}</b>
            {docType === "factura" && (
              <>
                {" "}
                · Subtotal: <b style={{ color: "#fbbf24" }}>{money(totals.subtotal)}</b> · Costo:{" "}
                <b style={{ color: "#9aa4b2" }}>{money(totals.cost)}</b> · Margen:{" "}
                <b style={{ color: "#4ade80" }}>{money(totals.margin)}</b>
              </>
            )}
          </span>
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {editing ? (
              order.items.length > 0 ? (
                <>
                  <button onClick={resetOrder} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
                    ✕ Cancelar
                  </button>
                  <button
                    onClick={() => void doDownloadFactura()}
                    disabled={pdfBusy}
                    title="Guarda los cambios y descarga la factura actualizada"
                    style={s.toolBtn}
                  >
                    {pdfBusy ? "Generando…" : "⬇ Guardar + PDF"}
                  </button>
                  <button onClick={() => void saveEditChanges()} style={s.primaryBtn}>
                    💾 Guardar cambios (factura #{order.invoiceNo})
                  </button>
                </>
              ) : (
                <span style={s.hint}>Agregá al menos un item.</span>
              )
            ) : (
              <>
                {order.items.length > 0 && (
                  <button onClick={resetOrder} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
                    Nueva orden
                  </button>
                )}
                {docType === "factura" && order.items.length > 0 && (
                  <button
                    onClick={() => void registerPastOperation()}
                    title="Guarda la operación sin generar PDF (para operaciones pasadas)"
                    style={s.toolBtn}
                  >
                    Registrar sin PDF
                  </button>
                )}
                {order.items.length > 0 ? (
                  docType === "factura" ? (
                    <button
                      onClick={() => void doDownloadFactura()}
                      disabled={pdfBusy}
                      style={{ ...s.primaryBtn, ...(pdfBusy ? s.busy : {}) }}
                    >
                      {pdfBusy ? "Generando…" : "⬇ Descargar Factura PDF"}
                    </button>
                  ) : (
                    <button
                      onClick={() => void doDownloadRemitos()}
                      disabled={pdfBusy}
                      title="Un archivo por proveedor (sin precios, con dirección de entrega)"
                      style={{ ...s.primaryBtn, ...(pdfBusy ? s.busy : {}) }}
                    >
                      {pdfBusy ? "Generando…" : `⬇ Descargar Remitos por proveedor (${remitoGroups.length})`}
                    </button>
                  )
                ) : (
                  <span style={s.hint}>Agregá al menos un item para generar (cliente y envío son opcionales).</span>
                )}
              </>
            )}
          </span>
        </div>
      </section>

      {/* Modal: cargar IMEIs de una línea (pegá la columna, uno por renglón) */}
      {imeiLine && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(3,6,12,0.72)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setImeiLine(null)}
        >
          <div
            style={{
              background: "#0f1420",
              border: "1px solid #2a4a75",
              borderRadius: 8,
              padding: 16,
              width: "min(460px, 96vw)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ ...s.sectionTitle }}>📱 IMEIs — {imeiLine.label}</div>
            {(() => {
              const count = splitUnits(imeiLine.text).length;
              const ok = imeiLine.qty ? count >= imeiLine.qty : count > 0;
              return (
                <div style={{ fontSize: 12, color: ok ? "#8ee0a8" : "#e0b34d", marginBottom: 6 }}>
                  {count}/{imeiLine.qty} · pegá la columna del Excel, un IMEI por renglón
                  {count > imeiLine.qty ? ` · ⚠ sobran ${count - imeiLine.qty}` : ""}
                </div>
              );
            })()}
            <textarea
              value={imeiLine.text}
              autoFocus
              onChange={(e) => setImeiLine((v) => (v ? { ...v, text: e.target.value } : v))}
              rows={10}
              placeholder={`Pegá ${imeiLine.qty} IMEIs, uno por renglón…`}
              style={{ ...s.textarea, fontFamily: "monospace", fontSize: 11.5 }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
              <button onClick={() => setImeiLine(null)} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
                Cancelar
              </button>
              <button
                onClick={() => {
                  setItem(imeiLine.idx, { imeis: splitUnits(imeiLine.text) });
                  setImeiLine(null);
                }}
                style={s.primaryBtn}
              >
                💾 Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// pequeño helper para emitir header + filas hijas sin fragmento con key repetida
function FragmentRows({ header, rows }: { header: ReactNode; rows: ReactNode[] }) {
  return (
    <>
      {header}
      {rows}
    </>
  );
}

// drafts parseados (hook aparte para no mezclar el parse con el render)
function useDraftRows(editing: boolean): DraftEntry[] {
  const drafts = useDrafts();
  return useMemo(() => {
    if (editing) return [];
    return (drafts.data ?? []).map((d) => ({ id: d.id, payload: parseDraftPayload(d.payload) }));
  }, [drafts.data, editing]);
}

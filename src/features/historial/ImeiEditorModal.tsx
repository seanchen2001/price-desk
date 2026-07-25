// Modal: cargar IMEIs + Nº de serie POR UNIDAD, agrupados por línea de la factura
// (pegás cada columna del Excel). Guardar reescribe invoice_item_units de cada línea
// (una fila por unidad física). Port del modal del viejo electronics-price-tool.jsx.
import { useState } from "react";
import { useSetUnitsForItem, type InvoiceItemRow, type InvoiceRow, type ItemUnitRow } from "../../data/invoices";
import { splitUnits, type ImeiExportLine } from "../../domain/orders";
import s from "../mesa/styles";
import { exportImeiExcel } from "./imeiExcel";

export type ImeiEditorLine = {
  itemId: string;
  modelName: string;
  category: string;
  color: string;
  qty: number;
  text: string;
  serialText: string;
};

export function buildEditorLines(
  items: readonly InvoiceItemRow[],
  unitsByItem: Map<string, ItemUnitRow[]>,
  modelInfo: (modelId: string | null) => { name: string; category: string },
): ImeiEditorLine[] {
  return items.map((it) => {
    const info = modelInfo(it.model_id);
    const units = unitsByItem.get(it.id) ?? [];
    return {
      itemId: it.id,
      modelName: info.name,
      category: info.category,
      color: it.color ?? "",
      qty: Number(it.qty) || 0,
      text: units.map((u) => u.imei ?? "").filter((x) => x.trim() !== "").join("\n"),
      serialText: units.map((u) => u.serial ?? "").filter((x) => x.trim() !== "").join("\n"),
    };
  });
}

export function ImeiEditorModal({
  invoice,
  clienteName,
  initialLines,
  onClose,
}: {
  invoice: InvoiceRow;
  clienteName: string;
  initialLines: ImeiEditorLine[];
  onClose: () => void;
}) {
  const [lines, setLines] = useState<ImeiEditorLine[]>(initialLines);
  const setUnits = useSetUnitsForItem();
  const [saving, setSaving] = useState(false);

  const toExportLines = (): ImeiExportLine[] =>
    lines.map((l) => ({
      modelName: l.modelName,
      category: l.category,
      qty: l.qty,
      imeis: splitUnits(l.text),
      serials: splitUnits(l.serialText),
    }));

  const save = async () => {
    setSaving(true);
    try {
      for (const l of lines) {
        await setUnits.mutateAsync({
          itemId: l.itemId,
          qty: l.qty,
          imeis: splitUnits(l.text),
          serials: splitUnits(l.serialText),
        });
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(3,6,12,0.72)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#0f1420",
          border: "1px solid #2a4a75",
          borderRadius: 8,
          padding: 16,
          width: "min(720px, 96vw)",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={s.sectionTitle}>
          📱 IMEIs + Nº de serie — factura #{invoice.no} ({clienteName}) · uno por unidad (pegá cada
          columna del Excel)
        </div>
        {lines.map((l, i) => {
          const ci = splitUnits(l.text).length;
          const cs = splitUnits(l.serialText).length;
          const ok = l.qty ? ci >= l.qty : ci > 0;
          const rows = Math.min(Math.max(l.qty, 2) + 1, 8);
          const onEdit = (k: "text" | "serialText") => (v: string) =>
            setLines((ls) => ls.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
          return (
            <div key={l.itemId} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "#cfd6e4", marginBottom: 3 }}>
                {l.modelName}
                {l.color ? <span style={{ color: "#8b94a7" }}> · {l.color}</span> : null}
                <span
                  style={{
                    marginLeft: 8,
                    color: ok ? "#8ee0a8" : ci ? "#e0b34d" : "#8b94a7",
                    fontWeight: 600,
                  }}
                >
                  IMEI {ci}/{l.qty}
                </span>
                {ci > l.qty && (
                  <span style={{ marginLeft: 6, color: "#f0a0a0", fontSize: 11 }}>⚠ sobran {ci - l.qty}</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 210 }}>
                  <div style={{ fontSize: 10.5, color: "#8b94a7", marginBottom: 2 }}>IMEI</div>
                  <textarea
                    value={l.text}
                    onChange={(e) => onEdit("text")(e.target.value)}
                    rows={rows}
                    placeholder={`Pegá ${l.qty} IMEIs, uno por línea…`}
                    style={{ ...s.textarea, fontFamily: "monospace", fontSize: 11.5, minHeight: 0 }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 210 }}>
                  <div style={{ fontSize: 10.5, color: "#8b94a7", marginBottom: 2 }}>
                    Nº de serie
                    <span
                      style={{
                        marginLeft: 6,
                        color: cs && cs !== ci ? "#f0a0a0" : "#6b7385",
                        fontWeight: 600,
                      }}
                    >
                      {cs}/{l.qty}
                    </span>
                    {cs > 0 && cs !== ci && (
                      <span style={{ marginLeft: 6, color: "#f0a0a0", fontSize: 11 }}>⚠ no coincide con IMEI</span>
                    )}
                  </div>
                  <textarea
                    value={l.serialText}
                    onChange={(e) => onEdit("serialText")(e.target.value)}
                    rows={rows}
                    placeholder={`Pegá ${l.qty} seriales, uno por línea…`}
                    style={{ ...s.textarea, fontFamily: "monospace", fontSize: 11.5, minHeight: 0 }}
                  />
                </div>
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button onClick={onClose} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
            Cancelar
          </button>
          <button
            onClick={() => void exportImeiExcel(invoice.no, toExportLines())}
            style={s.toolBtn}
            title="Baja el Excel con lo que ves ahora (guardá primero si querés conservarlo)"
          >
            ⬇ Excel
          </button>
          <button onClick={() => void save()} disabled={saving} style={{ ...s.primaryBtn, ...(saving ? s.busy : {}) }}>
            {saving ? "Guardando…" : "💾 Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Pegar lista → parser SIN IA → resolvedor → preview (viejo→nuevo) → aplicar.
// Los matches se aplican por model_id; los candidateNew se mandan a la cola de
// confirmación (NUNCA se auto-crea nada — guardrail del rebuild).
import { useMemo, useState } from "react";
import { useModels } from "../../data/models";
import { usePrices } from "../../data/prices";
import { useInsertSupplier, useSuppliers } from "../../data/suppliers";
import { parseQuoteText } from "../../domain/quoteParser";
import {
  planQuote,
  useApplyMatched,
  type CandidateEntry,
  type MatchedEntry,
} from "./applyQuote";
import { money } from "./MesaTable";
import s from "./styles";

export type PendingCandidate = CandidateEntry & {
  supplierId: string;
  supplierName: string;
};

type Preview = {
  matched: MatchedEntry[];
  candidates: CandidateEntry[];
  unparsed: string[];
};

export function PastePanel(props: { onQueue: (items: PendingCandidate[]) => void }) {
  const suppliers = useSuppliers();
  const models = useModels();
  const prices = usePrices();
  const insertSupplier = useInsertSupplier();
  const applyMatched = useApplyMatched();

  const [supplierId, setSupplierId] = useState("");
  const [newSupplier, setNewSupplier] = useState("");
  const [rawText, setRawText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [planning, setPlanning] = useState(false);
  const [msg, setMsg] = useState<{ err: boolean; text: string } | null>(null);

  const supplierRows = suppliers.data ?? [];
  const selectedSupplier = supplierRows.find((sp) => sp.id === supplierId) ?? null;
  const modelNameById = useMemo(
    () => new Map((models.data ?? []).map((m) => [m.id, m.canonical_name])),
    [models.data],
  );
  const currentPrice = (modelId: string): number | null =>
    (prices.data ?? []).find((p) => p.model_id === modelId && p.supplier_id === supplierId)
      ?.price ?? null;

  const runParse = async () => {
    setMsg(null);
    if (!selectedSupplier) {
      setMsg({ err: true, text: "Elegí a qué proveedor cargar la cotización." });
      return;
    }
    const { entries, unparsed } = parseQuoteText(rawText);
    if (entries.length === 0) {
      setMsg({ err: true, text: "No encontré ninguna línea 'MODELO  precio' en el texto." });
      return;
    }
    setPlanning(true);
    try {
      const plan = await planQuote(entries);
      setPreview({ ...plan, unparsed });
    } catch (e) {
      setMsg({ err: true, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setPlanning(false);
    }
  };

  const apply = () => {
    if (!preview || !selectedSupplier) return;
    applyMatched.mutate(
      { supplierId: selectedSupplier.id, matched: preview.matched },
      {
        onSuccess: (n) => {
          const queued = preview.candidates.map((c) => ({
            ...c,
            supplierId: selectedSupplier.id,
            supplierName: selectedSupplier.name,
          }));
          if (queued.length) props.onQueue(queued);
          setPreview(null);
          setRawText("");
          setMsg({
            err: false,
            text:
              `Cargué ${n} precio${n === 1 ? "" : "s"} para ${selectedSupplier.name}` +
              (queued.length
                ? ` · ${queued.length} modelo(s) nuevo(s) → cola de confirmación`
                : ""),
          });
        },
      },
    );
  };

  const addSupplier = () => {
    const name = newSupplier.trim();
    if (!name) return;
    insertSupplier.mutate(
      { name },
      {
        onSuccess: (row) => {
          setSupplierId(row.id);
          setNewSupplier("");
        },
      },
    );
  };

  return (
    <section style={s.section}>
      <div style={s.sectionTitle}>Pegar lista — parser sin IA (la extracción con IA es Fase 8)</div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} style={s.select}>
          <option value="">— proveedor —</option>
          {supplierRows.map((sp) => (
            <option key={sp.id} value={sp.id}>
              {sp.name}
            </option>
          ))}
        </select>
        <span style={{ display: "inline-flex", gap: 4 }}>
          <input
            value={newSupplier}
            onChange={(e) => setNewSupplier(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSupplier()}
            placeholder="+ proveedor nuevo"
            style={{ ...s.textInput, width: 130 }}
          />
          {newSupplier.trim() && (
            <button onClick={addSupplier} style={s.toolBtn} disabled={insertSupplier.isPending}>
              Crear
            </button>
          )}
        </span>
        <textarea
          value={rawText}
          onChange={(e) => {
            setRawText(e.target.value);
            setPreview(null);
          }}
          rows={3}
          placeholder={
            'ej.\nS26 12+512 5G DS (20 pcs) 610\nS26 12+512 5G DS (50+ pcs) 595\niPhone 17 Pro 256GB Blue US Specs 999'
          }
          style={{ ...s.textarea, flex: 1, minWidth: 280 }}
        />
        <button
          onClick={() => void runParse()}
          disabled={planning || !rawText.trim()}
          style={{ ...s.primaryBtn, ...(planning ? s.busy : {}) }}
        >
          {planning ? "Resolviendo…" : "Parsear"}
        </button>
      </div>

      {msg && <div style={msg.err ? s.errorMsg : s.okMsg}>{msg.text}</div>}

      {preview && (
        <>
          <table style={s.previewTable}>
            <tbody>
              {preview.matched.map((m) => {
                const old = currentPrice(m.modelId);
                return (
                  <tr key={m.modelId + m.entry.aliasKey}>
                    <td style={{ ...s.pvTd, ...s.pvName }}>
                      {modelNameById.get(m.modelId) ?? m.entry.rawName}
                      {m.entry.rawName !== (modelNameById.get(m.modelId) ?? "") && (
                        <span style={s.queueMeta}> (visto como “{m.entry.rawName}”)</span>
                      )}
                    </td>
                    <td style={{ ...s.pvTd, textAlign: "right" }}>
                      {old !== null && old !== m.entry.price && (
                        <span style={s.pvOld}>{money(old)} </span>
                      )}
                      <span style={s.pvNew}>{money(m.entry.price)}</span>
                      {m.entry.tiers.length > 1 && (
                        <span style={s.tierTag}>
                          {" "}
                          escala: {m.entry.tiers.map((t) => `${t.min_qty}+→$${t.price}`).join(" ")}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {preview.candidates.map((c) => (
                <tr key={c.aliasKey}>
                  <td style={{ ...s.pvTd, ...s.pvName }}>
                    {c.entry.rawName}
                    <span style={s.pvBadgeNew}>NUEVO → cola de confirmación</span>
                  </td>
                  <td style={{ ...s.pvTd, textAlign: "right" }}>
                    <span style={s.pvNew}>{money(c.entry.price)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.unparsed.length > 0 && (
            <div style={s.hint}>
              Ignoradas (sin “modelo precio”): {preview.unparsed.join(" · ")}
            </div>
          )}
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button
              onClick={apply}
              disabled={applyMatched.isPending}
              style={{ ...s.primaryBtn, ...(applyMatched.isPending ? s.busy : {}) }}
            >
              {applyMatched.isPending
                ? "Aplicando…"
                : `Aplicar ${preview.matched.length} precio(s)` +
                  (preview.candidates.length ? ` + encolar ${preview.candidates.length}` : "")}
            </button>
            <button onClick={() => setPreview(null)} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
              Cancelar
            </button>
          </div>
        </>
      )}
      {!preview && (
        <div style={s.hint}>
          Formato: una línea por modelo, “MODELO precio”. “(20 pcs) / (50+ pcs)” con precios
          distintos se pliegan como escala del MISMO modelo (jamás filas separadas).
        </div>
      )}
    </section>
  );
}

// Pegar lista → parser SIN IA → resolvedor → preview (viejo→nuevo) → aplicar.
// Los matches se aplican por model_id; los candidateNew se mandan a la cola de
// confirmación (NUNCA se auto-crea nada — guardrail del rebuild).
//
// Fase 8 — "Analizar con IA": extracción propose-only (Gemini 2.5 Flash, temp 0,
// responseSchema). La IA SOLO propone [{rawName, price, tiers}]; el flujo después es el
// MISMO (planQuote → resolver → cola). Auto-aplica únicamente matches existentes con
// delta ≤ ±15% (umbral del viejo); delta grande queda en el preview para confirmar y lo
// nuevo SIEMPRE va a la cola.
import { useMemo, useState, type ClipboardEvent } from "react";
import { useModels } from "../../data/models";
import { usePrices } from "../../data/prices";
import { useInsertSupplier, useSuppliers } from "../../data/suppliers";
import { parseQuoteText } from "../../domain/quoteParser";
import {
  checkQuoteEntry,
  extractQuoteAI,
  extractedToQuoteEntries,
  PRICE_AUTO_THRESHOLD,
} from "../agent/extraction";
import type { GeminiImage } from "../agent/gemini";
import {
  planQuote,
  useApplyMatched,
  type CandidateEntry,
  type MatchedEntry,
} from "./applyQuote";
import { money } from "./MesaTable";
import type { PendingCandidate } from "./queueStore";
import s from "./styles";

export type { PendingCandidate } from "./queueStore";

type Preview = {
  matched: MatchedEntry[];
  candidates: CandidateEntry[];
  unparsed: string[];
  /** motivos de revisión por aliasKey (checks determinísticos del flujo IA) */
  notes?: Record<string, string[]>;
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
  const [images, setImages] = useState<GeminiImage[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [planning, setPlanning] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
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

  // captura screenshots pegados en el textarea (Ctrl+V de una imagen) para la extracción IA
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        if (b64) setImages((prev) => [...prev, { mimeType: file.type, data: b64 }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const runAI = async () => {
    setMsg(null);
    if (!selectedSupplier) {
      setMsg({ err: true, text: "Elegí a qué proveedor cargar la cotización." });
      return;
    }
    if (!rawText.trim() && images.length === 0) {
      setMsg({ err: true, text: "Pegá el texto de la cotización o un screenshot." });
      return;
    }
    setAiBusy(true);
    setPreview(null);
    try {
      const textArg = rawText.trim() === "" ? {} : { text: rawText };
      const items = await extractQuoteAI({ ...textArg, images });
      if (items.length === 0) {
        setMsg({ err: true, text: "La IA no encontró ningún producto con precio." });
        return;
      }
      const entries = extractedToQuoteEntries(items);
      const plan = await planQuote(entries);
      const auto: MatchedEntry[] = [];
      const review: MatchedEntry[] = [];
      const notes: Record<string, string[]> = {};
      // Mín actual del MODELO (todos los proveedores) para el sanity-check de unidad/rango
      const minOfModel = (modelId: string): number | null => {
        const vals = (prices.data ?? [])
          .filter((p) => p.model_id === modelId)
          .map((p) => p.price);
        return vals.length ? Math.min(...vals) : null;
      };
      for (const m of plan.matched) {
        const flags = checkQuoteEntry(m.entry, {
          pairPrice: currentPrice(m.modelId),
          modelMin: minOfModel(m.modelId),
        });
        if (flags.length === 0) {
          auto.push(m);
        } else {
          review.push(m);
          notes[m.entry.aliasKey] = flags.map(
            (f) => f.motivo + (f.sugerencia !== undefined ? ` → ¿${money(f.sugerencia)}?` : ""),
          );
        }
      }
      if (auto.length > 0) {
        await applyMatched.mutateAsync({ supplierId: selectedSupplier.id, matched: auto });
      }
      const queued = plan.candidates.map((c) => ({
        ...c,
        supplierId: selectedSupplier.id,
        supplierName: selectedSupplier.name,
      }));
      if (queued.length > 0) props.onQueue(queued);
      const detected = items.find((i) => i.supplier !== "")?.supplier ?? "";
      const supplierNote =
        detected !== "" && detected.toLowerCase() !== selectedSupplier.name.toLowerCase()
          ? ` · OJO: el texto menciona al proveedor “${detected}” (cargué a ${selectedSupplier.name})`
          : "";
      setMsg({
        err: false,
        text:
          `IA: apliqué ${auto.length} precio(s)` +
          (review.length
            ? ` · ${review.length} con FLAG (delta > ±${PRICE_AUTO_THRESHOLD}%, sanidad o escalera) a confirmar abajo`
            : "") +
          (queued.length ? ` · ${queued.length} nuevo(s) → cola de confirmación` : "") +
          supplierNote,
      });
      if (review.length > 0) {
        setPreview({ matched: review, candidates: [], unparsed: [], notes });
      } else {
        setRawText("");
        setImages([]);
      }
    } catch (e) {
      setMsg({ err: true, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setAiBusy(false);
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
      <div style={s.sectionTitle}>
        Pegar lista — parser de texto o “Analizar con IA” (propose-only: la IA solo propone;
        resuelve el resolvedor)
      </div>
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
          onPaste={onPaste}
          rows={3}
          placeholder={
            'ej.\nS26 12+512 5G DS (20 pcs) 610\nS26 12+512 5G DS (50+ pcs) 595\niPhone 17 Pro 256GB Blue US Specs 999\n(también podés pegar un screenshot para la IA)'
          }
          style={{ ...s.textarea, flex: 1, minWidth: 280 }}
        />
        <span style={{ display: "inline-flex", flexDirection: "column", gap: 6 }}>
          <button
            onClick={() => void runParse()}
            disabled={planning || aiBusy || !rawText.trim()}
            style={{ ...s.primaryBtn, ...(planning ? s.busy : {}) }}
          >
            {planning ? "Resolviendo…" : "Parsear"}
          </button>
          <button
            onClick={() => void runAI()}
            disabled={aiBusy || planning || (!rawText.trim() && images.length === 0)}
            style={{ ...s.primaryBtn, ...(aiBusy ? s.busy : {}) }}
            title="Extracción con Gemini (propose-only): tiers a la escala, nada se crea sin confirmar"
          >
            {aiBusy ? "Analizando…" : "✨ Analizar con IA"}
          </button>
        </span>
      </div>
      {images.length > 0 && (
        <div style={{ ...s.hint, display: "flex", gap: 8, alignItems: "center" }}>
          {images.length} screenshot(s) para la IA
          <button onClick={() => setImages([])} style={{ ...s.toolBtn, ...s.toolBtnGhost }}>
            quitar
          </button>
        </div>
      )}

      {msg && <div style={msg.err ? s.errorMsg : s.okMsg}>{msg.text}</div>}

      {preview && (
        <>
          <table style={s.previewTable}>
            <tbody>
              {preview.matched.map((m) => {
                const old = currentPrice(m.modelId);
                const flags = preview.notes?.[m.entry.aliasKey];
                return (
                  <tr key={m.modelId + m.entry.aliasKey}>
                    <td style={{ ...s.pvTd, ...s.pvName }}>
                      {modelNameById.get(m.modelId) ?? m.entry.rawName}
                      {m.entry.rawName !== (modelNameById.get(m.modelId) ?? "") && (
                        <span style={s.queueMeta}> (visto como “{m.entry.rawName}”)</span>
                      )}
                      {flags && flags.length > 0 && (
                        <div style={{ color: "#f87171", fontSize: 11 }}>
                          🚩 {flags.join(" · ")}
                        </div>
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

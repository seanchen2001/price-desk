// Panel "NEGOCIACIÓN EN CURSO" — la lista stageada por analyze_quote, operable también
// desde la Mesa: aplicar/descartar línea a línea con clicks (misma applyEntry por fila
// que el chat) o aplicar todas las 🟢 de una. Vestido con el sistema visual del viejo.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { keys } from "../../data/keys";
import { CLASS_EMOJI, type StagedLine } from "../../domain/negotiation";
import { useNegotiation } from "../agent/negotiationStore";
import { applyEntry } from "./applyQuote";
import { money } from "./MesaTable";
import s from "./styles";

function useApplyStagedLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["mesa", "apply-staged-line"],
    mutationFn: async (vars: { supplierId: string; line: StagedLine }) => {
      await applyEntry(vars.line.modelId, vars.supplierId, {
        rawName: vars.line.rawName,
        aliasKey: vars.line.aliasKey,
        price: vars.line.price,
        tiers: vars.line.tiers,
        lines: [vars.line.rawName],
      });
      return vars.line.aliasKey;
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.prices() }),
        qc.invalidateQueries({ queryKey: keys.priceTiers() }),
        qc.invalidateQueries({ queryKey: keys.priceHistory() }),
      ]),
  });
}

export function NegotiationPanel() {
  const neg = useNegotiation((st) => st.current);
  const removeLines = useNegotiation((st) => st.removeLines);
  const clear = useNegotiation((st) => st.clear);
  const apply = useApplyStagedLine();

  if (!neg || neg.lines.length === 0) return null;

  const oportunidades = neg.lines.filter((l) => l.analysis.clasificacion === "oportunidad");

  const applyOne = (line: StagedLine) => {
    apply.mutate(
      { supplierId: neg.supplierId, line },
      { onSuccess: (aliasKey) => removeLines([aliasKey]) },
    );
  };
  const applyMany = async (lines: StagedLine[]) => {
    for (const l of lines) {
      // secuencial por fila (errores visibles vía hub de datos)
      await apply.mutateAsync({ supplierId: neg.supplierId, line: l });
      removeLines([l.aliasKey]);
    }
  };

  return (
    <section style={s.section}>
      <div style={{ ...s.sectionTitle, color: "#6fa8e6" }}>
        NEGOCIACIÓN EN CURSO — lista de {neg.supplierName} ({neg.lines.length} línea(s); nada
        se aplica solo)
      </div>
      <div style={{ ...s.quoteBar, marginBottom: 8 }}>
        {oportunidades.length > 0 && (
          <button
            onClick={() => void applyMany(oportunidades)}
            style={s.copyBtn}
            disabled={apply.isPending}
            title="Aplica SOLO las líneas 🟢 (mejores que nuestro mín)"
          >
            Aplicar {oportunidades.length} oportunidad(es) 🟢
          </button>
        )}
        <button onClick={clear} style={{ ...s.toolBtn, ...s.toolBtnGhost, marginLeft: 0 }}>
          Descartar todo
        </button>
      </div>
      <table style={s.previewTable}>
        <tbody>
          {neg.lines.map((l) => (
            <tr key={l.aliasKey}>
              <td style={{ ...s.pvTd, width: 20 }} title={l.analysis.clasificacion}>
                {CLASS_EMOJI[l.analysis.clasificacion]}
              </td>
              <td style={{ ...s.pvTd, ...s.pvName }}>
                {l.modelName}
                {l.flags.length > 0 && (
                  <div style={{ color: "#f87171", fontSize: 10.5 }}>
                    🚩 {l.flags.map((f) => f.motivo).join(" · ")}
                  </div>
                )}
              </td>
              <td style={{ ...s.pvTd, textAlign: "right" }}>
                <span style={s.pvNew}>{money(l.price)}</span>
                {l.tiers.length > 1 && (
                  <span style={s.tierTag}> escala ×{l.tiers.length}</span>
                )}
              </td>
              <td style={{ ...s.pvTd, color: "#8b94a7", fontSize: 11 }}>
                {l.analysis.min
                  ? `mín ${money(l.analysis.min.price)}${
                      l.analysis.vs_min_pct !== null
                        ? ` (${l.analysis.vs_min_pct > 0 ? "+" : ""}${l.analysis.vs_min_pct}%)`
                        : ""
                    }`
                  : "sin referencia"}
              </td>
              <td style={{ ...s.pvTd, whiteSpace: "nowrap" }}>
                <button
                  onClick={() => applyOne(l)}
                  style={s.miniBtn}
                  disabled={apply.isPending}
                >
                  Aplicar
                </button>{" "}
                <button
                  onClick={() => removeLines([l.aliasKey])}
                  style={{ ...s.miniBtn, ...s.toolBtnGhost }}
                  title="Descartar sin aplicar"
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

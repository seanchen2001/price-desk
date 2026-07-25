// Staging de NEGOCIACIÓN (zustand + persist): la lista analizada por analyze_quote queda
// acá — visible/operable desde la Mesa (panel "Negociación en curso") y desde el chat
// (apply_lines / discard_lines / counter_offer). Sobrevive reloads. UNA negociación por
// vez (stage() reemplaza). Guardrail: acá NO se aplica nada — aplicar siempre pasa por
// applyEntry (mutación por fila) disparado por instrucción explícita (chat o click).
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StagedNegotiation } from "../../domain/negotiation";

type NegotiationState = {
  current: StagedNegotiation | null;
  stage: (neg: StagedNegotiation) => void;
  removeLines: (aliasKeys: readonly string[]) => void;
  clear: () => void;
};

export const useNegotiation = create<NegotiationState>()(
  persist(
    (set) => ({
      current: null,
      stage: (neg) => set({ current: neg }),
      removeLines: (aliasKeys) =>
        set((st) => {
          if (!st.current) return st;
          const drop = new Set(aliasKeys);
          const lines = st.current.lines.filter((l) => !drop.has(l.aliasKey));
          return { current: lines.length === 0 ? null : { ...st.current, lines } };
        }),
      clear: () => set({ current: null }),
    }),
    { name: "price-desk-negotiation" },
  ),
);

// acceso imperativo (executor del agente, fuera de React)
export const getStagedNegotiation = (): StagedNegotiation | null =>
  useNegotiation.getState().current;
export const setStagedNegotiation = (neg: StagedNegotiation): void =>
  useNegotiation.getState().stage(neg);
export const removeStagedLines = (aliasKeys: readonly string[]): void =>
  useNegotiation.getState().removeLines(aliasKeys);
export const clearStagedNegotiation = (): void => useNegotiation.getState().clear();

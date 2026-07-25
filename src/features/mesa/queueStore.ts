// Cola de confirmación COMPARTIDA (zustand + persist): la alimentan el paste de la Mesa,
// la extracción con IA y la tool load_quote del agente (chat). Antes vivía en el estado
// de MesaView y se perdía al cambiar de tab; ahora sobrevive a tabs y reloads.
// Guardrail intacto: acá solo se ENCOLA — crear/vincular sigue pasando por ConfirmQueue
// (humano) → confirmCandidate/createModelWithAlias.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { QuoteEntry } from "../../domain/quoteParser";

export type PendingCandidate = {
  entry: QuoteEntry;
  aliasKey: string;
  supplierId: string;
  supplierName: string;
};

type ConfirmQueueState = {
  items: PendingCandidate[];
  /** agrega deduplicando por (aliasKey, supplierId) — el más nuevo pisa */
  enqueue: (items: readonly PendingCandidate[]) => void;
  /** saca todas las entradas de esa aliasKey (mismo comportamiento que el onDone viejo) */
  remove: (aliasKey: string) => void;
};

export const useConfirmQueue = create<ConfirmQueueState>()(
  persist(
    (set) => ({
      items: [],
      enqueue: (incoming) =>
        set((st) => {
          const key = (i: PendingCandidate) => `${i.aliasKey}::${i.supplierId}`;
          const next = new Map(st.items.map((i) => [key(i), i]));
          for (const i of incoming) next.set(key(i), i);
          return { items: [...next.values()] };
        }),
      remove: (aliasKey) =>
        set((st) => ({ items: st.items.filter((i) => i.aliasKey !== aliasKey) })),
    }),
    { name: "price-desk-confirm-queue" },
  ),
);

/** Para código fuera de React (executor del agente): encolar imperativo. */
export const enqueueCandidates = (items: readonly PendingCandidate[]): void =>
  useConfirmQueue.getState().enqueue(items);

// Pipeline paste → resolver → aplicar de la Mesa (Fase 5). Compartido por la UI y por
// el test de verificación anti-duplicados (test/mesa.integration.test.ts).
//
// Guardrails que este módulo garantiza:
//   - CERO auto-creación: los candidateNew NUNCA se escriben acá; van a la cola de
//     confirmación (la UI llama confirmCandidate/createModelWithAlias al confirmar).
//   - Escalas SIEMPRE a price_tiers del par (model, supplier) — la fila es UNA sola.
//   - Todo por model_id/supplier_id, jamás por nombre.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QuoteEntry } from "../../domain/quoteParser";
import { keys } from "../../data/keys";
import { appendPriceHistory, setTiersForPair, upsertPrice } from "../../data/prices";
import { fetchResolverSnapshot } from "../../data/resolverRepo";
import { resolveModel } from "../../domain/resolver";
import { supabase, type Db } from "../../data/supabase";

export type MatchedEntry = { entry: QuoteEntry; modelId: string };
export type CandidateEntry = { entry: QuoteEntry; aliasKey: string };

export type QuotePlan = {
  matched: MatchedEntry[];
  candidates: CandidateEntry[];
};

/** Resuelve N entradas con UN snapshot del resolver (no escribe nada). */
export async function planQuote(
  entries: readonly QuoteEntry[],
  db: Db = supabase,
): Promise<QuotePlan> {
  const repo = await fetchResolverSnapshot(db);
  const matched: MatchedEntry[] = [];
  const candidates: CandidateEntry[] = [];
  for (const entry of entries) {
    const r = resolveModel(entry.rawName, {}, repo);
    if ("modelId" in r) matched.push({ entry, modelId: r.modelId });
    else candidates.push({ entry, aliasKey: r.aliasKey });
  }
  return { matched, candidates };
}

/**
 * Aplica UNA entrada ya resuelta: precio (upsert por fila + history append-only) y
 * escalera del par (reemplazo scoped; [] la limpia si el quote nuevo no trae escalones).
 */
export async function applyEntry(
  modelId: string,
  supplierId: string,
  entry: QuoteEntry,
  db: Db = supabase,
): Promise<void> {
  const pair = { model_id: modelId, supplier_id: supplierId };
  await upsertPrice({ ...pair, price: entry.price }, db);
  await appendPriceHistory({ ...pair, price: entry.price }, db);
  await setTiersForPair(pair, entry.tiers, db);
}

// ---------- hooks ----------

/** Aplica los matches de un plan (secuencial, errores visibles) e invalida el cache. */
export function useApplyMatched() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["mesa", "apply-matched"],
    mutationFn: async (vars: { supplierId: string; matched: readonly MatchedEntry[] }) => {
      for (const m of vars.matched) await applyEntry(m.modelId, vars.supplierId, m.entry);
      return vars.matched.length;
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.prices() }),
        qc.invalidateQueries({ queryKey: keys.priceTiers() }),
        qc.invalidateQueries({ queryKey: keys.priceHistory() }),
      ]),
  });
}

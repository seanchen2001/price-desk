// Política de autonomía (P2) — PURA: envuelve ToolDeps según el modo de la escalera
// de confianza. El executor no sabe de modos; la política vive en las DEPS:
//   shadow       → deps mutantes = RECORDER (journal "registrado", cero escrituras) con
//                  OVERLAY en memoria: las lecturas reflejan el estado "como-si", así el
//                  verify-after-write del executor registra el estado simulado coherente.
//   auto_limited → límites ANTES de delegar (maxDeltaPct vs el par actual, maxLines por
//                  corrida, maxTotalImpactUsd acumulado); exceso = journal
//                  "denegado_por_politica" + throw ruidoso (cero escrituras).
//   full         → pasa (journal "ejecutado" para auditoría).
// CONFIRM_TOOLS headless (deletePrice/setSupplierActive): sombra y limitado = solo
// registrar; full = ejecutar.
import type { QuoteTier } from "../../domain/quoteParser";
import type {
  AgentPriceRow,
  AgentSaleRow,
  AgentTierRow,
  ToolDeps,
} from "./executor";

export type AgentMode = "shadow" | "auto_limited" | "full";

export type AgentLimits = {
  /** |delta| máximo vs el precio actual del par (%); pares nuevos no tienen delta */
  maxDeltaPct: number;
  /** máximo de líneas de precio escritas por corrida */
  maxLines: number;
  /** impacto acumulado máximo por corrida: Σ |nuevo − viejo| en USD */
  maxTotalImpactUsd: number;
};

export const DEFAULT_LIMITS: AgentLimits = {
  maxDeltaPct: 15,
  maxLines: 20,
  maxTotalImpactUsd: 5000,
};

export type AgentPolicy = {
  task: string;
  mode: AgentMode;
  limits: AgentLimits;
};

export type PolicyEventKind = "registrado" | "ejecutado" | "denegado_por_politica";

export type PolicyEvent = {
  ts: string;
  kind: PolicyEventKind;
  dep: string;
  detalle: Record<string, unknown>;
};

export type PolicyJournal = (event: PolicyEvent) => void;

// deps que en la UI piden confirmación humana (deletePrice / setSupplierActive):
// headless en sombra y limitado SOLO se registran; en full ejecutan (el humano ya
// habilitó el modo). Están cableadas explícitamente en cada rama de abajo.
const pairKey = (modelId: string, supplierId: string): string => `${modelId}::${supplierId}`;

export function wrapDepsWithPolicy(
  deps: ToolDeps,
  policy: AgentPolicy,
  journal: PolicyJournal,
): ToolDeps {
  const log = (kind: PolicyEventKind, dep: string, detalle: Record<string, unknown>): void =>
    journal({ ts: new Date().toISOString(), kind, dep, detalle });

  // ---------- overlay de sombra (estado "como-si" para lecturas/verify) ----------
  const shadowPrices = new Map<string, number>();
  const shadowTiers = new Map<string, QuoteTier[]>();
  const shadowSales = new Map<string, number | null>(); // null = Lista borrada

  const overlayPrices = async (): Promise<AgentPriceRow[]> => {
    const rows = (await deps.listPrices()).map((r) => ({ ...r }));
    const byPair = new Map(rows.map((r) => [pairKey(r.model_id, r.supplier_id), r]));
    const now = new Date().toISOString();
    for (const [key, price] of shadowPrices) {
      const [modelId, supplierId] = key.split("::") as [string, string];
      const existing = byPair.get(key);
      if (existing) {
        existing.price = price;
        existing.updated_at = now;
      } else {
        byPair.set(key, { model_id: modelId, supplier_id: supplierId, price, updated_at: now });
      }
    }
    return [...byPair.values()];
  };
  const overlayTiers = async (): Promise<AgentTierRow[]> => {
    const rows = (await deps.listTiers()).filter(
      (t) => !shadowTiers.has(pairKey(t.model_id, t.supplier_id)),
    );
    for (const [key, tiers] of shadowTiers) {
      const [modelId, supplierId] = key.split("::") as [string, string];
      for (const t of tiers) rows.push({ model_id: modelId, supplier_id: supplierId, ...t });
    }
    return rows;
  };
  const overlaySales = async (): Promise<AgentSaleRow[]> => {
    const rows = (await deps.listSalePrices()).filter((s) => !shadowSales.has(s.model_id));
    for (const [modelId, price] of shadowSales) {
      if (price !== null) rows.push({ model_id: modelId, price });
    }
    return rows;
  };

  // ---------- límites de auto_limited (estado por corrida) ----------
  let linesUsed = 0;
  let impactUsed = 0;

  const currentPairPrice = async (modelId: string, supplierId: string): Promise<number | null> =>
    (await deps.listPrices()).find((p) => p.model_id === modelId && p.supplier_id === supplierId)
      ?.price ?? null;

  /** chequea límites para UNA escritura de precio; throw ruidoso si excede. */
  const enforceLimits = async (
    dep: string,
    modelId: string,
    supplierId: string,
    newPrice: number,
    detalle: Record<string, unknown>,
  ): Promise<void> => {
    const { maxDeltaPct, maxLines, maxTotalImpactUsd } = policy.limits;
    const prev = await currentPairPrice(modelId, supplierId);
    const deltaPct = prev !== null && prev !== 0 ? Math.abs(((newPrice - prev) / prev) * 100) : null;
    const impact = prev !== null ? Math.abs(newPrice - prev) : 0;
    let motivo: string | null = null;
    if (deltaPct !== null && deltaPct > maxDeltaPct) {
      motivo = `delta ${deltaPct.toFixed(1)}% > maxDeltaPct ${maxDeltaPct}%`;
    } else if (linesUsed + 1 > maxLines) {
      motivo = `líneas ${linesUsed + 1} > maxLines ${maxLines}`;
    } else if (impactUsed + impact > maxTotalImpactUsd) {
      motivo = `impacto acumulado $${(impactUsed + impact).toFixed(0)} > maxTotalImpactUsd $${maxTotalImpactUsd}`;
    }
    if (motivo !== null) {
      log("denegado_por_politica", dep, { ...detalle, motivo });
      throw new Error(`denegado_por_politica: ${motivo} (modo ${policy.mode}, tarea ${policy.task})`);
    }
    linesUsed += 1;
    impactUsed += impact;
  };

  // ---------- wrappers genéricos ----------
  type AnyFn = (...a: never[]) => unknown;
  const record =
    <F extends AnyFn>(dep: string, syntheticResult?: unknown, sideEffect?: (...a: Parameters<F>) => void) =>
    (async (...a: Parameters<F>) => {
      log("registrado", dep, { args: a as unknown as Record<string, unknown> });
      sideEffect?.(...a);
      return syntheticResult;
    }) as unknown as F;

  const passThrough =
    <F extends AnyFn>(dep: string, fn: F) =>
    (async (...a: Parameters<F>) => {
      const out = await (fn as (...x: Parameters<F>) => Promise<unknown>)(...a);
      log("ejecutado", dep, { args: a as unknown as Record<string, unknown> });
      return out;
    }) as unknown as F;

  const syntheticModel = (name: string) => ({
    id: `sombra:${name}`,
    canonical_name: name,
    category_id: null,
    department_id: null,
  });

  if (policy.mode === "shadow") {
    return {
      ...deps,
      // lecturas con overlay: el verify del executor "lee" el estado simulado
      listPrices: overlayPrices,
      listTiers: overlayTiers,
      listSalePrices: overlaySales,
      // mutantes → recorder (con efecto en el overlay donde corresponde)
      createModelWithAlias: record("createModelWithAlias", syntheticModel("(sombra)")),
      renameModelWithAlias: record("renameModelWithAlias", syntheticModel("(sombra)")),
      setModelCategory: record("setModelCategory", undefined),
      insertCategory: record("insertCategory", { id: "sombra:cat", name: "(sombra)" }),
      renameCategory: record("renameCategory", { id: "sombra:cat", name: "(sombra)" }),
      insertSupplier: record("insertSupplier", { id: "sombra:sp", name: "(sombra)", active: true }),
      setSupplierActive: record("setSupplierActive", undefined),
      upsertPrice: record("upsertPrice", undefined, (row: { model_id: string; supplier_id: string; price: number }) => {
        shadowPrices.set(pairKey(row.model_id, row.supplier_id), row.price);
      }),
      appendPriceHistory: record("appendPriceHistory", undefined),
      setTiersForPair: record(
        "setTiersForPair",
        undefined,
        (pair: { model_id: string; supplier_id: string }, tiers: QuoteTier[]) => {
          shadowTiers.set(pairKey(pair.model_id, pair.supplier_id), tiers.map((t) => ({ ...t })));
        },
      ),
      deletePrice: record("deletePrice", undefined),
      upsertSalePrice: record("upsertSalePrice", undefined, (row: { model_id: string; price: number }) => {
        shadowSales.set(row.model_id, row.price);
      }),
      deleteSalePrice: record("deleteSalePrice", undefined, (modelId: string) => {
        shadowSales.set(modelId, null);
      }),
      applyQuoteEntry: record(
        "applyQuoteEntry",
        undefined,
        (modelId: string, supplierId: string, entry: { price: number; tiers: QuoteTier[] }) => {
          shadowPrices.set(pairKey(modelId, supplierId), entry.price);
          shadowTiers.set(
            pairKey(modelId, supplierId),
            entry.tiers.length > 1 ? entry.tiers.map((t) => ({ ...t })) : [],
          );
        },
      ),
      insertKnowledge: record("insertKnowledge", undefined),
    };
  }

  if (policy.mode === "auto_limited") {
    return {
      ...deps,
      // catálogo/memoria: ejecutan con registro
      createModelWithAlias: passThrough("createModelWithAlias", deps.createModelWithAlias),
      renameModelWithAlias: passThrough("renameModelWithAlias", deps.renameModelWithAlias),
      setModelCategory: passThrough("setModelCategory", deps.setModelCategory),
      insertCategory: passThrough("insertCategory", deps.insertCategory),
      renameCategory: passThrough("renameCategory", deps.renameCategory),
      insertSupplier: passThrough("insertSupplier", deps.insertSupplier),
      insertKnowledge: passThrough("insertKnowledge", deps.insertKnowledge),
      appendPriceHistory: passThrough("appendPriceHistory", deps.appendPriceHistory),
      upsertSalePrice: passThrough("upsertSalePrice", deps.upsertSalePrice),
      deleteSalePrice: passThrough("deleteSalePrice", deps.deleteSalePrice),
      setTiersForPair: passThrough("setTiersForPair", deps.setTiersForPair),
      // escrituras de PRECIO: límites antes de delegar
      upsertPrice: async (row) => {
        await enforceLimits("upsertPrice", row.model_id, row.supplier_id, row.price, { row });
        await deps.upsertPrice(row);
        log("ejecutado", "upsertPrice", { row });
      },
      applyQuoteEntry: async (modelId, supplierId, entry) => {
        await enforceLimits("applyQuoteEntry", modelId, supplierId, entry.price, {
          modelId,
          supplierId,
          price: entry.price,
        });
        await deps.applyQuoteEntry(modelId, supplierId, entry);
        log("ejecutado", "applyQuoteEntry", { modelId, supplierId, price: entry.price });
      },
      // confirmables headless: en limitado NO se ejecutan — solo registro
      deletePrice: record("deletePrice", undefined),
      setSupplierActive: record("setSupplierActive", undefined),
    };
  }

  // full: todo pasa, todo queda auditado
  const wrapped: ToolDeps = { ...deps };
  const MUTATING_DEP_NAMES = [
    "createModelWithAlias",
    "renameModelWithAlias",
    "setModelCategory",
    "insertCategory",
    "renameCategory",
    "insertSupplier",
    "setSupplierActive",
    "upsertPrice",
    "appendPriceHistory",
    "setTiersForPair",
    "deletePrice",
    "upsertSalePrice",
    "deleteSalePrice",
    "applyQuoteEntry",
    "insertKnowledge",
  ] as const;
  for (const name of MUTATING_DEP_NAMES) {
    const fn = deps[name] as AnyFn;
    (wrapped as Record<string, unknown>)[name] = passThrough(name, fn as never);
  }
  return wrapped;
}

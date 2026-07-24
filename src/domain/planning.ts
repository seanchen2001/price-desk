// Sourcing y planificación: escalas (tiers), ranking de proveedores, snapshots semanales,
// reporte de negociación y el cotizador (planBestPrice / planMinSuppliers).
// Portado 1:1 de lib/pricing.js + price-logic.js — misma matemática; firmas por ID:
// los mapas se keyean por modelId / supplierId (el viejo usaba nombre de modelo/proveedor).
// PORT-NOTE: campos de salida renombrados con la identidad: sku→modelId,
// supplier/proveedor→supplierId. El resto de las claves (mejor, brecha_con_alternativa,
// un_solo_proveedor, subio_vs_semana_pasada, sugerencias) se conserva textual.

import { mondayStart } from "./pricing";

export type Tier = { min: number; price: number };
/** modelId → supplierId → precio base */
export type PriceMatrix = Record<string, Record<string, number>>;
/** modelId → supplierId → escala por cantidad */
export type TierMatrix = Record<string, Record<string, Tier[]>>;
/** modelId → precio de Lista */
export type ListaMap = Record<string, number>;

export type Snapshot = {
  week: number; // mondayStart() del ciclo
  ts: number;
  prices: PriceMatrix;
  lista: ListaMap;
};

// Un snapshot por semana (lunes del ciclo). Guardar de nuevo en la misma semana pisa el
// anterior → queda "el último precio de la semana". Mantiene ~2 años (104 semanas).
export function upsertWeekly(snaps: readonly Snapshot[], prices: PriceMatrix, lista: ListaMap): Snapshot[] {
  const week = mondayStart();
  const entry: Snapshot = {
    week,
    ts: Date.now(),
    prices: JSON.parse(JSON.stringify(prices)) as PriceMatrix,
    lista: JSON.parse(JSON.stringify(lista)) as ListaMap,
  };
  const i = snaps.findIndex((sn) => sn.week === week);
  const next = i >= 0 ? snaps.map((sn, k) => (k === i ? entry : sn)) : [...snaps, entry];
  return next.slice(-104);
}

// costo del proveedor para una cantidad, usando la escala (tier) si existe; si no, el precio base
export function costForQty(
  prices: PriceMatrix,
  tiers: TierMatrix,
  modelId: string,
  supplierId: string,
  qty = 1,
): number {
  const t = tiers[modelId]?.[supplierId];
  if (Array.isArray(t) && t.length) {
    const sorted = [...t].sort((a, b) => a.min - b.min);
    let p = sorted[0]!.price;
    for (const x of sorted) if (qty >= x.min) p = x.price;
    return p;
  }
  return prices[modelId]?.[supplierId] ?? 0;
}

export function hasTiers(tiers: TierMatrix, modelId: string, supplierId: string): boolean {
  const t = tiers[modelId]?.[supplierId];
  return Array.isArray(t) && t.length > 1;
}

export type SupplierRankingEntry = {
  supplierId: string;
  cost: number;
  base: number | undefined;
  escala: boolean;
};

export type BestSuppliersEnv = {
  prices: PriceMatrix;
  tiers: TierMatrix;
  prevSnap?: Snapshot | null;
  supplierList: readonly string[];
};

export type BestSuppliers = {
  modelId: string;
  qty: number;
  ranking: SupplierRankingEntry[];
  mejor: { supplierId: string; costo: number } | null;
  brecha_con_alternativa: number | null;
  un_solo_proveedor: boolean;
  subio_vs_semana_pasada: boolean;
};

// ranking de proveedores por costo para una cantidad (respeta tiers)
export function bestSuppliers(env: BestSuppliersEnv, modelId: string, qty = 1): BestSuppliers {
  const row = env.prices[modelId] ?? {};
  const list: SupplierRankingEntry[] = Object.keys(row)
    .map((supplierId) => ({
      supplierId,
      cost: costForQty(env.prices, env.tiers, modelId, supplierId, qty),
      base: row[supplierId],
      escala: hasTiers(env.tiers, modelId, supplierId),
    }))
    .filter((x) => typeof x.cost === "number")
    .sort((a, b) => a.cost - b.cost);
  const prev = env.prevSnap;
  const prevVals = prev
    ? env.supplierList
        .map((sp) => prev.prices?.[modelId]?.[sp])
        .filter((x): x is number => typeof x === "number")
    : [];
  const prevMin = prevVals.length ? Math.min(...prevVals) : null;
  const top = list[0];
  const second = list[1];
  return {
    modelId,
    qty,
    ranking: list,
    mejor: top ? { supplierId: top.supplierId, costo: top.cost } : null,
    brecha_con_alternativa: top && second ? +(second.cost - top.cost).toFixed(2) : null,
    un_solo_proveedor: list.length === 1,
    subio_vs_semana_pasada: top && prevMin != null ? top.cost > prevMin : false,
  };
}

export type NegotiationEnv = BestSuppliersEnv & {
  catalog: readonly { id: string }[];
  orderItems: readonly { modelId: string; qty?: number | null }[];
};

export type NegotiationSuggestion = {
  modelId: string;
  supplierId: string;
  costo: number;
  flags: string[];
};

// dónde conviene negociar: proveedor sin competencia, precio que subió, o brecha con la alternativa
export function negotiationReport(
  env: NegotiationEnv,
  scope: "order" | "all" = "order",
): { scope: "order" | "all"; sugerencias: NegotiationSuggestion[] } {
  const modelIds =
    scope === "all" ? env.catalog.map((c) => c.id) : [...new Set(env.orderItems.map((i) => i.modelId))];
  const out: NegotiationSuggestion[] = [];
  for (const modelId of modelIds) {
    const qty = env.orderItems.find((i) => i.modelId === modelId)?.qty || 1;
    const bs = bestSuppliers(env, modelId, qty);
    if (!bs.mejor) continue;
    const flags: string[] = [];
    if (bs.un_solo_proveedor) flags.push("sin competencia (un solo proveedor)");
    if (bs.subio_vs_semana_pasada) flags.push("subió vs la semana pasada");
    if (bs.brecha_con_alternativa != null && bs.brecha_con_alternativa > 0.005)
      flags.push(`la alternativa está $${bs.brecha_con_alternativa} más cara`);
    if (flags.length) out.push({ modelId, supplierId: bs.mejor.supplierId, costo: bs.mejor.costo, flags });
  }
  return { scope, sugerencias: out };
}

// ---- Cotizador (sourcing planner) ----
// Un proveedor "tiene" un modelo si tiene CUALQUIER precio conocido (fresco o vencido),
// porque el lunes está todo vencido y aun así hay que saber a quién pedirle.
// `needed` es un mapa { modelId: qty }. Los precios vienen de la matriz completa.

function suppliersWithPrice(modelId: string, prices: PriceMatrix): [string, number][] {
  // TODOS los proveedores con precio para el modelo (no una lista fija).
  return Object.entries(prices[modelId] ?? {}).filter(
    (e): e is [string, number] => typeof e[1] === "number",
  );
}

export type PlanLine = { modelId: string; qty: number; price: number };
export type SourcingPlan = {
  bySupplier: Record<string, PlanLine[]>;
  total: number;
  suppliers: string[];
  uncoverable: string[];
};

// Plan A: cada modelo va a su proveedor conocido globalmente más barato. Costo mínimo,
// posiblemente muchos proveedores.
export function planBestPrice(needed: Record<string, number>, prices: PriceMatrix): SourcingPlan {
  const bySupplier: Record<string, PlanLine[]> = {};
  let total = 0;
  const uncoverable: string[] = [];
  for (const modelId of Object.keys(needed)) {
    const qty = needed[modelId] || 1;
    const cands = suppliersWithPrice(modelId, prices).sort((a, b) => a[1] - b[1]);
    const first = cands[0];
    if (!first) {
      uncoverable.push(modelId);
      continue;
    }
    const [supplierId, price] = first;
    (bySupplier[supplierId] ??= []).push({ modelId, qty, price });
    total += qty * price;
  }
  return { bySupplier, total, suppliers: Object.keys(bySupplier), uncoverable };
}

// Plan B: la MENOR cantidad de proveedores a CONTACTAR que cubra todos los modelos cubribles;
// desempate por menor costo total. Exacto vía fuerza bruta sobre subconjuntos (2^N, acotado).
export function planMinSuppliers(needed: Record<string, number>, prices: PriceMatrix): SourcingPlan {
  const modelIds = Object.keys(needed);
  const uncoverable = modelIds.filter((m) => suppliersWithPrice(m, prices).length === 0);
  const coverable = modelIds.filter((m) => !uncoverable.includes(m));

  // proveedores RELEVANTES: los que tienen precio para algún modelo pedido.
  const relevant = [...new Set(coverable.flatMap((m) => suppliersWithPrice(m, prices).map(([sp]) => sp)))];
  // fuerza bruta acotada (2^N): si hay demasiados proveedores, caemos al plan por mejor precio.
  if (relevant.length > 16) {
    const bp = planBestPrice(needed, prices);
    return { bySupplier: bp.bySupplier, total: bp.total, suppliers: bp.suppliers, uncoverable };
  }

  let best: { bySupplier: Record<string, PlanLine[]>; total: number; used: number } | null = null;
  for (let mask = 1; mask < 1 << relevant.length; mask++) {
    const subset = relevant.filter((_, i) => mask & (1 << i));
    const covers = coverable.every((m) => subset.some((sp) => typeof prices[m]?.[sp] === "number"));
    if (!covers) continue;
    const bySupplier: Record<string, PlanLine[]> = {};
    let total = 0;
    for (const m of coverable) {
      const qty = needed[m] || 1;
      const cheapest = subset
        .map((sp) => [sp, prices[m]?.[sp]] as const)
        .filter((e): e is readonly [string, number] => typeof e[1] === "number")
        .sort((a, b) => a[1] - b[1])[0]!;
      const [supplierId, price] = cheapest;
      (bySupplier[supplierId] ??= []).push({ modelId: m, qty, price });
      total += qty * price;
    }
    const used = Object.keys(bySupplier).length; // proveedores realmente contactados
    if (!best || used < best.used || (used === best.used && total < best.total))
      best = { bySupplier, total, used };
  }
  if (!best) return { bySupplier: {}, total: 0, suppliers: [], uncoverable };
  return { bySupplier: best.bySupplier, total: best.total, suppliers: Object.keys(best.bySupplier), uncoverable };
}

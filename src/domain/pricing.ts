// Agregados de precio por fila + frescura semanal. Portado 1:1 de price-logic.js
// (misma matemática, validada en producción por seed-validation → test/pricing.golden.test.ts).
// Firmas por ID: las claves de los mapas son supplierId (el viejo usaba el nombre).

export function median(nums: readonly number[]): number | null {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

export type RowAggregates = {
  count: number;
  min: number | null;
  med: number | null;
  /** supplierIds cuyo precio es un dump-outlier (< mediana × (1 − umbral)) */
  outliers: Set<string>;
  bestIsOutlier: boolean;
  base: number | null;
  client: number | null;
};

// Precio a cliente consciente de outliers. base = mediana cuando el más barato es un dump
// (> umbral bajo la mediana, stock en exceso), si no el más barato.
// client = round(base * (1 + margen%)).
export function rowAggregates(
  pricesForModel: Record<string, unknown> | null | undefined,
  marginPct: number,
  outlierThreshold = 0.15,
): RowAggregates {
  // considerar TODOS los proveedores presentes en el mapa (no una lista fija) — igual que
  // el viejo tras el fix de proveedores nuevos (iPhone).
  const present = Object.entries(pricesForModel ?? {}).filter(
    (e): e is [string, number] => typeof e[1] === "number",
  );
  if (!present.length)
    return { count: 0, min: null, med: null, outliers: new Set(), bestIsOutlier: false, base: null, client: null };
  const vals = present.map(([, v]) => v);
  const min = Math.min(...vals);
  const med = median(vals)!;
  const outliers = new Set<string>();
  for (const [supplierId, v] of present) if (v < med * (1 - outlierThreshold)) outliers.add(supplierId);
  const bestIsOutlier = min < med * (1 - outlierThreshold);
  const base = bestIsOutlier ? med : min;
  const client = base == null ? null : Math.round(base * (1 + marginPct / 100));
  return { count: vals.length, min, med, outliers, bestIsOutlier, base, client };
}

// ---- frescura semanal (los precios vencen cada lunes 00:00 local) ----
export const RECENT_MS = 24 * 60 * 60 * 1000; // ventana "recién actualizado"

// Comienzo (ms) del ciclo lunes→domingo para un instante dado.
export function mondayStart(date: Date = new Date()): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=dom, 1=lun, … 6=sáb
  const sinceMonday = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - sinceMonday);
  return d.getTime();
}

export type Freshness = "expired" | "updated" | "recent";

// "expired" | "updated" | "recent". Timestamp faltante cuenta como expirado
// (edad desconocida → hay que repedir). El corte de ciclo se chequea antes que la recencia.
export function classifyFreshness(
  ts: number | null | undefined,
  now: number = Date.now(),
  recentMs: number = RECENT_MS,
): Freshness {
  if (ts == null) return "expired";
  if (ts < mondayStart(new Date(now))) return "expired";
  if (ts >= now - recentMs) return "recent";
  return "updated";
}

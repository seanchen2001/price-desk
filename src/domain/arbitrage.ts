// Detección de arbitrajes: modelos donde un proveedor está MUY por debajo de la mediana
// del resto. Distingue oportunidad real de precio viejo/desactualizado. SOLO AVISA: no
// estima montos ni arma órdenes. Portado de lib/arbitrage.js — misma matemática, por ID
// (model_id / supplier_id; la frescura sale del updated_at de la fila de `prices`).
import { classifyFreshness } from "./pricing";

export type ArbitragePrice = { supplierId: string; price: number; ts: number | null };
export type ArbitrageInputRow = { modelId: string; prices: readonly ArbitragePrice[] };

export type ArbitrageHit = {
  modelId: string;
  lowSupplierId: string;
  lowPrice: number;
  median: number;
  gapPct: number;
  stale: boolean;
  nota: string;
};

/** Devuelve hits ordenados por gap descendente. gapPct mínimo configurable (default 3%). */
export function arbitrageScan(
  rows: readonly ArbitrageInputRow[],
  { gapPct = 3, now = Date.now() }: { gapPct?: number; now?: number } = {},
): ArbitrageHit[] {
  const out: ArbitrageHit[] = [];
  for (const row of rows) {
    const entries = row.prices.filter((p) => typeof p.price === "number" && p.price > 0);
    if (entries.length < 2) continue; // sin comparación no hay arbitraje
    const sorted = entries.map((p) => p.price).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const low = entries.slice().sort((a, b) => a.price - b.price)[0]!;
    const gap = median ? +(((median - low.price) / median) * 100).toFixed(1) : 0;
    if (gap < gapPct) continue;
    const stale = classifyFreshness(low.ts, now) === "expired";
    out.push({
      modelId: row.modelId,
      lowSupplierId: low.supplierId,
      lowPrice: low.price,
      median,
      gapPct: gap,
      stale,
      nota: stale
        ? "posiblemente desactualizado — verificar con el proveedor antes de comprar"
        : "gap real vs. mediana — oportunidad",
    });
  }
  return out.sort((a, b) => b.gapPct - a.gapPct);
}

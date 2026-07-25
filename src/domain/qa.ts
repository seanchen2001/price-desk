// QA de precios (P4) — detección 100% DETERMINÍSTICA y PURA (el LLM no detecta: solo
// triagea y redacta). Cada hallazgo sale con severidad y, cuando hay un arreglo seguro
// y computable, un suggestedFix como TOOL CALL que rutea por el executor GATEADO
// (o sea: el fix también pasa por applyGate + política — nunca escribe directo).
import { normalize } from "./normalize";
import { classifyFreshness, median } from "./pricing";

export type QaSnapshot = {
  now?: number;
  models: Array<{
    id: string;
    canonical_name: string;
    category_id: string | null;
    department_id: string | null;
  }>;
  categories: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string; active: boolean }>;
  prices: Array<{ model_id: string; supplier_id: string; price: number; updated_at: string }>;
  tiers: Array<{ model_id: string; supplier_id: string; min_qty: number; price: number }>;
  sales: Array<{ model_id: string; price: number }>;
  aliases: Array<{ alias_key: string; model_id: string }>;
};

export type QaSeverity = "critico" | "alto" | "medio" | "bajo";

export type QaTipo =
  | "stale"
  | "inverted_ladder"
  | "unit_outlier"
  | "supplier_off_median"
  | "missing_lista"
  | "lista_below_cost"
  | "sin_categoria"
  | "duplicado_sospechoso"
  | "alias_huerfano";

export type QaFinding = {
  /** determinístico: `${tipo}:${modelId|supplierId}[:supplierId]` */
  id: string;
  tipo: QaTipo;
  severidad: QaSeverity;
  modelo?: string;
  proveedor?: string;
  detalle: string;
  suggestedFix?: { tool: string; args: Record<string, unknown> };
};

const SEV_ORDER: Record<QaSeverity, number> = { critico: 0, alto: 1, medio: 2, bajo: 3 };

/** margen default para las Listas sugeridas (mismo 3% de la Mesa) */
const LISTA_MARGIN = 1.03;

/** misma banda 10×/100× de checkQuoteEntry: devuelve el factor si el ratio cae en banda */
function unitFactor(ratio: number): { factor: number; direction: "x" | "div" } | null {
  for (const f of [10, 100]) {
    if (ratio >= f * 0.8 && ratio <= f * 1.25) return { factor: f, direction: "x" };
    if (ratio >= 0.8 / f && ratio <= 1.25 / f) return { factor: f, direction: "div" };
  }
  return null;
}

export function runQa(snap: QaSnapshot): QaFinding[] {
  const now = snap.now ?? Date.now();
  const findings: QaFinding[] = [];
  const modelById = new Map(snap.models.map((m) => [m.id, m]));
  const supplierById = new Map(snap.suppliers.map((s) => [s.id, s]));
  const nameOf = (modelId: string): string => modelById.get(modelId)?.canonical_name ?? modelId;
  const supOf = (supplierId: string): string => supplierById.get(supplierId)?.name ?? supplierId;

  const pricesByModel = new Map<string, QaSnapshot["prices"]>();
  for (const p of snap.prices) {
    if (!modelById.has(p.model_id)) continue; // filas de modelos borrados no son QA de mesa
    const arr = pricesByModel.get(p.model_id);
    if (arr) arr.push(p);
    else pricesByModel.set(p.model_id, [p]);
  }
  const fresh = (p: { updated_at: string }): boolean =>
    classifyFreshness(Date.parse(p.updated_at), now) !== "expired";

  // ---------- stale (agregado POR PROVEEDOR: accionable = "recotizar a X") ----------
  const staleBySupplier = new Map<string, number>();
  for (const p of snap.prices) {
    if (!modelById.has(p.model_id)) continue;
    if (!fresh(p)) staleBySupplier.set(p.supplier_id, (staleBySupplier.get(p.supplier_id) ?? 0) + 1);
  }
  for (const [supplierId, count] of staleBySupplier) {
    findings.push({
      id: `stale:${supplierId}`,
      tipo: "stale",
      severidad: "bajo",
      proveedor: supOf(supplierId),
      detalle: `${count} precio(s) vencido(s) (ciclo lunes) — recotizar a ${supOf(supplierId)}`,
    });
  }

  // ---------- escalera invertida en tiers GUARDADOS ----------
  const tiersByPair = new Map<string, QaSnapshot["tiers"]>();
  for (const t of snap.tiers) {
    if (!modelById.has(t.model_id)) continue;
    const key = `${t.model_id}:${t.supplier_id}`;
    const arr = tiersByPair.get(key);
    if (arr) arr.push(t);
    else tiersByPair.set(key, [t]);
  }
  for (const [key, arr] of tiersByPair) {
    const sorted = [...arr].sort((a, b) => a.min_qty - b.min_qty);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.price > sorted[i - 1]!.price) {
        const [modelId, supplierId] = key.split(":") as [string, string];
        findings.push({
          id: `inverted_ladder:${modelId}:${supplierId}`,
          tipo: "inverted_ladder",
          severidad: "alto",
          modelo: nameOf(modelId),
          proveedor: supOf(supplierId),
          detalle: `escalera invertida: ${sorted[i]!.min_qty}+ ($${sorted[i]!.price}) más caro que ${sorted[i - 1]!.min_qty}+ ($${sorted[i - 1]!.price}) — verificar con el proveedor`,
        });
        break;
      }
    }
  }

  // ---------- unit_outlier / supplier_off_median (vs la mediana de los OTROS) ----------
  // DOS pasadas: primero los errores de unidad; después off_median EXCLUYENDO los
  // unit-outliers del set "otros" (un 10× envenenaría la mediana y flaggearía a los sanos).
  const unitOutlierPair = new Set<string>();
  for (const [modelId, rows] of pricesByModel) {
    if (rows.length < 2) continue;
    for (const p of rows) {
      const others = rows.filter((o) => o.supplier_id !== p.supplier_id);
      const medOthers = median(others.map((o) => o.price));
      if (medOthers === null || medOthers === 0) continue;
      const unit = unitFactor(p.price / medOthers);
      if (!unit) continue;
      unitOutlierPair.add(`${modelId}:${p.supplier_id}`);
      const corregido =
        unit.direction === "x"
          ? Math.round((p.price / unit.factor) * 100) / 100
          : Math.round(p.price * unit.factor * 100) / 100;
      findings.push({
        id: `unit_outlier:${modelId}:${p.supplier_id}`,
        tipo: "unit_outlier",
        severidad: "critico",
        modelo: nameOf(modelId),
        proveedor: supOf(p.supplier_id),
        detalle: `$${p.price} parece error de unidad (~${unit.direction === "x" ? `${unit.factor}×` : `1/${unit.factor}`} de la mediana $${medOthers} del resto) — ¿era $${corregido}?`,
        suggestedFix: {
          tool: "set_price",
          args: { model: nameOf(modelId), supplier: supOf(p.supplier_id), price: corregido },
        },
      });
    }
  }
  for (const [modelId, rows] of pricesByModel) {
    if (rows.length < 2) continue;
    const sane = rows.filter((r) => !unitOutlierPair.has(`${modelId}:${r.supplier_id}`));
    for (const p of sane) {
      const others = sane.filter((o) => o.supplier_id !== p.supplier_id);
      const freshOthers = others.filter(fresh);
      const medOthers = median(others.map((o) => o.price));
      if (medOthers === null || medOthers === 0) continue;
      const offPct = Math.abs(((p.price - medOthers) / medOthers) * 100);
      if (offPct > 30 && freshOthers.length > 0) {
        findings.push({
          id: `supplier_off_median:${modelId}:${p.supplier_id}`,
          tipo: "supplier_off_median",
          severidad: fresh(p) ? "alto" : "medio",
          modelo: nameOf(modelId),
          proveedor: supOf(p.supplier_id),
          detalle: `$${p.price} está ${offPct.toFixed(0)}% ${p.price > medOthers ? "ARRIBA" : "ABAJO"} de la mediana $${medOthers} del resto (competencia fresca) — ${fresh(p) ? "verificar antes de operar" : "precio viejo: recotizar"}`,
        });
      }
    }
  }

  // ---------- Lista: faltante / debajo del costo ----------
  const saleByModel = new Map(snap.sales.map((s) => [s.model_id, s.price]));
  for (const [modelId, rows] of pricesByModel) {
    const min = Math.min(...rows.map((r) => r.price));
    const lista = saleByModel.get(modelId);
    if (lista === undefined) {
      const sugerida = Math.round(min * LISTA_MARGIN);
      findings.push({
        id: `missing_lista:${modelId}`,
        tipo: "missing_lista",
        severidad: "bajo",
        modelo: nameOf(modelId),
        detalle: `sin Lista manual (usa la automática Mín+margen) — si querés congelarla: $${sugerida}`,
        suggestedFix: { tool: "set_sale_price", args: { model: nameOf(modelId), price: sugerida } },
      });
    } else if (lista < min) {
      const sugerida = Math.ceil(min * LISTA_MARGIN);
      findings.push({
        id: `lista_below_cost:${modelId}`,
        tipo: "lista_below_cost",
        severidad: "critico",
        modelo: nameOf(modelId),
        detalle: `Lista $${lista} DEBAJO del mejor costo actual $${min} (vender pierde plata) — sugerida $${sugerida}`,
        suggestedFix: { tool: "set_sale_price", args: { model: nameOf(modelId), price: sugerida } },
      });
    }
  }

  // ---------- higiene ----------
  for (const m of snap.models) {
    if (m.category_id === null) {
      findings.push({
        id: `sin_categoria:${m.id}`,
        tipo: "sin_categoria",
        severidad: "bajo",
        modelo: m.canonical_name,
        detalle: "sin categoría (cae en 'Otros' de la grilla) — mover con move_model_category",
      });
    }
  }
  // duplicados sospechosos: clave laxa (normalize + sin tokens de formato)
  const looseKey = (name: string): string =>
    normalize(name).replace(/(ds|5g|4g|lte|gb)/g, "");
  const byLoose = new Map<string, string[]>();
  for (const m of snap.models) {
    const k = looseKey(m.canonical_name);
    if (!k) continue;
    const arr = byLoose.get(k);
    if (arr) arr.push(m.canonical_name);
    else byLoose.set(k, [m.canonical_name]);
  }
  for (const [k, names] of byLoose) {
    if (names.length > 1) {
      findings.push({
        id: `duplicado_sospechoso:${k}`,
        tipo: "duplicado_sospechoso",
        severidad: "medio",
        detalle: `posibles duplicados del mismo equipo: ${names.join(" ↔ ")} — si son el mismo, unificar (decisión humana)`,
      });
    }
  }
  const modelIds = new Set(snap.models.map((m) => m.id));
  for (const a of snap.aliases) {
    if (!modelIds.has(a.model_id)) {
      findings.push({
        id: `alias_huerfano:${a.alias_key}`,
        tipo: "alias_huerfano",
        severidad: "bajo",
        detalle: `alias "${a.alias_key}" apunta a un modelo inexistente/borrado — limpieza manual`,
      });
    }
  }

  return findings.sort(
    (a, b) => SEV_ORDER[a.severidad] - SEV_ORDER[b.severidad] || a.id.localeCompare(b.id),
  );
}

/** resumen determinístico (fallback si el triage LLM falla y base del reporte). */
export function qaCounts(findings: readonly QaFinding[]): {
  total: number;
  por_severidad: Record<QaSeverity, number>;
  por_tipo: Partial<Record<QaTipo, number>>;
} {
  const por_severidad: Record<QaSeverity, number> = { critico: 0, alto: 0, medio: 0, bajo: 0 };
  const por_tipo: Partial<Record<QaTipo, number>> = {};
  for (const f of findings) {
    por_severidad[f.severidad] += 1;
    por_tipo[f.tipo] = (por_tipo[f.tipo] ?? 0) + 1;
  }
  return { total: findings.length, por_severidad, por_tipo };
}

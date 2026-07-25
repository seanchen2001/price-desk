// Matemática del NEGOCIADOR — pura y testeable (la IA solo conversa; esto decide):
//  - analyzeOffer: una oferta vs la Mesa (mín/mediana/precio propio anterior + frescura)
//    → 🟢 oportunidad · 🟡 en línea (± banda) · 🔴 caro · sin_referencia.
//  - counterOfferText: contraoferta determinística para las líneas 🔴 (matchear nuestro
//    mín o mín−1); las 🟢 no se mencionan (no despertar al proveedor).
//  - discountPlan: lado cliente — dónde CONCEDER (margen gordo) y dónde SOSTENER
//    (margen fino), con piso de margen e impacto total.
// El staging de negociación (StagedNegotiation) también vive acá como TIPO: lo persisten
// el store de la Mesa y lo opera el executor del agente.
import { classifyFreshness, median, type Freshness } from "./pricing";
import type { QuoteTier } from "./quoteParser";

/** banda "en línea": ± este % alrededor de nuestro Mín actual */
export const NEGOTIATION_BAND_PCT = 1.5;

export type OfferClass = "oportunidad" | "en_linea" | "caro" | "sin_referencia";

export type PriceRef = { supplierId: string; price: number; updatedAtMs: number };

export type OfferAnalysis = {
  clasificacion: OfferClass;
  /** nuestro mejor precio actual del modelo (todos los proveedores) */
  min: { price: number; supplierId: string; fresh: Freshness } | null;
  mediana: number | null;
  /** + = la oferta está ARRIBA del mín (cara); − = mejora nuestro mín */
  vs_min_pct: number | null;
  /** precio anterior de ESTE proveedor para el modelo */
  prev_propio: { price: number; fresh: Freshness; delta_pct: number } | null;
};

const pct = (from: number, to: number): number => +(((to - from) / from) * 100).toFixed(1);

export function analyzeOffer(
  offerPrice: number,
  supplierId: string,
  refs: readonly PriceRef[],
  now: number = Date.now(),
  bandPct: number = NEGOTIATION_BAND_PCT,
): OfferAnalysis {
  const prevOwn = refs.find((r) => r.supplierId === supplierId) ?? null;
  const prev_propio = prevOwn
    ? {
        price: prevOwn.price,
        fresh: classifyFreshness(prevOwn.updatedAtMs, now),
        delta_pct: pct(prevOwn.price, offerPrice),
      }
    : null;
  if (refs.length === 0) {
    return { clasificacion: "sin_referencia", min: null, mediana: null, vs_min_pct: null, prev_propio };
  }
  let minRef = refs[0]!;
  for (const r of refs) if (r.price < minRef.price) minRef = r;
  const med = median(refs.map((r) => r.price));
  const vsMin = pct(minRef.price, offerPrice);
  const clasificacion: OfferClass =
    vsMin < -bandPct ? "oportunidad" : vsMin > bandPct ? "caro" : "en_linea";
  return {
    clasificacion,
    min: {
      price: minRef.price,
      supplierId: minRef.supplierId,
      fresh: classifyFreshness(minRef.updatedAtMs, now),
    },
    mediana: med,
    vs_min_pct: vsMin,
    prev_propio,
  };
}

// ---------- staging (la mesa de negociación) ----------

export type StagedFlag = { motivo: string; sugerencia?: number };

export type StagedLine = {
  aliasKey: string;
  rawName: string;
  modelId: string;
  modelName: string;
  categoryName: string | null;
  price: number;
  tiers: QuoteTier[];
  analysis: OfferAnalysis;
  /** sanity-flags (unidad, escalera invertida, delta par) — informativos */
  flags: StagedFlag[];
};

export type StagedNegotiation = {
  supplierId: string;
  supplierName: string;
  ts: number;
  lines: StagedLine[];
};

export const CLASS_EMOJI: Record<OfferClass, string> = {
  oportunidad: "🟢",
  en_linea: "🟡",
  caro: "🔴",
  sin_referencia: "◽",
};

/** resumen del negociador: cuántas 🟢/🟡/🔴 y la frase de acción. */
export function negotiationSummary(lines: readonly StagedLine[]): {
  oportunidades: number;
  en_linea: number;
  caras: number;
  sin_referencia: number;
  frase: string;
} {
  const count = (c: OfferClass) => lines.filter((l) => l.analysis.clasificacion === c).length;
  const oportunidades = count("oportunidad");
  const caras = count("caro");
  const parts: string[] = [];
  if (oportunidades) parts.push(`${oportunidades} oportunidad(es) — aplicalas (apply_lines)`);
  if (caras) parts.push(`${caras} cara(s) — hay margen para pedir mejora (counter_offer)`);
  if (!parts.length) parts.push("todo en línea con la Mesa");
  return {
    oportunidades,
    en_linea: count("en_linea"),
    caras,
    sin_referencia: count("sin_referencia"),
    frase: parts.join(" · "),
  };
}

// ---------- selección (apply/discard por chat) ----------

export type LineSelector = {
  /** nombres/fragmentos de modelo (ci) */
  models?: readonly string[];
  category?: string;
  classification?: OfferClass;
  /** true = todas (combinable con except) */
  all?: boolean;
  /** nombres/fragmentos a excluir */
  except?: readonly string[];
};

export function selectLines(
  lines: readonly StagedLine[],
  sel: LineSelector,
): { selected: StagedLine[]; rest: StagedLine[] } {
  const ci = (s: string) => s.trim().toLowerCase();
  const matchesName = (l: StagedLine, needles: readonly string[]) =>
    needles.some(
      (n) =>
        ci(l.modelName).includes(ci(n)) ||
        ci(l.rawName).includes(ci(n)) ||
        l.aliasKey === ci(n).replace(/[^a-z0-9]/g, ""),
    );
  const base = lines.filter((l) => {
    if (sel.models && sel.models.length > 0) return matchesName(l, sel.models);
    if (sel.category !== undefined && sel.category !== "")
      return ci(l.categoryName ?? "") === ci(sel.category) || ci(l.categoryName ?? "").includes(ci(sel.category));
    if (sel.classification !== undefined) return l.analysis.clasificacion === sel.classification;
    return sel.all === true;
  });
  const selected = sel.except && sel.except.length > 0
    ? base.filter((l) => !matchesName(l, sel.except!))
    : base;
  const chosen = new Set(selected.map((l) => l.aliasKey));
  return { selected, rest: lines.filter((l) => !chosen.has(l.aliasKey)) };
}

// ---------- contraoferta (proveedor) ----------

export type CounterMode = "match" | "undercut";

export type CounterLine = {
  modelo: string;
  ofrecido: number;
  nuestro_min: number;
  min_de: string;
  objetivo: number;
};

/**
 * Contraoferta determinística: SOLO líneas 🔴 (las 🟢 no se mencionan). objetivo =
 * nuestro mín ("match") o mín−1 ("undercut"). minSupplierName resuelve nombres para
 * el texto ("lo tengo a $X con Y").
 */
export function counterOffer(
  neg: StagedNegotiation,
  minSupplierName: (supplierId: string) => string,
  mode: CounterMode = "match",
): { lineas: CounterLine[]; texto_whatsapp: string } {
  const lineas: CounterLine[] = [];
  for (const l of neg.lines) {
    if (l.analysis.clasificacion !== "caro" || l.analysis.min === null) continue;
    const objetivo = mode === "undercut" ? l.analysis.min.price - 1 : l.analysis.min.price;
    lineas.push({
      modelo: l.modelName,
      ofrecido: l.price,
      nuestro_min: l.analysis.min.price,
      min_de: minSupplierName(l.analysis.min.supplierId),
      objetivo,
    });
  }
  const texto =
    lineas.length === 0
      ? ""
      : [
          `Hola ${neg.supplierName}, revisé tu lista. Estos los estoy consiguiendo mejor — ¿los mejorás?`,
          ...lineas.map(
            (c) => `${c.modelo}\tme pasaste $${c.ofrecido} · lo tengo a $${c.nuestro_min} → te cierro a $${c.objetivo}`,
          ),
          `Si me los dejás ahí, te confirmo hoy.`,
        ].join("\n");
  return { lineas, texto_whatsapp: texto };
}

// ---------- plan de descuento (cliente) ----------

export type DiscountInput = {
  modelId: string;
  modelName: string;
  qty: number;
  /** costo REAL a esa cantidad (costForQty: respeta escalas) */
  cost: number;
  /** precio de Lista al cliente */
  lista: number;
};

export type DiscountLine = DiscountInput & {
  margen_pct: number;
  precio_final: number;
  margen_final_pct: number;
  sugerencia: "conceder" | "sostener";
};

export type DiscountPlan = {
  lineas: DiscountLine[];
  totales: {
    venta_lista: number;
    venta_final: number;
    costo: number;
    margen_lista: number;
    margen_final: number;
    descuento_pct: number;
  };
};

/**
 * Dónde conceder: primero las líneas con MÁS margen, sin perforar el piso (floorPct).
 * targetPct (opcional) = descuento total que pide el cliente sobre la venta de Lista;
 * sin target, concede hasta el piso solo en las líneas gordas (margen > floor + banda).
 */
export function discountPlan(
  items: readonly DiscountInput[],
  opts: { targetPct?: number; floorPct?: number } = {},
): DiscountPlan {
  const floor = opts.floorPct ?? 1;
  const enriched = items.map((it) => ({
    ...it,
    margen_pct: it.lista > 0 ? +(((it.lista - it.cost) / it.lista) * 100).toFixed(1) : 0,
  }));
  const ventaLista = enriched.reduce((a, it) => a + it.lista * it.qty, 0);
  const costoTotal = enriched.reduce((a, it) => a + it.cost * it.qty, 0);
  // precio mínimo por línea que respeta el piso de margen: lista_min = cost/(1 - floor%)
  const minPrice = (it: (typeof enriched)[number]) =>
    Math.ceil(it.cost / (1 - floor / 100));

  const finals = new Map<string, number>(enriched.map((it) => [it.modelId, it.lista]));
  if (opts.targetPct !== undefined && opts.targetPct > 0 && ventaLista > 0) {
    let restante = (ventaLista * opts.targetPct) / 100;
    // conceder primero donde el margen es más gordo
    for (const it of [...enriched].sort((a, b) => b.margen_pct - a.margen_pct)) {
      if (restante <= 0) break;
      const piso = minPrice(it);
      const reducible = Math.max(0, (it.lista - piso) * it.qty);
      if (reducible <= 0) continue;
      const usar = Math.min(reducible, restante);
      const nuevo = it.lista - usar / it.qty;
      finals.set(it.modelId, Math.round(nuevo));
      restante -= (it.lista - Math.round(nuevo)) * it.qty;
    }
  } else {
    // sin target: proponer concesión hasta el piso SOLO donde el margen es gordo
    for (const it of enriched) {
      if (it.margen_pct > floor + NEGOTIATION_BAND_PCT) {
        finals.set(it.modelId, Math.max(minPrice(it), Math.round(it.cost * (1 + (floor + 1) / 100))));
      }
    }
  }

  const lineas: DiscountLine[] = enriched.map((it) => {
    const precioFinal = finals.get(it.modelId) ?? it.lista;
    const margenFinal = precioFinal > 0 ? +(((precioFinal - it.cost) / precioFinal) * 100).toFixed(1) : 0;
    return {
      ...it,
      precio_final: precioFinal,
      margen_final_pct: margenFinal,
      sugerencia: precioFinal < it.lista ? "conceder" : "sostener",
    };
  });
  const ventaFinal = lineas.reduce((a, l) => a + l.precio_final * l.qty, 0);
  return {
    lineas,
    totales: {
      venta_lista: ventaLista,
      venta_final: ventaFinal,
      costo: costoTotal,
      margen_lista: ventaLista - costoTotal,
      margen_final: ventaFinal - costoTotal,
      descuento_pct: ventaLista > 0 ? +(((ventaLista - ventaFinal) / ventaLista) * 100).toFixed(1) : 0,
    },
  };
}

// ---------- memoria del negociador ([[about]] embebido en rule_text) ----------

/** "planET afloja…" + about "planET" → "[[planet]] planET afloja…" (encode determinístico). */
export function encodeNote(note: string, about?: string): string {
  const a = (about ?? "").trim();
  return a ? `[[${a.toLowerCase()}]] ${note.trim()}` : note.trim();
}

export function noteAbout(ruleText: string): string | null {
  const m = /^\[\[([^\]]+)\]\]/.exec(ruleText.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** notas relevantes primero: las del `about` pedido (o que lo mencionan), después el resto. */
export function recallNotes(rules: readonly string[], about?: string): string[] {
  const a = (about ?? "").trim().toLowerCase();
  if (!a) return [...rules];
  const hit = rules.filter(
    (r) => noteAbout(r) === a || r.toLowerCase().includes(a),
  );
  return hit;
}

/** ordena knowledge para el system prompt: notas de partes MENCIONADAS primero. */
export function orderNotesByMention(rules: readonly string[], mentioned: readonly string[]): string[] {
  if (mentioned.length === 0) return [...rules];
  const m = mentioned.map((x) => x.toLowerCase());
  const first: string[] = [];
  const rest: string[] = [];
  for (const r of rules) {
    const low = r.toLowerCase();
    (m.some((x) => low.includes(x)) ? first : rest).push(r);
  }
  return [...first, ...rest];
}

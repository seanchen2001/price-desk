// Extracción de cotizaciones con IA — PROPOSE-ONLY (REBUILD-PLAN "AI parser").
// Gemini SOLO propone [{rawName, supplier, price, tiers[]}]; la identidad la decide
// resolveModel y lo nuevo va SIEMPRE a la cola de confirmación (nunca auto-crea).
// Prompt NUEVO endurecido contra esta spec (el lib/ai.js viejo era referencia de tono,
// no de contrato: aquel pedía mapear a SKUs del catálogo — exactamente lo prohibido acá).
import { normalize } from "../../domain/normalize";
import { qtyFromName, type QuoteEntry, type QuoteTier } from "../../domain/quoteParser";
import { generateText, type FetchLike, type GeminiImage } from "./gemini";

/** Umbral de auto-aplicación (portado del PRICE_AUTO_THRESHOLD viejo, lib/constants.js). */
export const PRICE_AUTO_THRESHOLD = 15; // %

export type ExtractedItem = {
  rawName: string;
  supplier: string;
  price: number;
  tiers: QuoteTier[];
};

// responseSchema (Gemini v1beta): fuerza el contrato a nivel decodificación, no solo prompt.
export const EXTRACTION_RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      rawName: {
        type: "STRING",
        description: "Nombre del producto TAL CUAL aparece en el texto (sin precio/cantidad).",
      },
      supplier: {
        type: "STRING",
        description: "Proveedor SOLO si figura en el texto; si no, cadena vacía.",
      },
      price: { type: "NUMBER", description: "Precio base en USD (number, sin símbolos)." },
      tiers: {
        type: "ARRAY",
        description: "Escalera por cantidad completa; vacío si hay un solo precio.",
        items: {
          type: "OBJECT",
          properties: {
            min_qty: { type: "INTEGER" },
            price: { type: "NUMBER" },
          },
          required: ["min_qty", "price"],
        },
      },
    },
    required: ["rawName", "price"],
  },
} as const;

/** System prompt endurecido — escrito desde cero contra la spec propose-only. */
export function buildExtractionSystem(): string {
  return [
    "Sos el extractor de cotizaciones del Price Desk (mayorista de celulares). Recibís UNA cotización cruda de UN proveedor: texto pegado de WhatsApp o un screenshot, en español desordenado, con cantidades, colores, encabezados, emojis y condiciones.",
    "",
    "Devolvés SOLO un array JSON — un ítem por producto cotizado:",
    '[{ "rawName": string, "supplier": string, "price": number, "tiers": [{ "min_qty": number, "price": number }] }]',
    "",
    "REGLAS ESTRICTAS:",
    "1. rawName = el nombre del producto TAL CUAL aparece en el texto (sacale solo el precio, la cantidad entre paréntesis y las viñetas). NO lo normalices, NO lo traduzcas, NO inventes un nombre canónico, NO completes RAM/almacenamiento/modelo que no estén escritos, NO agregues productos que no aparecen. Otro sistema resuelve la identidad después.",
    '2. ESCALERA DE CANTIDAD: si un mismo producto aparece con varios precios según la cantidad (ej. "(20 pcs) 610" y "(50+ pcs) 595", o "x10 … / x50 …"), devolvé UN SOLO ítem con la escalera completa en tiers: [{min_qty, price}, …] ascendente por min_qty (el precio sin cantidad va como min_qty 1). PROHIBIDO devolver esos escalones como ítems separados.',
    "3. price = el precio BASE del ítem (el de menor cantidad, o sea el más alto de la escalera). Si hay un solo precio, tiers = [].",
    '4. supplier = el nombre del proveedor SOLO si figura en el texto; si no figura, "". No lo adivines.',
    '5. Números: precio en USD como number, sin símbolos ni texto. "1.105,00" y "1,105.00" son 1105.',
    "6. Ignorá las líneas sin precio (saludos, encabezados de sección, condiciones de pago). No las conviertas en productos.",
    "7. Si el color/región está escrito, dejalo dentro de rawName tal cual está. No separes ni dupliques por color por tu cuenta.",
    "",
    "Si no hay ningún producto con precio, devolvé []. Nada de markdown ni comentarios: SOLO el array JSON.",
  ].join("\n");
}

// "1.105,00" (AR) | "1,105.00" (EN) | "610" | número → number, o null si no es un precio sano.
export function toPrice(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  let s = v.replace(/[^0-9.,]/g, "");
  if (!s) return null;
  if (s.includes(".") && s.includes(",")) {
    // ambos separadores: el ÚLTIMO es el decimal (1.105,00 → 1105 ; 1,105.00 → 1105)
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stripFences(t: string): string {
  let s = t.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  return s;
}

function sanitizeTiers(v: unknown): QuoteTier[] {
  if (!Array.isArray(v)) return [];
  const byMin = new Map<number, number>();
  for (const t of v) {
    if (typeof t !== "object" || t === null) continue;
    const rec = t as Record<string, unknown>;
    const price = toPrice(rec["price"]);
    const minRaw = rec["min_qty"] ?? rec["min"];
    const min = typeof minRaw === "number" && Number.isFinite(minRaw) ? Math.max(1, Math.round(minRaw)) : null;
    if (price === null || min === null) continue;
    byMin.set(min, price);
  }
  return [...byMin.entries()]
    .map(([min_qty, price]) => ({ min_qty, price }))
    .sort((a, b) => a.min_qty - b.min_qty);
}

/** Respuesta JSON de Gemini → ítems saneados (tira lo malformado, ruidoso si no es array). */
export function parseExtractionJson(text: string): ExtractedItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    throw new Error(
      "La respuesta de la IA vino cortada o malformada (lista muy larga). Probá con menos modelos o por partes.",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("La IA no devolvió un array de productos (contrato roto).");
  }
  const out: ExtractedItem[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const rawName = typeof rec["rawName"] === "string" ? rec["rawName"].trim() : "";
    const price = toPrice(rec["price"]);
    if (!rawName || price === null) continue;
    out.push({
      rawName,
      supplier: typeof rec["supplier"] === "string" ? rec["supplier"].trim() : "",
      price,
      tiers: sanitizeTiers(rec["tiers"]),
    });
  }
  return out;
}

/**
 * Ítems extraídos → QuoteEntry[] (el MISMO tipo que emite el parser sin IA, así el
 * resto del flujo — planQuote/resolver/cola — es idéntico). Red defensiva: si el modelo
 * desobedece y manda escalones como ítems separados ("(20 pcs)"), acá se PLIEGAN por
 * normalize(rawName) igual que en quoteParser — cantidades JAMÁS crean filas.
 */
export function extractedToQuoteEntries(items: readonly ExtractedItem[]): QuoteEntry[] {
  type Group = { rawNames: string[]; lines: string[]; ladder: Map<number, number> };
  const groups = new Map<string, Group>();
  for (const item of items) {
    const key = normalize(item.rawName);
    if (!key) continue;
    const g: Group =
      groups.get(key) ?? { rawNames: [], lines: [], ladder: new Map<number, number>() };
    if (!groups.has(key)) groups.set(key, g);
    g.rawNames.push(item.rawName);
    g.lines.push(`${item.rawName} — $${item.price}`);
    if (item.tiers.length > 0) {
      for (const t of item.tiers) g.ladder.set(t.min_qty, t.price);
    } else {
      // sin tiers: el precio entra como escalón; "(N pcs)" en el nombre = ese escalón
      g.ladder.set(qtyFromName(item.rawName) ?? 1, item.price);
    }
  }
  const entries: QuoteEntry[] = [];
  for (const [aliasKey, g] of groups) {
    const rungs = [...g.ladder.entries()]
      .map(([min_qty, price]) => ({ min_qty, price }))
      .sort((a, b) => a.min_qty - b.min_qty);
    if (rungs.length === 0) continue;
    const hasLadder = rungs.length > 1;
    // representante: preferimos un rawName SIN "(N pcs)" (igual que el parser sin IA)
    const representative = g.rawNames.find((n) => qtyFromName(n) === null) ?? g.rawNames[0];
    if (representative === undefined) continue;
    entries.push({
      rawName: representative,
      aliasKey,
      price: hasLadder ? Math.min(...rungs.map((r) => r.price)) : (rungs[0]?.price ?? 0),
      tiers: hasLadder ? rungs : [],
      lines: g.lines,
    });
  }
  return entries;
}

// ---------- "inteligencia" determinística al aplicar (la IA solo extrajo texto) ----------

/** Umbral de sanidad vs el Mín actual del MODELO (además del ±15% vs el par). */
export const PRICE_SANITY_THRESHOLD = 30; // %

export type QuoteFlag = { motivo: string; sugerencia?: number };

/**
 * Checks previos a aplicar una entrada YA resuelta (Mesa y chat comparten esto):
 *  - escalera no monótona (más cantidad debería costar ≤) → flag
 *  - error de unidad probable vs el Mín actual del modelo (~10×/100× en cualquier
 *    dirección) → flag con precio sugerido
 *  - delta > ±30% vs el Mín actual del modelo → flag
 *  - delta > ±15% vs el precio anterior de ESTE proveedor → flag (umbral del viejo)
 * Sin flags → auto-aplicable. Con flags → revisión humana (jamás se auto-aplica).
 */
export function checkQuoteEntry(
  entry: { price: number; tiers: readonly QuoteTier[] },
  opts: { pairPrice: number | null; modelMin: number | null },
): QuoteFlag[] {
  const flags: QuoteFlag[] = [];

  // escalera invertida
  for (let i = 1; i < entry.tiers.length; i++) {
    const prev = entry.tiers[i - 1];
    const cur = entry.tiers[i];
    if (prev && cur && cur.price > prev.price) {
      flags.push({
        motivo: `escalera invertida: ${cur.min_qty}+ ($${cur.price}) sale MÁS caro que ${prev.min_qty}+ ($${prev.price})`,
      });
      break;
    }
  }

  const { modelMin, pairPrice } = opts;
  if (modelMin !== null && modelMin > 0) {
    const r = entry.price / modelMin;
    let unitFlag = false;
    for (const f of [10, 100]) {
      if (r >= f * 0.8 && r <= f * 1.25) {
        flags.push({
          motivo: `posible error de unidad: ~${f}× el Mín actual del modelo ($${modelMin})`,
          sugerencia: Math.round((entry.price / f) * 100) / 100,
        });
        unitFlag = true;
        break;
      }
      if (r >= 0.8 / f && r <= 1.25 / f) {
        flags.push({
          motivo: `posible error de unidad: ~1/${f} del Mín actual del modelo ($${modelMin})`,
          sugerencia: Math.round(entry.price * f * 100) / 100,
        });
        unitFlag = true;
        break;
      }
    }
    if (!unitFlag) {
      const pct = deltaPct(modelMin, entry.price);
      if (pct !== null && Math.abs(pct) > PRICE_SANITY_THRESHOLD) {
        flags.push({
          motivo: `${pct > 0 ? "+" : ""}${pct.toFixed(0)}% vs el Mín actual del modelo ($${modelMin})`,
        });
      }
    }
  }

  if (!withinAutoThreshold(pairPrice, entry.price)) {
    const pct = deltaPct(pairPrice, entry.price);
    flags.push({
      motivo: `${pct !== null && pct > 0 ? "+" : ""}${pct?.toFixed(0) ?? "?"}% vs el precio anterior de este proveedor ($${pairPrice})`,
    });
  }
  return flags;
}

export type GateResult = { allowed: true } | { allowed: false; flags: QuoteFlag[] };

/**
 * EL gate de escritura de precios (P1) — la ÚNICA definición de enforcement, pegada al
 * detector único (checkQuoteEntry). Flags sin force → bloqueado (quien llama NO debe
 * escribir); force=true (con reason del USUARIO, exigido por el caller) pasa.
 * Lo usan las tools de precio del executor; la UI (PastePanel) ya aplica la misma
 * semántica auto/review con estos mismos flags.
 */
export function applyGate(flags: readonly QuoteFlag[], force: boolean): GateResult {
  if (flags.length === 0 || force) return { allowed: true };
  return { allowed: false, flags: [...flags] };
}

/** % de variación vs el precio actual; null si no hay precio previo (→ auto-aplicable). */
export function deltaPct(oldPrice: number | null, newPrice: number): number | null {
  if (oldPrice === null || oldPrice === 0) return null;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

/** Regla del viejo load_prices: sin precio previo o |delta| ≤ 15% → se aplica solo. */
export function withinAutoThreshold(oldPrice: number | null, newPrice: number): boolean {
  const pct = deltaPct(oldPrice, newPrice);
  return pct === null || Math.abs(pct) <= PRICE_AUTO_THRESHOLD;
}

/** Llamada real de extracción (texto y/o screenshot) → ítems saneados. */
export async function extractQuoteAI(
  input: { text?: string; images?: GeminiImage[] },
  fetchFn?: FetchLike,
): Promise<ExtractedItem[]> {
  const images = input.images ?? [];
  const content =
    input.text?.trim() ||
    (images.length ? "Extraé los productos y precios de este screenshot de cotización." : "");
  if (!content && images.length === 0) return [];
  const text = await generateText(
    {
      system: buildExtractionSystem(),
      content,
      images,
      responseSchema: EXTRACTION_RESPONSE_SCHEMA,
      maxTokens: 8192,
    },
    fetchFn,
  );
  return parseExtractionJson(text);
}

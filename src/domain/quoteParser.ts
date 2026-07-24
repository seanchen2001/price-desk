// Parser de texto plano "MODELO  precio" — SIN IA (la extracción con Gemini es Fase 8).
// PURO: no resuelve identidad (eso es resolveModel) ni escribe nada. Su único contrato:
//   - una línea = "nombre … precio" (separadores :, -, ·, $ tolerados; usd/u$s al final).
//   - "(N pcs)" / "(N+ pcs)" / "(A-B pcs)" en el nombre = escalón por cantidad. Las líneas
//     cuya única diferencia es la cantidad se PLIEGAN en una sola entrada con `tiers`
//     (guardrail: cantidades JAMÁS crean filas separadas; `normalize` borra el paréntesis
//     así que todas las variantes comparten alias_key y resuelven al mismo model_id).
//   - con escalera, `price` = el más barato de la escalera (semántica del viejo
//     parseSupplierQuote: la celda muestra el mejor precio y la UI indica "mín Nu").
import { normalize } from "./normalize";

export type QuoteTier = { min_qty: number; price: number };

export type QuoteEntry = {
  /** nombre representativo tal cual se vio (preferimos una línea sin "(N pcs)") */
  rawName: string;
  /** clave de identidad compartida por todas las líneas plegadas */
  aliasKey: string;
  /** precio para `prices` (si hay escalera: el más barato) */
  price: number;
  /** escalera por cantidad; [] si la entrada tiene un precio único */
  tiers: QuoteTier[];
  /** líneas originales que aportaron (auditoría / preview) */
  lines: string[];
};

export type ParsedQuote = {
  entries: QuoteEntry[];
  /** líneas no vacías que no matchearon "nombre + precio" (feedback visible, no se tragan) */
  unparsed: string[];
};

// "(20 pcs)" | "(50+ pcs)" | "(1-20 pcs)" | "(20u)" | "(20)" → cantidad mínima del escalón.
const QTY_RE = /\((\d+)\s*(?:\+|-\s*\d+)?\s*(?:pcs?|pzs?|pz|u|un|unid(?:ades)?)?\s*\)/i;

/** Cantidad mínima "(N pcs)" embebida en un nombre, o null. Lo usa también la extracción
 *  con IA como red defensiva (si el modelo desobedece y manda escalones como ítems). */
export function qtyFromName(name: string): number | null {
  const m = QTY_RE.exec(name);
  return m ? Number(m[1]) : null;
}

// nombre (al menos una letra) + separadores + número final (+ moneda opcional)
const LINE_RE = /^(.+?)[\s:=·–—-]*\$?\s*(\d[\d.,]*)\s*(?:usd|u\$s|us\$|\$)?\s*$/i;

/** "1.234,50" (AR) | "1,234.50" (EN) | "610" → number, o null si no es un precio sano. */
function parsePrice(txt: string): number | null {
  let s = txt;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type ParsedLine = { name: string; price: number; minQty: number | null; line: string };

function parseLine(rawLine: string): ParsedLine | null {
  // viñetas/bullets comunes al pegar de WhatsApp
  const line = rawLine.replace(/^[\s•*·>-]+/, "").trim();
  if (!line) return null;
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const namePart = (m[1] ?? "").trim();
  const price = parsePrice(m[2] ?? "");
  if (price === null) return null;
  if (!/[a-záéíóúñ]/i.test(namePart)) return null; // el nombre necesita letras
  const qty = QTY_RE.exec(namePart);
  const minQty = qty ? Number(qty[1]) : null;
  return { name: namePart, price, minQty, line };
}

/**
 * Texto pegado → entradas por modelo (líneas de cantidad plegadas). El orden de salida
 * respeta la primera aparición de cada modelo en el texto.
 */
export function parseQuoteText(text: string): ParsedQuote {
  const unparsed: string[] = [];
  const groups = new Map<string, ParsedLine[]>();
  for (const rawLine of String(text ?? "").split(/\n+/)) {
    if (!rawLine.trim()) continue;
    const parsed = parseLine(rawLine);
    if (!parsed) {
      unparsed.push(rawLine.trim());
      continue;
    }
    const key = normalize(parsed.name);
    if (!key) {
      unparsed.push(rawLine.trim());
      continue;
    }
    const group = groups.get(key);
    if (group) group.push(parsed);
    else groups.set(key, [parsed]);
  }

  const entries: QuoteEntry[] = [];
  for (const [aliasKey, lines] of groups) {
    // escalera: cada línea es un escalón; sin cantidad = escalón base (min_qty 1).
    // Mismo escalón repetido → gana la última línea (el texto más nuevo pisa).
    const ladder = new Map<number, number>();
    for (const l of lines) ladder.set(l.minQty ?? 1, l.price);
    const rungs = [...ladder.entries()]
      .map(([min_qty, price]) => ({ min_qty, price }))
      .sort((a, b) => a.min_qty - b.min_qty);
    const hasLadder = rungs.length > 1;
    const representative = lines.find((l) => l.minQty === null) ?? lines[0];
    if (!representative || rungs.length === 0) continue; // imposible: el grupo nace con 1 línea
    entries.push({
      rawName: representative.name,
      aliasKey,
      price: hasLadder ? Math.min(...rungs.map((r) => r.price)) : (rungs[0]?.price ?? 0),
      tiers: hasLadder ? rungs : [],
      lines: lines.map((l) => l.line),
    });
  }
  return { entries, unparsed };
}

// Tokens de color de producto — LA lista única (guardrail: no re-implementar por lado).
// Base: la convención del catálogo viejo para iPhone (colores en INGLÉS como parte del
// nombre: "iPhone 17 Pro Max 256GB Orange" / Silver / Blue / Black / Titanium…), más las
// variantes Apple multi-palabra y los equivalentes en castellano que aparecen en quotes.
//
// SOLO afecta la VISUALIZACIÓN (agrupar familia por color en la Mesa); la identidad
// (model_id, aliases) NUNCA pasa por acá — cada color es su propio modelo.

const COLOR_TOKENS: readonly string[] = [
  // multi-palabra primero (el matcher prueba en orden y estos deben ganar)
  "desert titanium",
  "natural titanium",
  "black titanium",
  "white titanium",
  "blue titanium",
  "cosmic orange",
  "deep blue",
  "space black",
  "space gray",
  "space grey",
  "sierra blue",
  "pacific blue",
  "rose gold",
  // una palabra — inglés (convención del catálogo viejo)
  "titanium",
  "black",
  "white",
  "blue",
  "green",
  "pink",
  "yellow",
  "purple",
  "red",
  "orange",
  "silver",
  "gold",
  "graphite",
  "midnight",
  "starlight",
  "teal",
  "ultramarine",
  "lavender",
  "sage",
  "mist",
  "cream",
  // castellano (aparecen en quotes de proveedores)
  "negro",
  "blanco",
  "azul",
  "verde",
  "rosa",
  "amarillo",
  "violeta",
  "rojo",
  "naranja",
  "plateado",
  "plata",
  "dorado",
  "titanio",
];

// un regex por token, palabra completa, case-insensitive
const TOKEN_RES = COLOR_TOKENS.map(
  (t) => [t, new RegExp(`\\b${t.replace(/ /g, "\\s+")}\\b`, "i")] as const,
);

export type ColorExtraction = {
  /** color detectado tal cual aparece en el nombre (null = sin color) */
  color: string | null;
  /** el nombre sin el token de color (base de la familia) */
  base: string;
};

/** Detecta UN token de color en el nombre y devuelve el nombre base sin él. */
export function extractColor(name: string): ColorExtraction {
  const s = String(name ?? "");
  for (const [, re] of TOKEN_RES) {
    const m = re.exec(s);
    if (m) {
      const base = (s.slice(0, m.index) + s.slice(m.index + m[0].length))
        .replace(/\s{2,}/g, " ")
        .trim();
      // si al sacar el color no queda nada, el "color" ERA el nombre (ej. modelo "Naranja") — no tocar
      if (!base) return { color: null, base: s.trim() };
      return { color: m[0], base };
    }
  }
  return { color: null, base: s.trim() };
}

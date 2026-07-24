// Normalización de nombres de modelo — LA definición ÚNICA (guardrail: no re-implementar
// por lado). Contrato: test/resolver.golden.test.ts.
//
// minúsculas → quita sufijo regional (US/USA/LATIN SPECS) → quita TODO paréntesis
// (cantidades "(20 pcs)", códigos "(SM-S947)"/"(F761)") → quita el prefijo verboso "Galaxy"
// → quita todo lo no alfanumérico. CONSERVA GB/DS/5G/color/capacidad para no colisionar.
export const normalize = (s: string): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\b(?:us[a]?|latin)\s*specs?\b/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\bgalaxy\b/g, "")
    .replace(/[^a-z0-9]/g, "");

// El viejo (lib/helpers.js) exponía este mismo concepto como `skuKey`. Acá es un alias del
// único normalize — NUNCA una segunda implementación.
// PORT-NOTE: el skuKey viejo NO quitaba "galaxy" (esa limpieza vivía en otra capa, el
// removedor de basura "Galaxy …"). El contrato golden del resolver la folda acá, que es
// exactamente el fix de raíz que pide el plan.
export const skuKey = normalize;

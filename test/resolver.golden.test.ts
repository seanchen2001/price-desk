// Price Desk v2 — batería golden anti-duplicados (Vitest). Handoff para Fable.
//
// Este archivo es el TEST QUE FALTABA: codifica, con las variantes REALES que rompieron la app
// vieja, el contrato de `normalize` y `resolveModel`. Fable implementa esas dos funciones en
// src/domain/ hasta que este archivo pase. Es la red que impide que el bug de duplicados vuelva.
//
// Dropear en el repo nuevo como test/resolver.golden.test.ts y ajustar los imports:
import { describe, it, expect } from "vitest";
import { normalize } from "../src/domain/normalize";
import { resolveModel } from "../src/domain/resolver";

// ── Contrato de `normalize(name): string` ─────────────────────────────────────
// Debe: minúsculas → quitar sufijo regional (US/USA/LATIN SPECS) → quitar TODO lo que va entre
// paréntesis (cantidades "(20 pcs)", códigos "(SM-S947)"/"(F761)") → quitar el prefijo verboso
// "Galaxy" → quitar todo lo no alfanumérico. CONSERVA GB/DS/5G/color/capacidad para no colisionar.
//
// Implementación de referencia (Fable puede copiarla tal cual):
//   export const normalize = (s: string): string =>
//     String(s ?? "").toLowerCase()
//       .replace(/\b(?:us[a]?|latin)\s*specs?\b/g, "")
//       .replace(/\([^)]*\)/g, "")
//       .replace(/\bgalaxy\b/g, "")
//       .replace(/[^a-z0-9]/g, "");

describe("normalize — folda las variantes mecánicas (MISMO modelo → MISMA clave)", () => {
  const same = (a: string, b: string) => expect(normalize(a)).toBe(normalize(b));

  it("splits por cantidad (N pcs) == el modelo base", () => {
    same("S26 12+512 5G DS", "S26 12+512 5G DS (20 pcs)");
    same("S26 12+512 5G DS", "S26 12+512 5G DS (21-49 pcs)");
    same("S26 12+512 5G DS", "S26 12+512 5G DS (50+ pcs)");
    same("Z FLIP 7 FE 8+256 5G", "Z FLIP 7 FE 8+256 5G (100 pcs)");
  });

  it("sufijo regional US/LATIN SPECS == el genérico", () => {
    same("iPhone 17 Pro 256GB Blue", "iPhone 17 Pro 256GB Blue US Specs");
    same("S26 Ultra 256GB", "S26 Ultra 256GB LATIN SPECS");
  });

  it("mayúsculas/espacios/puntuación no importan", () => {
    same("S25 Ultra 12+512 5G DS", "S25 ULTRA 12+512 5G DS");
    same("A07  4+128   DS", "A07 4+128 DS");
  });

  it("códigos de modelo entre paréntesis se ignoran", () => {
    same("iPhone 17 Pro Max 512GB", "iPhone 17 Pro Max 512GB (F761)");
    same("S26 Plus 12+256 5G DS", "S26 Plus 12+256 5G DS (SM-S947)");
  });
});

describe("normalize — NO junta productos distintos (clave DIFERENTE)", () => {
  const diff = (a: string, b: string) => expect(normalize(a)).not.toBe(normalize(b));

  it("capacidad distinta", () => {
    diff("S26 12/256GB 5G", "S26 12/512GB 5G");
    diff("S26 12+256 5G DS", "S26 12+512 5G DS");
  });

  it("color distinto (iPhone: el color cambia el precio)", () => {
    diff("iPhone 17 Pro 256GB Blue", "iPhone 17 Pro 256GB Silver");
  });

  it("cross-notation NO se fusiona a propósito (12/512GB vs 12+512 5G DS)", () => {
    // Decisión de diseño: distinta notación puede ser distinto producto/plaza → separado.
    // Si en la práctica son el mismo, se unen UNA vez vía model_aliases (no acá).
    diff("S26 12/512GB 5G", "S26 12+512 5G DS");
  });
});

// ── Contrato de `resolveModel` ────────────────────────────────────────────────
// resolveModel(rawName, ctx, repo) →
//   { modelId }                       // match determinístico (por alias o por canónico)
//   | { candidateNew, aliasKey }      // no existe → cola de confirmación (NUNCA crea solo)
//
// `repo` es una fuente de datos inyectable (para testear sin Supabase):
//   repo.findAliasKey(key) -> modelId | null      (busca en model_aliases por alias_key)
//   repo.findModelByKey(key) -> modelId | null    (busca por normalize(canonical_name))
// En producción son queries a Supabase; en tests, mapas en memoria.

type Repo = {
  findAliasKey: (key: string) => string | null;
  findModelByKey: (key: string) => string | null;
};

// modelos "reales" ya existentes en la DB
const MODELS: Record<string, string> = {
  "S26 12+512 5G DS": "m-s26-512",
  "iPhone 17 Pro 256GB Blue": "m-ip17pro-256-blue",
  "S26 ULTRA 12+256 5G DS": "m-s26u-256",
};
// aliases aprendidos (variantes que normalize NO folda, mapeadas a mano una vez)
const ALIASES: Record<string, string> = {
  // "Galaxy S26 Ultra 12GB/256GB LATIN SPECS" no folda por normalize (GB + orden de tokens),
  // así que la primera vez se confirmó a mano y quedó como alias → determinístico para siempre.
  [normalize("Galaxy S26 Ultra 12GB/256GB")]: "m-s26u-256",
};

const repo: Repo = {
  findModelByKey: (key) => {
    for (const [name, id] of Object.entries(MODELS)) if (normalize(name) === key) return id;
    return null;
  },
  findAliasKey: (key) => ALIASES[key] ?? null,
};

describe("resolveModel — el código decide la identidad, no la IA", () => {
  it("una variante mecánica resuelve al modelo base (vía normalize→canónico)", () => {
    expect(resolveModel("S26 12+512 5G DS (20 pcs)", {}, repo)).toEqual({ modelId: "m-s26-512" });
    expect(resolveModel("iPhone 17 Pro 256GB Blue US Specs", {}, repo)).toEqual({ modelId: "m-ip17pro-256-blue" });
  });

  it("una variante que normalize NO folda resuelve vía model_aliases (aprendido)", () => {
    expect(resolveModel("Galaxy S26 Ultra 12GB/256GB LATIN SPECS", {}, repo)).toEqual({ modelId: "m-s26u-256" });
  });

  it("un modelo genuinamente nuevo cae en la cola de confirmación y NO se crea solo", () => {
    const r = resolveModel("iPhone 18 Pro 512GB Titanium", {}, repo);
    expect(r).toHaveProperty("candidateNew");
    expect(r).not.toHaveProperty("modelId");
    // garantía dura: resolveModel es PURO — no escribió en MODELS/ALIASES
    expect(Object.keys(MODELS)).toHaveLength(3);
  });
});

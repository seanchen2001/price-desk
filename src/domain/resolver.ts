// ★ resolveModel — el resolvedor determinístico de identidad (el fix central del rebuild).
// La IA solo propone texto+precio; ESTA función decide a qué modelo (por ID) corresponde
// cada línea. PURA: no escribe nada; lo genuinamente nuevo vuelve como candidato para la
// cola de confirmación (la UI, al confirmar, crea el modelo y persiste el alias).
// Contrato: test/resolver.golden.test.ts.

import { normalize } from "./normalize";

// Fuente de datos inyectable (producción: queries a Supabase; tests: mapas en memoria).
export type ResolverRepo = {
  /** busca en model_aliases por alias_key */
  findAliasKey: (key: string) => string | null;
  /** busca por normalize(canonical_name) de models */
  findModelByKey: (key: string) => string | null;
};

export type ResolveContext = {
  category?: string;
  department?: string;
};

export type ResolveResult =
  | { modelId: string }
  | { candidateNew: string; aliasKey: string };

// Pipeline: normalize → model_aliases.alias_key → key del canonical_name → candidateNew.
// `_ctx` (category/department) no decide identidad; queda en la firma para que la cola de
// confirmación (Fase 5) pre-cargue los defaults del candidato.
export function resolveModel(
  rawName: string,
  _ctx: ResolveContext,
  repo: ResolverRepo,
): ResolveResult {
  const key = normalize(rawName);
  const byAlias = repo.findAliasKey(key);
  if (byAlias) return { modelId: byAlias };
  const byCanonical = repo.findModelByKey(key);
  if (byCanonical) return { modelId: byCanonical };
  return { candidateNew: rawName, aliasKey: key };
}

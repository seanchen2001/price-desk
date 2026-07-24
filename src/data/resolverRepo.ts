// El ResolverRepo REAL sobre Supabase + las mutaciones canónicas de identidad.
//
// Estrategia (REBUILD-PLAN): Postgres no conoce nuestro `normalize`, así que al CREAR o
// RENOMBRAR un model SIEMPRE se escribe también su self-alias (alias_text=canonical_name,
// alias_key=normalize(canonical_name)) → findModelByKey se vuelve otro lookup en
// model_aliases. `resolveModel` del domain queda PURO y SÍNCRONO (el golden test no se
// toca): acá se pre-fetchea un snapshot en memoria y se le inyecta como repo.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { normalize } from "../domain/normalize";
import {
  resolveModel,
  type ResolveContext,
  type ResolveResult,
  type ResolverRepo,
} from "../domain/resolver";
import { insertAlias, type AliasRow } from "./aliases";
import { keys } from "./keys";
import { insertModel, updateModel, type ModelRow } from "./models";
import { supabase, unwrapVoid, type Db } from "./supabase";

/**
 * Snapshot en memoria (aliases + normalize(canonical_name) de models) → ResolverRepo
 * síncrono para el domain. Belt-and-braces: aunque todo model del flujo canónico tiene
 * su self-alias, también se indexa el canonical_name por si algo entró por fuera.
 */
export async function fetchResolverSnapshot(db: Db = supabase): Promise<ResolverRepo> {
  const [aliasRes, modelRes] = await Promise.all([
    db.from("model_aliases").select("alias_key, model_id"),
    db.from("models").select("id, canonical_name").is("deleted_at", null),
  ]);
  if (aliasRes.error) throw aliasRes.error;
  if (modelRes.error) throw modelRes.error;
  const byAlias = new Map((aliasRes.data ?? []).map((a) => [a.alias_key, a.model_id]));
  const byCanonical = new Map((modelRes.data ?? []).map((m) => [normalize(m.canonical_name), m.id]));
  return {
    findAliasKey: (key) => byAlias.get(key) ?? null,
    findModelByKey: (key) => byCanonical.get(key) ?? null,
  };
}

/** resolveModel async: pre-fetch del snapshot + domain puro. */
export async function resolveModelAsync(
  rawName: string,
  ctx: ResolveContext = {},
  db: Db = supabase,
): Promise<ResolveResult> {
  return resolveModel(rawName, ctx, await fetchResolverSnapshot(db));
}

/** Batch (parser, Fase 5): UN snapshot para N líneas. */
export async function resolveManyAsync(
  rawNames: readonly string[],
  ctx: ResolveContext = {},
  db: Db = supabase,
): Promise<ResolveResult[]> {
  const repo = await fetchResolverSnapshot(db);
  return rawNames.map((n) => resolveModel(n, ctx, repo));
}

export type NewModelInput = {
  category_id?: string;
  department_id?: string;
  spec?: string;
};

/**
 * Alta CANÓNICA de un modelo: crea la fila en `models` Y su self-alias. Si la alias_key
 * ya pertenece a un modelo, falla ruidoso (jamás crear un duplicado).
 * Sin transacciones vía PostgREST: si el alias falla se compensa borrando el model.
 */
export async function createModelWithAlias(
  canonicalName: string,
  input: NewModelInput = {},
  db: Db = supabase,
): Promise<ModelRow> {
  const aliasKey = normalize(canonicalName);
  if (!aliasKey) throw new Error(`Nombre inválido: "${canonicalName}" normaliza a vacío`);
  const existing = await db
    .from("model_aliases")
    .select("model_id")
    .eq("alias_key", aliasKey)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    throw new Error(
      `Ya existe un modelo para "${canonicalName}" (alias_key=${aliasKey}, model_id=${existing.data.model_id}); usá ese modelo o confirmCandidate`,
    );
  }
  const model = await insertModel(
    {
      canonical_name: canonicalName,
      category_id: input.category_id ?? null,
      department_id: input.department_id ?? null,
      spec: input.spec ?? null,
    },
    db,
  );
  const aliasRes = await db
    .from("model_aliases")
    .insert({ model_id: model.id, alias_text: canonicalName, alias_key: aliasKey });
  if (aliasRes.error) {
    unwrapVoid(await db.from("models").delete().eq("id", model.id)); // compensación
    throw aliasRes.error;
  }
  return model;
}

/** Renombre canónico: actualiza canonical_name Y asegura el self-alias del nombre nuevo. */
export async function renameModelWithAlias(
  modelId: string,
  newCanonicalName: string,
  db: Db = supabase,
): Promise<ModelRow> {
  const aliasKey = normalize(newCanonicalName);
  if (!aliasKey) throw new Error(`Nombre inválido: "${newCanonicalName}" normaliza a vacío`);
  const existing = await db
    .from("model_aliases")
    .select("model_id")
    .eq("alias_key", aliasKey)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data && existing.data.model_id !== modelId) {
    throw new Error(
      `El nombre "${newCanonicalName}" ya resuelve a otro modelo (${existing.data.model_id})`,
    );
  }
  const model = await updateModel(modelId, { canonical_name: newCanonicalName }, db);
  if (!existing.data) {
    await insertAlias(
      { model_id: modelId, alias_text: newCanonicalName, alias_key: aliasKey },
      db,
    );
  }
  return model;
}

/**
 * La cola de confirmación aprendió: aliasText (tal cual se vio) → modelId. Escribe el
 * alias y el match queda determinístico para siempre. Si la key ya pertenece a otro
 * modelo, el UNIQUE de alias_key lo hace fallar ruidoso.
 */
export async function confirmCandidate(
  aliasText: string,
  modelId: string,
  db: Db = supabase,
): Promise<AliasRow> {
  const aliasKey = normalize(aliasText);
  if (!aliasKey) throw new Error(`Alias inválido: "${aliasText}" normaliza a vacío`);
  return insertAlias({ model_id: modelId, alias_text: aliasText, alias_key: aliasKey }, db);
}

// ---------- hooks ----------

export function useCreateModelWithAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.models, "create-with-alias"],
    mutationFn: (vars: { canonicalName: string } & NewModelInput) =>
      createModelWithAlias(vars.canonicalName, vars),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.models }),
        qc.invalidateQueries({ queryKey: keys.aliases() }),
      ]),
  });
}

export function useRenameModelWithAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.models, "rename-with-alias"],
    mutationFn: (vars: { modelId: string; newCanonicalName: string }) =>
      renameModelWithAlias(vars.modelId, vars.newCanonicalName),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.models }),
        qc.invalidateQueries({ queryKey: keys.aliases() }),
      ]),
  });
}

export function useConfirmCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.aliases(), "confirm-candidate"],
    mutationFn: (vars: { aliasText: string; modelId: string }) =>
      confirmCandidate(vars.aliasText, vars.modelId),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.aliases() }),
  });
}

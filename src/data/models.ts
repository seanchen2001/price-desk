// `models` — queries + mutaciones POR FILA (guardrail R4: jamás reemplazo de colección).
// OJO: el alta/renombre CANÓNICO de modelos (que escribe también el self-alias) vive en
// resolverRepo.createModelWithAlias / renameModelWithAlias; acá está el CRUD por fila.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Database } from "./database.types";
import { keys } from "./keys";
import { supabase, unwrap, type Db } from "./supabase";

export type ModelRow = Database["public"]["Tables"]["models"]["Row"];
export type ModelInsert = Database["public"]["Tables"]["models"]["Insert"];
export type ModelUpdate = Database["public"]["Tables"]["models"]["Update"];

export async function listModels(db: Db = supabase): Promise<ModelRow[]> {
  return unwrap(
    await db.from("models").select("*").is("deleted_at", null).order("canonical_name"),
  );
}

export async function getModel(id: string, db: Db = supabase): Promise<ModelRow> {
  return unwrap(await db.from("models").select("*").eq("id", id).single());
}

/** Insert crudo de UNA fila (sin self-alias). Preferí resolverRepo.createModelWithAlias. */
export async function insertModel(row: ModelInsert, db: Db = supabase): Promise<ModelRow> {
  return unwrap(await db.from("models").insert(row).select().single());
}

export async function updateModel(
  id: string,
  patch: ModelUpdate,
  db: Db = supabase,
): Promise<ModelRow> {
  return unwrap(
    await db
      .from("models")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single(),
  );
}

/** Papelero (soft-delete): marca deleted_at; nunca borra en duro desde la UI. */
export async function softDeleteModel(id: string, db: Db = supabase): Promise<ModelRow> {
  return updateModel(id, { deleted_at: new Date().toISOString(), active: false }, db);
}

// ---------- hooks ----------

export function useModels() {
  return useQuery({ queryKey: keys.models, queryFn: () => listModels() });
}

export function useUpdateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.models, "update"],
    mutationFn: (vars: { id: string; patch: ModelUpdate }) => updateModel(vars.id, vars.patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.models });
      const prev = qc.getQueryData<ModelRow[]>(keys.models);
      qc.setQueryData<ModelRow[]>(keys.models, (rows) =>
        rows?.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(keys.models, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.models }),
  });
}

export function useSoftDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.models, "soft-delete"],
    mutationFn: (id: string) => softDeleteModel(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.models });
      const prev = qc.getQueryData<ModelRow[]>(keys.models);
      qc.setQueryData<ModelRow[]>(keys.models, (rows) => rows?.filter((r) => r.id !== id));
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(keys.models, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.models }),
  });
}

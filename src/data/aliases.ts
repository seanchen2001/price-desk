// `model_aliases` — la tabla que hace determinístico al resolver. El alta "aprendida"
// (confirmCandidate) y el self-alias del alta de modelo viven en resolverRepo; acá el
// CRUD por fila + hooks de lectura.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Database } from "./database.types";
import { keys } from "./keys";
import { supabase, unwrap, unwrapVoid, type Db } from "./supabase";

export type AliasRow = Database["public"]["Tables"]["model_aliases"]["Row"];
export type AliasInsert = Database["public"]["Tables"]["model_aliases"]["Insert"];

export async function listAliases(modelId?: string, db: Db = supabase): Promise<AliasRow[]> {
  const q = db.from("model_aliases").select("*").order("created_at");
  return unwrap(await (modelId === undefined ? q : q.eq("model_id", modelId)));
}

export async function findModelIdByAliasKey(
  aliasKey: string,
  db: Db = supabase,
): Promise<string | null> {
  const res = await db
    .from("model_aliases")
    .select("model_id")
    .eq("alias_key", aliasKey)
    .maybeSingle();
  if (res.error) throw res.error;
  return res.data?.model_id ?? null;
}

/**
 * Insert de UN alias. alias_key UNIQUE global: si la key ya pertenece a otro modelo el
 * insert falla ruidoso (jamás re-apuntar silenciosamente una identidad ya aprendida).
 */
export async function insertAlias(row: AliasInsert, db: Db = supabase): Promise<AliasRow> {
  return unwrap(await db.from("model_aliases").insert(row).select().single());
}

export async function deleteAlias(id: string, db: Db = supabase): Promise<void> {
  unwrapVoid(await db.from("model_aliases").delete().eq("id", id));
}

// ---------- hooks ----------

export function useAliases(modelId?: string) {
  return useQuery({ queryKey: keys.aliases(modelId), queryFn: () => listAliases(modelId) });
}

export function useInsertAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.aliases(), "insert"],
    mutationFn: (row: AliasInsert) => insertAlias(row),
    onMutate: async (row) => {
      await qc.cancelQueries({ queryKey: keys.aliases() });
      const key = keys.aliases();
      const prev = qc.getQueryData<AliasRow[]>(key);
      qc.setQueryData<AliasRow[]>(key, (rows) =>
        rows
          ? [
              ...rows,
              {
                id: `optimista:${row.alias_key}`,
                model_id: row.model_id,
                alias_text: row.alias_text,
                alias_key: row.alias_key,
                created_at: new Date().toISOString(),
              },
            ]
          : rows,
      );
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(keys.aliases(), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.aliases() }),
  });
}

export function useDeleteAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.aliases(), "delete"],
    mutationFn: (id: string) => deleteAlias(id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.aliases() }),
  });
}

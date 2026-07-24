// `suppliers` — CRUD por fila + hooks.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Database } from "./database.types";
import { keys } from "./keys";
import { supabase, unwrap, type Db } from "./supabase";

export type SupplierRow = Database["public"]["Tables"]["suppliers"]["Row"];
export type SupplierInsert = Database["public"]["Tables"]["suppliers"]["Insert"];
export type SupplierUpdate = Database["public"]["Tables"]["suppliers"]["Update"];

export async function listSuppliers(db: Db = supabase): Promise<SupplierRow[]> {
  return unwrap(await db.from("suppliers").select("*").order("name"));
}

export async function insertSupplier(row: SupplierInsert, db: Db = supabase): Promise<SupplierRow> {
  return unwrap(await db.from("suppliers").insert(row).select().single());
}

export async function updateSupplier(
  id: string,
  patch: SupplierUpdate,
  db: Db = supabase,
): Promise<SupplierRow> {
  return unwrap(await db.from("suppliers").update(patch).eq("id", id).select().single());
}

// ---------- hooks ----------

export function useSuppliers() {
  return useQuery({ queryKey: keys.suppliers, queryFn: () => listSuppliers() });
}

export function useInsertSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.suppliers, "insert"],
    mutationFn: (row: SupplierInsert) => insertSupplier(row),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.suppliers }),
  });
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.suppliers, "update"],
    mutationFn: (vars: { id: string; patch: SupplierUpdate }) =>
      updateSupplier(vars.id, vars.patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.suppliers });
      const prev = qc.getQueryData<SupplierRow[]>(keys.suppliers);
      qc.setQueryData<SupplierRow[]>(keys.suppliers, (rows) =>
        rows?.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(keys.suppliers, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.suppliers }),
  });
}

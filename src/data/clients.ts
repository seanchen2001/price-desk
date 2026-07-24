// `clients` + `shippings` — CRUD por fila + hooks (soft-delete con deleted_at).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Database } from "./database.types";
import { keys } from "./keys";
import { supabase, unwrap, type Db } from "./supabase";

export type ClientRow = Database["public"]["Tables"]["clients"]["Row"];
export type ClientInsert = Database["public"]["Tables"]["clients"]["Insert"];
export type ClientUpdate = Database["public"]["Tables"]["clients"]["Update"];
export type ShippingRow = Database["public"]["Tables"]["shippings"]["Row"];
export type ShippingInsert = Database["public"]["Tables"]["shippings"]["Insert"];
export type ShippingUpdate = Database["public"]["Tables"]["shippings"]["Update"];

// ---------- clients ----------

export async function listClients(db: Db = supabase): Promise<ClientRow[]> {
  return unwrap(await db.from("clients").select("*").is("deleted_at", null).order("name"));
}

export async function insertClient(row: ClientInsert, db: Db = supabase): Promise<ClientRow> {
  return unwrap(await db.from("clients").insert(row).select().single());
}

export async function updateClient(
  id: string,
  patch: ClientUpdate,
  db: Db = supabase,
): Promise<ClientRow> {
  return unwrap(await db.from("clients").update(patch).eq("id", id).select().single());
}

export async function softDeleteClient(id: string, db: Db = supabase): Promise<ClientRow> {
  return updateClient(id, { deleted_at: new Date().toISOString() }, db);
}

// ---------- shippings ----------

export async function listShippings(db: Db = supabase): Promise<ShippingRow[]> {
  return unwrap(await db.from("shippings").select("*").is("deleted_at", null).order("label"));
}

export async function insertShipping(row: ShippingInsert, db: Db = supabase): Promise<ShippingRow> {
  return unwrap(await db.from("shippings").insert(row).select().single());
}

export async function updateShipping(
  id: string,
  patch: ShippingUpdate,
  db: Db = supabase,
): Promise<ShippingRow> {
  return unwrap(await db.from("shippings").update(patch).eq("id", id).select().single());
}

export async function softDeleteShipping(id: string, db: Db = supabase): Promise<ShippingRow> {
  return updateShipping(id, { deleted_at: new Date().toISOString() }, db);
}

// ---------- hooks ----------

export function useClients() {
  return useQuery({ queryKey: keys.clients, queryFn: () => listClients() });
}

export function useInsertClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.clients, "insert"],
    mutationFn: (row: ClientInsert) => insertClient(row),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.clients }),
  });
}

export function useUpdateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.clients, "update"],
    mutationFn: (vars: { id: string; patch: ClientUpdate }) => updateClient(vars.id, vars.patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.clients });
      const prev = qc.getQueryData<ClientRow[]>(keys.clients);
      qc.setQueryData<ClientRow[]>(keys.clients, (rows) =>
        rows?.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(keys.clients, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.clients }),
  });
}

export function useSoftDeleteClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.clients, "soft-delete"],
    mutationFn: (id: string) => softDeleteClient(id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.clients }),
  });
}

export function useShippings() {
  return useQuery({ queryKey: keys.shippings, queryFn: () => listShippings() });
}

export function useInsertShipping() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.shippings, "insert"],
    mutationFn: (row: ShippingInsert) => insertShipping(row),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.shippings }),
  });
}

export function useUpdateShipping() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.shippings, "update"],
    mutationFn: (vars: { id: string; patch: ShippingUpdate }) =>
      updateShipping(vars.id, vars.patch),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.shippings }),
  });
}

export function useSoftDeleteShipping() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.shippings, "soft-delete"],
    mutationFn: (id: string) => softDeleteShipping(id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.shippings }),
  });
}

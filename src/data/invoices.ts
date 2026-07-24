// `invoices` + `invoice_items` + `invoice_item_units` — CRUD por fila + hooks.
// Una unidad física = una fila en invoice_item_units (IMEI + serial), nunca arrays paralelos.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Database } from "./database.types";
import { keys } from "./keys";
import { supabase, unwrap, unwrapVoid, type Db } from "./supabase";

export type InvoiceRow = Database["public"]["Tables"]["invoices"]["Row"];
export type InvoiceInsert = Database["public"]["Tables"]["invoices"]["Insert"];
export type InvoiceUpdate = Database["public"]["Tables"]["invoices"]["Update"];
export type InvoiceItemRow = Database["public"]["Tables"]["invoice_items"]["Row"];
export type InvoiceItemInsert = Database["public"]["Tables"]["invoice_items"]["Insert"];
export type InvoiceItemUpdate = Database["public"]["Tables"]["invoice_items"]["Update"];
export type ItemUnitRow = Database["public"]["Tables"]["invoice_item_units"]["Row"];
export type ItemUnitInsert = Database["public"]["Tables"]["invoice_item_units"]["Insert"];
export type ItemUnitUpdate = Database["public"]["Tables"]["invoice_item_units"]["Update"];

// ---------- invoices ----------

export async function listInvoices(db: Db = supabase): Promise<InvoiceRow[]> {
  return unwrap(
    await db
      .from("invoices")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
  );
}

export async function getInvoice(id: string, db: Db = supabase): Promise<InvoiceRow> {
  return unwrap(await db.from("invoices").select("*").eq("id", id).single());
}

export async function insertInvoice(row: InvoiceInsert, db: Db = supabase): Promise<InvoiceRow> {
  return unwrap(await db.from("invoices").insert(row).select().single());
}

export async function updateInvoice(
  id: string,
  patch: InvoiceUpdate,
  db: Db = supabase,
): Promise<InvoiceRow> {
  return unwrap(await db.from("invoices").update(patch).eq("id", id).select().single());
}

/** Papelero: soft-delete. */
export async function softDeleteInvoice(id: string, db: Db = supabase): Promise<InvoiceRow> {
  return updateInvoice(id, { deleted_at: new Date().toISOString() }, db);
}

// ---------- invoice_items ----------

/** Sin invoiceId lista TODOS los items (Historial/timeline arman el índice en memoria). */
export async function listInvoiceItems(
  invoiceId?: string,
  db: Db = supabase,
): Promise<InvoiceItemRow[]> {
  let q = db.from("invoice_items").select("*");
  if (invoiceId !== undefined) q = q.eq("invoice_id", invoiceId);
  return unwrap(await q);
}

export async function insertInvoiceItem(
  row: InvoiceItemInsert,
  db: Db = supabase,
): Promise<InvoiceItemRow> {
  return unwrap(await db.from("invoice_items").insert(row).select().single());
}

export async function updateInvoiceItem(
  id: string,
  patch: InvoiceItemUpdate,
  db: Db = supabase,
): Promise<InvoiceItemRow> {
  return unwrap(await db.from("invoice_items").update(patch).eq("id", id).select().single());
}

export async function deleteInvoiceItem(id: string, db: Db = supabase): Promise<void> {
  unwrapVoid(await db.from("invoice_items").delete().eq("id", id));
}

// ---------- invoice_item_units (una fila por unidad física: IMEI + serie) ----------

/** Sin itemId lista TODAS las unidades (Historial cuenta IMEIs cargados por factura). */
export async function listItemUnits(itemId?: string, db: Db = supabase): Promise<ItemUnitRow[]> {
  let q = db.from("invoice_item_units").select("*");
  if (itemId !== undefined) q = q.eq("item_id", itemId);
  return unwrap(await q);
}

/**
 * Deja las unidades de UN item = qty filas (imei/serial por índice; sobran datos → se
 * conservan filas extra para no perder lo pegado). Reemplazo scoped a un solo item —
 * es la representación física de esa línea, no una colección compartida.
 */
export async function setUnitsForItem(
  vars: { itemId: string; qty: number; imeis: readonly string[]; serials: readonly string[] },
  db: Db = supabase,
): Promise<ItemUnitRow[]> {
  const units = Math.max(Number(vars.qty) || 0, vars.imeis.length, vars.serials.length);
  unwrapVoid(await db.from("invoice_item_units").delete().eq("item_id", vars.itemId));
  if (units === 0) return [];
  const rows: ItemUnitInsert[] = Array.from({ length: units }, (_, u) => ({
    item_id: vars.itemId,
    imei: vars.imeis[u] ?? null,
    serial: vars.serials[u] ?? null,
  }));
  return unwrap(await db.from("invoice_item_units").insert(rows).select());
}

export async function insertItemUnit(row: ItemUnitInsert, db: Db = supabase): Promise<ItemUnitRow> {
  return unwrap(await db.from("invoice_item_units").insert(row).select().single());
}

export async function updateItemUnit(
  id: string,
  patch: ItemUnitUpdate,
  db: Db = supabase,
): Promise<ItemUnitRow> {
  return unwrap(await db.from("invoice_item_units").update(patch).eq("id", id).select().single());
}

export async function deleteItemUnit(id: string, db: Db = supabase): Promise<void> {
  unwrapVoid(await db.from("invoice_item_units").delete().eq("id", id));
}

// ---------- hooks ----------

export function useInvoices() {
  return useQuery({ queryKey: keys.invoices, queryFn: () => listInvoices() });
}

export function useInsertInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.invoices, "insert"],
    mutationFn: (row: InvoiceInsert) => insertInvoice(row),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invoices }),
  });
}

export function useUpdateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.invoices, "update"],
    mutationFn: (vars: { id: string; patch: InvoiceUpdate }) => updateInvoice(vars.id, vars.patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.invoices });
      const prev = qc.getQueryData<InvoiceRow[]>(keys.invoices);
      qc.setQueryData<InvoiceRow[]>(keys.invoices, (rows) =>
        rows?.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(keys.invoices, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invoices }),
  });
}

export function useSoftDeleteInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.invoices, "soft-delete"],
    mutationFn: (id: string) => softDeleteInvoice(id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invoices }),
  });
}

export function useInvoiceItems(invoiceId?: string) {
  return useQuery({
    queryKey: keys.invoiceItems(invoiceId),
    queryFn: () => listInvoiceItems(invoiceId),
  });
}

export function useInsertInvoiceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.invoiceItems(), "insert"],
    mutationFn: (row: InvoiceItemInsert) => insertInvoiceItem(row),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invoiceItems() }),
  });
}

export function useUpdateInvoiceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.invoiceItems(), "update"],
    mutationFn: (vars: { id: string; patch: InvoiceItemUpdate }) =>
      updateInvoiceItem(vars.id, vars.patch),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invoiceItems() }),
  });
}

export function useDeleteInvoiceItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.invoiceItems(), "delete"],
    mutationFn: (id: string) => deleteInvoiceItem(id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invoiceItems() }),
  });
}

export function useItemUnits(itemId?: string) {
  return useQuery({ queryKey: keys.itemUnits(itemId), queryFn: () => listItemUnits(itemId) });
}

export function useSetUnitsForItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.itemUnits(), "set-for-item"],
    mutationFn: (vars: { itemId: string; qty: number; imeis: string[]; serials: string[] }) =>
      setUnitsForItem(vars),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.itemUnits() }),
  });
}

export function useInsertItemUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.itemUnits(), "insert"],
    mutationFn: (row: ItemUnitInsert) => insertItemUnit(row),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.itemUnits() }),
  });
}

export function useUpdateItemUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.itemUnits(), "update"],
    mutationFn: (vars: { id: string; patch: ItemUnitUpdate }) =>
      updateItemUnit(vars.id, vars.patch),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.itemUnits() }),
  });
}

export function useDeleteItemUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.itemUnits(), "delete"],
    mutationFn: (id: string) => deleteItemUnit(id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.itemUnits() }),
  });
}

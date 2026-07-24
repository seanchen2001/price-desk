// `ledger` — movimientos MANUALES (pagos/gastos) por party_id; los cargos salen de
// invoices por JOIN (domain/accounts.ts). CRUD por fila + hooks.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Database } from "./database.types";
import { keys } from "./keys";
import { supabase, unwrap, unwrapVoid, type Db } from "./supabase";

export type LedgerRow = Database["public"]["Tables"]["ledger"]["Row"];
export type LedgerInsert = Database["public"]["Tables"]["ledger"]["Insert"];
export type LedgerUpdate = Database["public"]["Tables"]["ledger"]["Update"];

export type LedgerFilter = {
  party_type?: "client" | "supplier";
  party_id?: string;
};

export async function listLedger(
  filter: LedgerFilter = {},
  db: Db = supabase,
): Promise<LedgerRow[]> {
  let q = db.from("ledger").select("*").order("ts", { ascending: false });
  if (filter.party_type !== undefined) q = q.eq("party_type", filter.party_type);
  if (filter.party_id !== undefined) q = q.eq("party_id", filter.party_id);
  return unwrap(await q);
}

export async function insertLedgerEntry(row: LedgerInsert, db: Db = supabase): Promise<LedgerRow> {
  return unwrap(await db.from("ledger").insert(row).select().single());
}

export async function updateLedgerEntry(
  id: string,
  patch: LedgerUpdate,
  db: Db = supabase,
): Promise<LedgerRow> {
  return unwrap(await db.from("ledger").update(patch).eq("id", id).select().single());
}

export async function deleteLedgerEntry(id: string, db: Db = supabase): Promise<void> {
  unwrapVoid(await db.from("ledger").delete().eq("id", id));
}

// ---------- hooks ----------

export function useLedger(partyId?: string, partyType?: "client" | "supplier") {
  const filter: LedgerFilter = {};
  if (partyId !== undefined) filter.party_id = partyId;
  if (partyType !== undefined) filter.party_type = partyType;
  return useQuery({ queryKey: keys.ledger(partyId), queryFn: () => listLedger(filter) });
}

export function useInsertLedgerEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.ledger(), "insert"],
    mutationFn: (row: LedgerInsert) => insertLedgerEntry(row),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.ledger() }),
  });
}

export function useUpdateLedgerEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.ledger(), "update"],
    mutationFn: (vars: { id: string; patch: LedgerUpdate }) =>
      updateLedgerEntry(vars.id, vars.patch),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.ledger() }),
  });
}

export function useDeleteLedgerEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.ledger(), "delete"],
    mutationFn: (id: string) => deleteLedgerEntry(id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.ledger() }),
  });
}

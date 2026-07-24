// knowledge / chat_log / drafts / snapshots / ops_tracking — entidades chicas, mismo
// patrón: mutación por fila + invalidación por key.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Database, Json } from "./database.types";
import { keys } from "./keys";
import { supabase, unwrap, unwrapVoid, type Db } from "./supabase";

export type KnowledgeRow = Database["public"]["Tables"]["knowledge"]["Row"];
export type ChatLogRow = Database["public"]["Tables"]["chat_log"]["Row"];
export type ChatLogInsert = Database["public"]["Tables"]["chat_log"]["Insert"];
export type DraftRow = Database["public"]["Tables"]["drafts"]["Row"];
export type SnapshotRow = Database["public"]["Tables"]["snapshots"]["Row"];
export type OpsRow = Database["public"]["Tables"]["ops_tracking"]["Row"];
export type OpsUpsert = Database["public"]["Tables"]["ops_tracking"]["Insert"] & {
  invoice_id: string;
};

// ---------- knowledge ----------

export async function listKnowledge(db: Db = supabase): Promise<KnowledgeRow[]> {
  return unwrap(await db.from("knowledge").select("*").order("created_at"));
}

export async function insertKnowledge(ruleText: string, db: Db = supabase): Promise<KnowledgeRow> {
  return unwrap(await db.from("knowledge").insert({ rule_text: ruleText }).select().single());
}

export async function deleteKnowledge(id: string, db: Db = supabase): Promise<void> {
  unwrapVoid(await db.from("knowledge").delete().eq("id", id));
}

// ---------- chat_log (append-only) ----------

export async function listChatLog(limit = 200, db: Db = supabase): Promise<ChatLogRow[]> {
  const rows = unwrap(
    await db.from("chat_log").select("*").order("ts", { ascending: false }).limit(limit),
  );
  return rows.reverse(); // cronológico para la UI
}

export async function appendChatLog(row: ChatLogInsert, db: Db = supabase): Promise<ChatLogRow> {
  return unwrap(await db.from("chat_log").insert(row).select().single());
}

// ---------- drafts (transitorio, jsonb) ----------

export async function listDrafts(db: Db = supabase): Promise<DraftRow[]> {
  return unwrap(await db.from("drafts").select("*").order("updated_at", { ascending: false }));
}

/** Upsert de UN draft (id conocido = actualizar, sin id = crear). */
export async function upsertDraft(
  vars: { id?: string; payload: Json },
  db: Db = supabase,
): Promise<DraftRow> {
  const now = new Date().toISOString();
  if (vars.id === undefined) {
    return unwrap(
      await db.from("drafts").insert({ payload: vars.payload, updated_at: now }).select().single(),
    );
  }
  return unwrap(
    await db
      .from("drafts")
      .upsert({ id: vars.id, payload: vars.payload, updated_at: now })
      .select()
      .single(),
  );
}

export async function deleteDraft(id: string, db: Db = supabase): Promise<void> {
  unwrapVoid(await db.from("drafts").delete().eq("id", id));
}

// ---------- snapshots (semanales, inmutables por semana) ----------

export async function listSnapshots(db: Db = supabase): Promise<SnapshotRow[]> {
  return unwrap(await db.from("snapshots").select("*").order("week", { ascending: false }));
}

/** Una foto por semana (lunes): re-tomarla en la misma semana la reemplaza. */
export async function upsertSnapshot(
  vars: { week: string; payload: Json },
  db: Db = supabase,
): Promise<SnapshotRow> {
  return unwrap(
    await db.from("snapshots").upsert(vars, { onConflict: "week" }).select().single(),
  );
}

// ---------- ops_tracking (timeline del trade, PK = invoice_id) ----------

export async function listOps(db: Db = supabase): Promise<OpsRow[]> {
  return unwrap(await db.from("ops_tracking").select("*"));
}

export async function getOps(invoiceId: string, db: Db = supabase): Promise<OpsRow | null> {
  const res = await db.from("ops_tracking").select("*").eq("invoice_id", invoiceId).maybeSingle();
  if (res.error) throw res.error;
  return res.data;
}

export async function upsertOps(row: OpsUpsert, db: Db = supabase): Promise<OpsRow> {
  return unwrap(
    await db.from("ops_tracking").upsert(row, { onConflict: "invoice_id" }).select().single(),
  );
}

// ---------- hooks ----------

export function useKnowledge() {
  return useQuery({ queryKey: keys.knowledge, queryFn: () => listKnowledge() });
}

export function useInsertKnowledge() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.knowledge, "insert"],
    mutationFn: (ruleText: string) => insertKnowledge(ruleText),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.knowledge }),
  });
}

export function useDeleteKnowledge() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.knowledge, "delete"],
    mutationFn: (id: string) => deleteKnowledge(id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.knowledge }),
  });
}

export function useChatLog() {
  return useQuery({ queryKey: keys.chatLog, queryFn: () => listChatLog() });
}

export function useAppendChatLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.chatLog, "append"],
    mutationFn: (row: ChatLogInsert) => appendChatLog(row),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.chatLog }),
  });
}

export function useDrafts() {
  return useQuery({ queryKey: keys.drafts, queryFn: () => listDrafts() });
}

export function useUpsertDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.drafts, "upsert"],
    mutationFn: (vars: { id?: string; payload: Json }) => upsertDraft(vars),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.drafts }),
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.drafts, "delete"],
    mutationFn: (id: string) => deleteDraft(id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.drafts }),
  });
}

export function useSnapshots() {
  return useQuery({ queryKey: keys.snapshots, queryFn: () => listSnapshots() });
}

export function useUpsertSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.snapshots, "upsert"],
    mutationFn: (vars: { week: string; payload: Json }) => upsertSnapshot(vars),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.snapshots }),
  });
}

export function useAllOps() {
  return useQuery({ queryKey: keys.opsTracking, queryFn: () => listOps() });
}

export function useOps(invoiceId: string) {
  return useQuery({
    queryKey: [...keys.opsTracking, invoiceId],
    queryFn: () => getOps(invoiceId),
  });
}

export function useUpsertOps() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.opsTracking, "upsert"],
    mutationFn: (row: OpsUpsert) => upsertOps(row),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.opsTracking }),
  });
}

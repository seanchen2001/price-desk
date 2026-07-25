// `agent_runs` — journal de corridas del agente autónomo (P2). Mutación por fila,
// Db inyectable (el runner headless pasa el service client). OJO: la tabla nace con
// la migración 0005 (SQL editor); hasta aplicarla, estas funciones fallan RUIDOSO
// ("relation agent_runs does not exist") — error visible, nunca tragado.
import type { Database, Json } from "./database.types";
import { supabase, unwrap, type Db } from "./supabase";

export type AgentRunRow = Database["public"]["Tables"]["agent_runs"]["Row"];
export type AgentRunInsert = Database["public"]["Tables"]["agent_runs"]["Insert"];

export type AgentRunReview = { verdict: "aprobado" | "rechazado"; notas?: string };

export async function insertAgentRun(row: AgentRunInsert, db: Db = supabase): Promise<AgentRunRow> {
  return unwrap(await db.from("agent_runs").insert(row).select().single());
}

export async function listAgentRuns(
  opts: { task?: string; limit?: number } = {},
  db: Db = supabase,
): Promise<AgentRunRow[]> {
  let q = db.from("agent_runs").select("*").order("ts", { ascending: false });
  if (opts.task !== undefined && opts.task !== "") q = q.eq("task", opts.task);
  return unwrap(await q.limit(opts.limit ?? 20));
}

export async function getAgentRun(id: string, db: Db = supabase): Promise<AgentRunRow> {
  return unwrap(await db.from("agent_runs").select("*").eq("id", id).single());
}

/** Veredicto humano sobre una corrida — alimenta las métricas de promoción (M2). */
export async function reviewAgentRun(
  id: string,
  review: AgentRunReview,
  db: Db = supabase,
): Promise<AgentRunRow> {
  const payload: Json = {
    verdict: review.verdict,
    ...(review.notas !== undefined && review.notas !== "" ? { notas: review.notas } : {}),
    ts: new Date().toISOString(),
  };
  return unwrap(
    await db.from("agent_runs").update({ review: payload }).eq("id", id).select().single(),
  );
}

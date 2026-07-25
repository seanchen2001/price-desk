// Runner HEADLESS del agente autónomo (P3/P4) — corre el MISMO cerebro del chat
// (runAgentLoop + executor gateado) fuera del browser, con la política de la escalera:
//
//   npx tsx scripts/agent-run.ts --prompt="¿mejor proveedor para 30 S26?"          (chat, sombra)
//   npx tsx scripts/agent-run.ts --task=qa                                          (QA de precios, sombra)
//   npx tsx scripts/agent-run.ts --task=qa --mode=auto_limited                      (cuando la escalera lo habilite)
//
// Flujo: env → makeServiceDb → buildServerDeps → wrapDepsWithPolicy(journal) →
// system prompt (knowledge con orderNotesByMention) → runAgentLoop / runQaTask →
// agent_runs (si la 0005 ya corrió; si no, avisa y sigue) + chat_log "[agente autónomo]".
import type { Json } from "../src/data/database.types";
import { insertAgentRun } from "../src/data/agentRuns";
import { listCategories, listDepartments } from "../src/data/departments";
import { appendChatLog, listKnowledge } from "../src/data/misc";
import { listModels } from "../src/data/models";
import { listSuppliers } from "../src/data/suppliers";
import { listClients } from "../src/data/clients";
import type { Db } from "../src/data/supabase";
import { orderNotesByMention } from "../src/domain/negotiation";
import { runAgentLoop } from "../src/features/agent/loop";
import {
  DEFAULT_LIMITS,
  wrapDepsWithPolicy,
  type AgentMode,
  type AgentPolicy,
  type PolicyEvent,
} from "../src/features/agent/policy";
import { buildServerDeps } from "../src/features/agent/serverDeps";
import { buildAgentSystem } from "../src/features/agent/tools";
import { makeServiceDb } from "./lib/db";
import { loadDeskEnv } from "./lib/env";
import { makeDirectGeminiFetch } from "./lib/gemini";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function parseMode(raw: string | undefined): AgentMode {
  if (raw === "auto_limited" || raw === "full") return raw;
  return "shadow"; // default: la escalera arranca en sombra
}

/** inserta la corrida; si la tabla no existe (0005 pendiente) avisa y sigue. */
async function persistRun(
  db: Db,
  row: Parameters<typeof insertAgentRun>[0],
): Promise<string | null> {
  try {
    const saved = await insertAgentRun(row, db);
    return saved.id;
  } catch (e) {
    // el error de PostgREST no siempre es instancia de Error → serializar legible
    const msg =
      e instanceof Error
        ? e.message
        : ((e as { message?: string })?.message ?? JSON.stringify(e));
    console.warn(
      `⚠ no pude persistir en agent_runs (${msg}) — ¿falta correr supabase/migrations/0005_agent_runs.sql en el SQL editor?`,
    );
    return null;
  }
}

async function main(): Promise<void> {
  const env = loadDeskEnv();
  const apiKey = env["GEMINI_API_KEY"] ?? "";
  if (apiKey === "") throw new Error("Falta GEMINI_API_KEY en .env / process.env");
  const db = makeServiceDb(env);
  const fetchFn = makeDirectGeminiFetch(apiKey);

  const task = arg("task") ?? "chat";
  const mode = parseMode(arg("mode"));
  const policy: AgentPolicy = { task, mode, limits: DEFAULT_LIMITS };
  const journal: PolicyEvent[] = [];
  const candidatos: Array<{ rawName: string; aliasKey: string; supplierName: string }> = [];
  const rawDeps = buildServerDeps(db, { fetchFn, onCandidates: (items) => candidatos.push(...items) });
  const deps = wrapDepsWithPolicy(rawDeps, policy, (e) => journal.push(e));

  console.log(`— agente autónomo · task=${task} · mode=${mode} —`);

  if (task === "qa") {
    throw new Error("--task=qa llega con P4 (QA de precios)"); // P3: solo chat
  }

  const prompt = arg("prompt") ?? "";
  if (prompt === "") throw new Error('Falta --prompt="..." (o usá --task=qa)');

  // system prompt: mismo contexto que el panel, con la memoria de las partes
  // mencionadas primero (igual que AgentView)
  const [departments, categories, suppliers, models, knowledge, clients] = await Promise.all([
    listDepartments(db),
    listCategories(db),
    listSuppliers(db),
    listModels(db),
    listKnowledge(db),
    listClients(db),
  ]);
  const partyNames = [...suppliers.map((s) => s.name), ...clients.map((c) => c.name)];
  const mentioned = partyNames.filter((n) => prompt.toLowerCase().includes(n.toLowerCase()));
  const system = buildAgentSystem({
    departments: departments.map((d) => d.name),
    categories: categories.map((c) => c.name),
    suppliers: suppliers.filter((s) => s.active).map((s) => s.name),
    modelCount: models.length,
    knowledge: orderNotesByMention(
      knowledge.map((k) => k.rule_text),
      mentioned,
    ),
    activeTab: "Agente autónomo (headless)",
  });

  const res = await runAgentLoop({
    system,
    userText: prompt,
    deps,
    fetchFn,
    ...(mode === "full" ? { confirm: async () => true } : {}),
    onEvent: (e) => {
      if (e.kind === "tool") console.log(`  → ${e.call.name}(${JSON.stringify(e.call.args).slice(0, 120)})`);
      else console.log(`  [${e.kind}] ${e.text.slice(0, 200)}`);
    },
  });

  const metrics = {
    tools: res.executed.length,
    registrados: journal.filter((e) => e.kind === "registrado").length,
    ejecutados: journal.filter((e) => e.kind === "ejecutado").length,
    denegados: journal.filter((e) => e.kind === "denegado_por_politica").length,
  };
  const runId = await persistRun(db, {
    task,
    mode,
    status: res.status,
    findings: null,
    actions: { journal, executed: res.executed, candidatos } as unknown as Json,
    report: res.finalText,
    metrics: metrics as unknown as Json,
  });
  await appendChatLog(
    {
      user_text: `[agente autónomo] ${prompt}`,
      actions: { runId, executed: res.executed } as unknown as Json,
      final_text: res.finalText,
    },
    db,
  );
  console.log(`\n${res.finalText}`);
  console.log(`\nrun_id: ${runId ?? "(no persistido)"} · status: ${res.status} · métricas:`, metrics);
}

main().catch((e: unknown) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});

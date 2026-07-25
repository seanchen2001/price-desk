// Tarea 1 del agente autónomo: QA DE PRECIOS (P4).
// snapshot de la Mesa → runQa (determinístico, domain/qa.ts) → UNA llamada a Flash
// (temp 0 + responseSchema) para triage/priorización/reporte en español → fixes
// propuestos ruteados por el executor GATEADO con política (en sombra: registrados,
// jamás escritos) → resultado listo para agent_runs + chat_log.
import { listAliases } from "../../src/data/aliases";
import { listCategories, listDepartments } from "../../src/data/departments";
import { listModels } from "../../src/data/models";
import { listPrices, listSalePrices, listTiers } from "../../src/data/prices";
import { listSuppliers } from "../../src/data/suppliers";
import type { Db } from "../../src/data/supabase";
import { qaCounts, runQa, type QaFinding } from "../../src/domain/qa";
import { executeTool, type ToolDeps } from "../../src/features/agent/executor";
import { generateText, type FetchLike } from "../../src/features/agent/gemini";
import type { AgentPolicy, PolicyEvent } from "../../src/features/agent/policy";

export type QaFixAttempt = {
  finding_id: string;
  tool: string;
  args: Record<string, unknown>;
  resultado: "propuesto" | "bloqueado_por_gate" | "error";
  detalle?: string;
};

export type QaTaskResult = {
  status: "ok" | "partial";
  report: string;
  findings: QaFinding[];
  fixes: QaFixAttempt[];
  metrics: Record<string, unknown>;
};

const TRIAGE_SCHEMA = {
  type: "OBJECT",
  properties: {
    resumen: { type: "STRING", description: "2-4 frases en español, tono trader." },
    prioridades: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          prioridad: { type: "INTEGER", description: "1 = atender ya, 3 = puede esperar." },
          razon: { type: "STRING" },
        },
        required: ["id", "prioridad"],
      },
    },
  },
  required: ["resumen", "prioridades"],
} as const;

export type QaTriage = {
  resumen: string;
  prioridades: Array<{ id: string; prioridad: number; razon?: string }>;
};

/**
 * UNA llamada LLM para triage. ANTI-ALUCINACIÓN: todo id devuelto que no esté en el
 * input se DESCARTA (el LLM prioriza y redacta; jamás inventa hallazgos).
 */
export async function triageQaFindings(
  findings: readonly QaFinding[],
  fetchFn: FetchLike,
): Promise<QaTriage> {
  const capped = findings.slice(0, 80);
  const text = await generateText(
    {
      system:
        "Sos el auditor de la mesa de precios de un mayorista. Recibís HALLAZGOS ya detectados por código determinístico (JSON). Tu trabajo: priorizarlos y resumir en español, tono trader, corto. REGLAS: usá SOLO los ids provistos (nada de inventar hallazgos ni ids); prioridad 1 = plata en riesgo hoy (lista_below_cost, unit_outlier), 2 = decisiones de compra distorsionadas, 3 = higiene.",
      content: JSON.stringify(capped),
      responseSchema: TRIAGE_SCHEMA,
      maxTokens: 4096,
    },
    fetchFn,
  );
  const parsed = JSON.parse(text) as QaTriage;
  const validIds = new Set(capped.map((f) => f.id));
  return {
    resumen: typeof parsed.resumen === "string" ? parsed.resumen : "",
    prioridades: (Array.isArray(parsed.prioridades) ? parsed.prioridades : []).filter(
      (p) => typeof p.id === "string" && validIds.has(p.id),
    ),
  };
}

const MAX_FIXES = 10;

export async function runQaTask(ctx: {
  db: Db;
  /** deps YA envueltas con la política (sombra/limitado/full) */
  deps: ToolDeps;
  fetchFn: FetchLike;
  policy: AgentPolicy;
  journal: PolicyEvent[];
}): Promise<QaTaskResult> {
  // 1) snapshot determinístico de la Mesa
  const [models, categories, suppliers, prices, tiers, sales, aliases, departments] =
    await Promise.all([
      listModels(ctx.db),
      listCategories(ctx.db),
      listSuppliers(ctx.db),
      listPrices(undefined, ctx.db),
      listTiers(undefined, ctx.db),
      listSalePrices(ctx.db),
      listAliases(undefined, ctx.db),
      listDepartments(ctx.db),
    ]);
  void departments;
  const findings = runQa({
    models,
    categories,
    suppliers,
    prices,
    tiers,
    sales,
    aliases: aliases.map((a) => ({ alias_key: a.alias_key, model_id: a.model_id })),
  });
  const counts = qaCounts(findings);

  // 2) triage LLM (UNA llamada; si falla → fallback determinístico y status partial)
  let triage: QaTriage | null = null;
  let llmError: string | null = null;
  if (findings.length > 0) {
    try {
      triage = await triageQaFindings(findings, ctx.fetchFn);
    } catch (e) {
      llmError = e instanceof Error ? e.message : String(e);
    }
  }

  // 3) fixes propuestos → executor GATEADO con la política (sombra registra, no escribe)
  const fixes: QaFixAttempt[] = [];
  for (const f of findings.filter((x) => x.suggestedFix !== undefined).slice(0, MAX_FIXES)) {
    const fix = f.suggestedFix!;
    try {
      const r = await executeTool({ name: fix.tool, args: fix.args }, ctx.deps);
      fixes.push({
        finding_id: f.id,
        tool: fix.tool,
        args: fix.args,
        resultado: r["bloqueado"] === true ? "bloqueado_por_gate" : r["error"] !== undefined ? "error" : "propuesto",
        ...(r["error"] !== undefined ? { detalle: String(r["error"]) } : {}),
      });
    } catch (e) {
      fixes.push({
        finding_id: f.id,
        tool: fix.tool,
        args: fix.args,
        resultado: "error",
        detalle: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 4) reporte en español
  const prioridadesTxt =
    triage && triage.prioridades.length > 0
      ? triage.prioridades
          .slice(0, 10)
          .sort((a, b) => a.prioridad - b.prioridad)
          .map((p) => {
            const f = findings.find((x) => x.id === p.id);
            return `  P${p.prioridad} · ${f?.detalle ?? p.id}${p.razon ? ` (${p.razon})` : ""}`;
          })
          .join("\n")
      : "  (sin triage LLM)";
  const top = (n: number) =>
    findings
      .slice(0, n)
      .map((f) => `  [${f.severidad}] ${f.tipo} · ${[f.modelo, f.proveedor].filter(Boolean).join(" @ ")} — ${f.detalle}`)
      .join("\n");
  const modo = ctx.policy.mode;
  const report = [
    `QA DE PRECIOS — ${new Date().toISOString().slice(0, 16).replace("T", " ")} · modo ${modo}`,
    `Hallazgos: ${counts.total} (críticos ${counts.por_severidad.critico} · altos ${counts.por_severidad.alto} · medios ${counts.por_severidad.medio} · bajos ${counts.por_severidad.bajo})`,
    `Por tipo: ${Object.entries(counts.por_tipo).map(([t, n]) => `${t}=${n}`).join(" · ") || "—"}`,
    "",
    triage ? `RESUMEN DEL AUDITOR: ${triage.resumen}` : `RESUMEN: ${counts.total} hallazgos determinísticos${llmError ? ` (triage LLM falló: ${llmError})` : ""}.`,
    "",
    "PRIORIDADES:",
    prioridadesTxt,
    "",
    `HALLAZGOS (top ${Math.min(findings.length, 15)}):`,
    top(15),
    "",
    `FIXES PROPUESTOS (${fixes.length}, vía executor gateado, modo ${modo}${modo === "shadow" ? ": REGISTRADOS, nada escrito" : ""}):`,
    fixes.length
      ? fixes
          .map((fx) => `  ${fx.resultado === "propuesto" ? "✓" : fx.resultado === "bloqueado_por_gate" ? "⛔" : "✗"} ${fx.tool}(${JSON.stringify(fx.args)}) [${fx.resultado}]`)
          .join("\n")
      : "  (ninguno automático — el resto es decisión humana)",
  ].join("\n");

  return {
    status: llmError !== null ? "partial" : "ok",
    report,
    findings,
    fixes,
    metrics: {
      ...counts,
      fixes_propuestos: fixes.filter((f) => f.resultado === "propuesto").length,
      fixes_bloqueados: fixes.filter((f) => f.resultado === "bloqueado_por_gate").length,
      journal_registrados: ctx.journal.filter((e) => e.kind === "registrado").length,
      journal_denegados: ctx.journal.filter((e) => e.kind === "denegado_por_politica").length,
    },
  };
}

// P5 — EVAL LIVE (M1: tool-selection del MODELO real): GEMINI_LIVE=1 corre los 12
// escenarios golden contra Gemini con el system prompt y toolset REALES, en DRY-RUN
// (los resultados de tools son sintéticos; nada toca la base). M1 = escenarios OK/total;
// criterio de la escalera: M1 ≥ 95% para promover de sombra.
//
//   GEMINI_LIVE=1 npx vitest run test/agent.live.eval.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { forwardGemini } from "../api/_geminiCore";
import { loadDeskEnv } from "../scripts/lib/env";
import type { GeminiContent, GeminiFunctionCall, GeminiPart } from "../src/features/agent/gemini";
import { AGENT_TOOLS, buildAgentSystem } from "../src/features/agent/tools";
import { callMatches, EVAL_SCENARIOS, mustCallLabel, mustCallSatisfied, type EvalScenario } from "./evals/scenarios";

const env = loadDeskEnv();
const KEY = env["GEMINI_API_KEY"] ?? "";
const LIVE = process.env["GEMINI_LIVE"] === "1" && KEY !== "";
const TIMEOUT = 90_000;

const SYSTEM = buildAgentSystem({
  departments: ["Teléfonos", "iPhone", "Laptops", "Otros"],
  categories: ["Samsung Gama Alta", "Samsung Gama Baja", "Motorola LATIN", "Motorola EURO", "iPhone Último Modelo", "iPhone Otros", "Otros"],
  suppliers: ["Bax", "Planet", "Vitel", "South"],
  modelCount: 96,
  activeTab: "Agente autónomo (eval)",
});

type LiveResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  error?: { message?: string };
};

async function modelTurn(contents: GeminiContent[]): Promise<GeminiPart[]> {
  const out = await forwardGemini(
    { system: SYSTEM, contents, tools: AGENT_TOOLS, maxTokens: 2048 },
    KEY,
  );
  const data = JSON.parse(out.body) as LiveResponse;
  if (out.status !== 200) throw new Error(`Gemini ${out.status}: ${data.error?.message ?? out.body.slice(0, 200)}`);
  return data.candidates?.[0]?.content?.parts ?? [];
}

/** corre un escenario en dry-run: el modelo elige tools, respondemos sintético. */
async function runLiveScenario(scenario: EvalScenario): Promise<GeminiFunctionCall[]> {
  const contents: GeminiContent[] = [];
  const seen: GeminiFunctionCall[] = [];
  // consumo por-tool de las respuestas sintéticas (array = una por llamada)
  const cursors = new Map<string, number>();
  const respond = (call: GeminiFunctionCall): Record<string, unknown> => {
    const list = scenario.toolResponses[call.name];
    if (!list || list.length === 0) return { ok: true, dry_run: true };
    const i = Math.min(cursors.get(call.name) ?? 0, list.length - 1);
    cursors.set(call.name, i + 1);
    return list[i]!;
  };
  for (const msg of scenario.user) {
    contents.push({ role: "user", parts: [{ text: msg }] });
    for (let turn = 0; turn < 5; turn++) {
      const parts = await modelTurn(contents);
      contents.push({ role: "model", parts });
      const calls = parts
        .map((p) => p.functionCall)
        .filter((c): c is GeminiFunctionCall => c !== undefined);
      if (calls.length === 0) break;
      seen.push(...calls);
      contents.push({
        role: "user",
        parts: calls.map((c) => ({ functionResponse: { name: c.name, response: respond(c) } })),
      });
    }
  }
  return seen;
}

const results: Array<{ id: string; ok: boolean; motivo?: string }> = [];

function evaluate(scenario: EvalScenario, calls: GeminiFunctionCall[]): string | null {
  for (const exp of scenario.expect.mustCall) {
    if (!mustCallSatisfied(calls.map((c) => ({ name: c.name, args: c.args ?? {} })), exp)) {
      return `falta ${mustCallLabel(exp)} — llamó: ${calls.map((c) => c.name).join(", ") || "nada"}`;
    }
  }
  for (const banned of scenario.expect.mustNotCall ?? []) {
    if (calls.some((c) => c.name === banned)) return `llamó ${banned} (prohibido)`;
  }
  for (const bw of scenario.expect.mustNotCallWith ?? []) {
    if (calls.some((c) => callMatches({ name: c.name, args: c.args ?? {} }, bw))) {
      return `llamó ${bw.tool} con forma prohibida`;
    }
  }
  return null;
}

describe.skipIf(!LIVE)("P5 — evals LIVE (M1: tool-selection del modelo real, dry-run)", () => {
  for (const scenario of EVAL_SCENARIOS) {
    it(
      `${scenario.id} — ${scenario.descripcion}`,
      async () => {
        const calls = await runLiveScenario(scenario);
        const motivo = evaluate(scenario, calls);
        results.push({ id: scenario.id, ok: motivo === null, ...(motivo ? { motivo } : {}) });
        expect(motivo, `${scenario.id}: ${motivo ?? ""}`).toBeNull();
      },
      TIMEOUT,
    );
  }

  afterAll(() => {
    const passed = results.filter((r) => r.ok).length;
    const m1 = results.length ? (passed / results.length) * 100 : 0;
    console.log(`\n========== M1 (tool-selection) ==========`);
    for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.id}${r.motivo ? ` — ${r.motivo}` : ""}`);
    console.log(`M1 = ${passed}/${results.length} = ${m1.toFixed(1)}%  (criterio escalera: ≥95%)`);
  });
});

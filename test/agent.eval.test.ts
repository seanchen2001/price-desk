// P5 — EVAL OFFLINE (corre en npm test / CI, cero red): replay de los turnos grabados
// de cada escenario golden sobre runAgentLoop + EXECUTOR REAL (mockDeps stateful).
// Valida el arnés de punta a punta: que las secuencias correctas EJECUTAN limpio y que
// los guardrails (gate, typo de proveedor, dry_run) responden como el contrato promete.
import { afterAll, describe, expect, it } from "vitest";
import type { FetchLike, GeminiPart } from "../src/features/agent/gemini";
import { runAgentLoop, type ExecutedCall } from "../src/features/agent/loop";
import type { ToolDeps } from "../src/features/agent/executor";
import { callMatches, EVAL_SCENARIOS, mustCallLabel, mustCallSatisfied, type EvalScenario } from "./evals/scenarios";
import { mockDeps, setAgentRunRows, type MockSeed } from "./helpers/mockDeps";

function scriptedFetch(turns: GeminiPart[][]): FetchLike {
  let i = 0;
  return async () =>
    new Response(
      JSON.stringify({ candidates: [{ content: { role: "model", parts: turns[Math.min(i++, turns.length - 1)] } }] }),
      { status: 200 },
    );
}

// deps por escenario: los de negociación necesitan extracción + seed de precios;
// los de journal necesitan una corrida run-9 en la tabla mock.
const ANALYZE_ITEMS = [
  { rawName: "S26 12+512 5G DS", supplier: "", price: 585, tiers: [] },
  { rawName: "A17 4+128 DS", supplier: "", price: 118, tiers: [] },
];
const SEED: MockSeed = {
  prices: [
    { model_id: "m1", supplier_id: "s-bax", price: 600 },
    { model_id: "m2", supplier_id: "s-vit", price: 110 },
  ],
  tiers: [],
};

function depsFor(scenario: EvalScenario): ToolDeps {
  if (scenario.id === "agent-runs-qa" || scenario.id === "review-aprobado") {
    setAgentRunRows([
      { id: "run-9", ts: "2026-07-25", task: "qa", mode: "shadow", status: "ok", report: "19 hallazgos", metrics: null, review: null },
    ]);
  } else {
    setAgentRunRows([]);
  }
  const needsExtraction = scenario.replay.some((t) =>
    t.some((p) => p.functionCall?.name === "analyze_quote"),
  );
  return needsExtraction
    ? mockDeps({ extractQuote: async () => ANALYZE_ITEMS }, SEED)
    : mockDeps({}, SEED);
}

async function replayScenario(scenario: EvalScenario): Promise<{ executed: ExecutedCall[]; deps: ToolDeps }> {
  const deps = depsFor(scenario);
  const fetchFn = scriptedFetch(scenario.replay);
  const contents: Parameters<typeof runAgentLoop>[0]["contents"] = [];
  const executed: ExecutedCall[] = [];
  for (const msg of scenario.user) {
    const res = await runAgentLoop({ system: "eval", userText: msg, deps, fetchFn, contents });
    expect(res.status, `${scenario.id}: loop no terminó en texto`).toBe("ok");
    executed.push(...res.executed);
  }
  return { executed, deps };
}

const results: Array<{ id: string; ok: boolean }> = [];

describe("P5 — evals OFFLINE (replay + executor real)", () => {
  for (const scenario of EVAL_SCENARIOS) {
    it(`${scenario.id} — ${scenario.descripcion}`, async () => {
      const { executed, deps } = await replayScenario(scenario);
      let ok = true;
      try {
        for (const exp of scenario.expect.mustCall) {
          expect(
            mustCallSatisfied(executed.map((e) => ({ name: e.tool, args: e.args })), exp),
            `${scenario.id}: falta ${mustCallLabel(exp)}`,
          ).toBe(true);
        }
        for (const banned of scenario.expect.mustNotCall ?? []) {
          expect(
            executed.some((e) => e.tool === banned),
            `${scenario.id}: llamó ${banned} (prohibido)`,
          ).toBe(false);
        }
        for (const bannedWith of scenario.expect.mustNotCallWith ?? []) {
          expect(
            executed.some((e) => callMatches({ name: e.tool, args: e.args }, bannedWith)),
            `${scenario.id}: llamó ${bannedWith.tool} con forma prohibida`,
          ).toBe(false);
        }
        // invariantes de compliance del arnés por escenario
        if (scenario.id === "bloqueado-pregunta") {
          expect(executed[0]?.result["bloqueado"]).toBe(true);
          expect(deps.upsertPrice).not.toHaveBeenCalled(); // el gate REAL bloqueó
        }
        if (scenario.id === "force-con-ok") {
          const last = executed.at(-1);
          expect(last?.result["ok"]).toBe(true);
          expect((last?.result["forzado"] as Record<string, unknown>)["reason"]).toMatch(/dólar/);
          expect(deps.upsertPrice).toHaveBeenCalledTimes(1); // solo el force escribió
        }
        if (scenario.id === "escalera-una-tool") {
          expect(deps.setTiersForPair).toHaveBeenCalledTimes(1);
        }
        if (scenario.id === "dry-run-pregunta") {
          expect(deps.applyQuoteEntry).not.toHaveBeenCalled(); // dry_run REAL: cero writes
          expect(executed.at(-1)?.result["dry_run"]).toBe(true);
        }
        if (scenario.id === "typo-proveedor") {
          expect(String(executed[0]?.result["error"])).toMatch(/No existe el proveedor/);
          expect(executed[0]?.result["quisiste_decir"]).toBe("Bax"); // fuzzy REAL
        }
      } catch (e) {
        ok = false;
        throw e;
      } finally {
        results.push({ id: scenario.id, ok });
      }
    });
  }
});

afterAll(() => {
  const passed = results.filter((r) => r.ok).length;
  console.log(
    `\nEVAL OFFLINE (arnés): ${passed}/${results.length} escenarios (${((passed / Math.max(1, results.length)) * 100).toFixed(1)}%) — M1 real se mide con GEMINI_LIVE=1 (agent.live.eval.test.ts)`,
  );
});

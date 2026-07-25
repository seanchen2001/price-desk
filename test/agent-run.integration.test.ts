// P3 — integración SOMBRA contra la base real (env-gated): serverDeps + política shadow
// + runAgentLoop con transporte GUIONADO (cero Gemini). Verifica el contrato completo:
// la corrida "escribe" en overlay, la base REAL queda intacta, y la corrida se persiste
// en agent_runs (si la 0005 ya corrió; si no, se SKIPEA con mensaje claro).
import { describe, expect, it } from "vitest";
import { hasServiceEnv, makeServiceDb } from "../scripts/lib/db";
import { loadDeskEnv } from "../scripts/lib/env";
import type { FetchLike, GeminiPart } from "../src/features/agent/gemini";

const env = loadDeskEnv();

describe.skipIf(!hasServiceEnv(env))("P3 — corrida sombra headless contra la base real", () => {
  it(
    "shadow: cero escrituras reales + journal + agent_runs (si existe la tabla)",
    async () => {
      const db = makeServiceDb(env);
      // gate por tabla: si agent_runs no existe todavía (0005 pendiente en el SQL
      // editor), skip explícito con mensaje — el resto de la suite no depende de ella.
      const probe = await db.from("agent_runs").select("id").limit(1);
      if (probe.error) {
        console.warn(
          `SKIP corrida sombra: tabla agent_runs no disponible (${probe.error.message}). ` +
            "Correr supabase/migrations/0005_agent_runs.sql en el SQL editor y re-correr.",
        );
        return;
      }
      const { buildServerDeps } = await import("../src/features/agent/serverDeps");
      const { wrapDepsWithPolicy, DEFAULT_LIMITS } = await import("../src/features/agent/policy");
      const { runAgentLoop } = await import("../src/features/agent/loop");
      const { insertAgentRun } = await import("../src/data/agentRuns");

      // par real: S26 12+512 5G DS (existe desde Fase 5/9) × primer proveedor con precio
      const model = await db
        .from("models")
        .select("id, canonical_name")
        .eq("canonical_name", "S26 12+512 5G DS")
        .single();
      expect(model.error).toBeNull();
      const pair = await db
        .from("prices")
        .select("supplier_id, price")
        .eq("model_id", model.data!.id)
        .limit(1)
        .single();
      expect(pair.error).toBeNull();
      const supplier = await db
        .from("suppliers")
        .select("id, name")
        .eq("id", pair.data!.supplier_id)
        .single();
      const before = pair.data!.price;
      const target = Math.round(before * 1.05); // +5%: pasa el gate, lo frena la sombra

      const journal: import("../src/features/agent/policy").PolicyEvent[] = [];
      const noFetch: FetchLike = async () => {
        throw new Error("extractQuote no debería llamarse en este test");
      };
      const deps = wrapDepsWithPolicy(
        buildServerDeps(db, { fetchFn: noFetch }),
        { task: "integration", mode: "shadow", limits: DEFAULT_LIMITS },
        (e) => journal.push(e),
      );
      const script: GeminiPart[][] = [
        [
          {
            functionCall: {
              name: "set_price",
              args: { model: "S26 12+512 5G DS", supplier: supplier.data!.name, price: target },
            },
          },
        ],
        [{ text: `simulado: ${supplier.data!.name} a ${target}` }],
      ];
      let i = 0;
      const scripted: FetchLike = async () =>
        new Response(
          JSON.stringify({ candidates: [{ content: { role: "model", parts: script[Math.min(i++, 1)] } }] }),
          { status: 200 },
        );

      const res = await runAgentLoop({
        system: "test de integración sombra",
        userText: "actualizá el precio",
        deps,
        fetchFn: scripted,
      });
      expect(res.status).toBe("ok");
      expect(res.executed[0]?.result["ok"]).toBe(true); // overlay coherente
      expect(
        (res.executed[0]?.result["verificacion"] as { coincide: boolean }).coincide,
      ).toBe(true);
      expect(journal.some((e) => e.kind === "registrado" && e.dep === "upsertPrice")).toBe(true);

      // la base REAL quedó intacta
      const after = await db
        .from("prices")
        .select("price")
        .eq("model_id", model.data!.id)
        .eq("supplier_id", pair.data!.supplier_id)
        .single();
      expect(after.data!.price).toBe(before);

      // journal persistido (y limpiado: fila stampeada de test)
      const saved = await insertAgentRun(
        {
          task: "integration-test",
          mode: "shadow",
          status: res.status,
          actions: { journal, executed: res.executed } as never,
          report: res.finalText,
        },
        db,
      );
      expect(saved.id).toBeTruthy();
      const del = await db.from("agent_runs").delete().eq("id", saved.id);
      expect(del.error).toBeNull();
    },
    30_000,
  );
});

// P3 — runAgentLoop (turn-loop extraído, puro): protocolo completo con transporte
// GUIONADO (cero red) + mockDeps compartido. Cubre: ejecución de tools con
// functionResponse, confirm headless de destructivas, error de transporte ruidoso,
// corte por maxTurns.
import { describe, expect, it } from "vitest";
import type { FetchLike, GeminiPart } from "../src/features/agent/gemini";
import { runAgentLoop, type LoopEvent } from "../src/features/agent/loop";
import { mockDeps } from "./helpers/mockDeps";

/** transporte guionado: devuelve los turnos del "modelo" en orden */
function scriptedFetch(turns: GeminiPart[][]): FetchLike {
  let i = 0;
  return async () => {
    const parts = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return new Response(
      JSON.stringify({ candidates: [{ content: { role: "model", parts } }] }),
      { status: 200 },
    );
  };
}

describe("P3 — runAgentLoop (guionado, sin red)", () => {
  it("ejecuta tools, appendea functionResponse y termina con texto", async () => {
    const deps = mockDeps();
    const events: LoopEvent[] = [];
    const res = await runAgentLoop({
      system: "sys",
      userText: "creá la categoría Samsung Gama Alta",
      deps,
      fetchFn: scriptedFetch([
        [{ functionCall: { name: "create_category", args: { name: "Gama Nueva" } } }],
        [{ text: "Listo, categoría creada." }],
      ]),
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("ok");
    expect(res.finalText).toBe("Listo, categoría creada.");
    expect(res.executed).toHaveLength(1);
    expect(res.executed[0]?.tool).toBe("create_category");
    expect(res.executed[0]?.result["creada"]).toBe(true);
    expect(deps.insertCategory).toHaveBeenCalledWith("Gama Nueva");
    // protocolo: user → model(call) → user(functionResponse) → model(texto)
    const roles = res.contents.map((c) => c.role);
    expect(roles).toEqual(["user", "model", "user", "model"]);
    expect(res.contents[2]?.parts[0]?.functionResponse?.name).toBe("create_category");
    expect(events.some((e) => e.kind === "tool")).toBe(true);
  });

  it("CONFIRM_TOOLS headless: default NO ejecuta (cancelado); confirm inyectado sí", async () => {
    const deps = mockDeps();
    const script: GeminiPart[][] = [
      [{ functionCall: { name: "delete_price", args: { model: "S26 12+512 5G DS", supplier: "Bax" } } }],
      [{ text: "ok" }],
    ];
    const sinConfirm = await runAgentLoop({
      system: "sys",
      userText: "borrá el precio de Bax",
      deps,
      fetchFn: scriptedFetch(script),
    });
    expect(sinConfirm.executed[0]?.result["cancelado"]).toBe(true);
    expect(deps.deletePrice).not.toHaveBeenCalled();

    const conConfirm = await runAgentLoop({
      system: "sys",
      userText: "borrá el precio de Bax",
      deps: mockDeps(),
      fetchFn: scriptedFetch(script),
      confirm: async () => true,
    });
    expect(conConfirm.executed[0]?.result["ok"]).toBe(true);
  });

  it("error de transporte → status 'error' con mensaje visible", async () => {
    const fetchFn: FetchLike = async () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    const res = await runAgentLoop({ system: "s", userText: "x", deps: mockDeps(), fetchFn });
    expect(res.status).toBe("error");
    expect(res.finalText).toMatch(/Gemini 500: boom/);
  });

  it("maxTurns agotado → status 'partial' y nota de corte", async () => {
    const res = await runAgentLoop({
      system: "s",
      userText: "loop",
      deps: mockDeps(),
      fetchFn: scriptedFetch([
        [{ functionCall: { name: "get_mesa_summary", args: {} } }], // siempre llama
      ]),
      maxTurns: 3,
    });
    expect(res.status).toBe("partial");
    expect(res.executed).toHaveLength(3);
    expect(res.finalText).toMatch(/demasiadas iteraciones/);
  });

  it("las tools con error no cortan el loop: el error viaja como functionResponse", async () => {
    const res = await runAgentLoop({
      system: "s",
      userText: "x",
      deps: mockDeps(),
      fetchFn: scriptedFetch([
        [{ functionCall: { name: "set_price", args: { model: "NoExiste", supplier: "Bax", price: 1 } } }],
        [{ text: "no encontré el modelo" }],
      ]),
    });
    expect(res.status).toBe("ok");
    expect(String(res.executed[0]?.result["error"])).toMatch(/No encontré el modelo/);
  });
});

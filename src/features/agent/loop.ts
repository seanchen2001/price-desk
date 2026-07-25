// Turn-loop del agente EXTRAÍDO a función pura (P3) — el mismo protocolo que corre
// AgentView (generateTurn → functionCalls → executeTool → functionResponse → repetir),
// pero inyectable de punta a punta: transporte (fetchFn), deps (política incluida) y
// confirmación de destructivas. AgentView NO se toca todavía (migrarlo es tarea futura);
// este loop es el runtime del agente AUTÓNOMO headless (scripts/agent-run.ts).
//
// Confirm headless por default: las CONFIRM_TOOLS NO se ejecutan (resultado
// {cancelado, nota}) — la política además las registra; en modo full el runner puede
// inyectar confirm: async () => true.
import { executeTool, type ToolCall, type ToolResult, type ToolDeps } from "./executor";
import {
  functionCallsOf,
  generateTurn,
  textOf,
  type FetchLike,
  type GeminiContent,
} from "./gemini";
import { AGENT_TOOLS, CONFIRM_TOOLS } from "./tools";

export const LOOP_MAX_TURNS = 8;

export type LoopEvent =
  | { kind: "agent"; text: string }
  | { kind: "tool"; call: ToolCall; result: ToolResult }
  | { kind: "error"; text: string };

export type ExecutedCall = { tool: string; args: Record<string, unknown>; result: ToolResult };

export type AgentLoopOptions = {
  system: string;
  userText: string;
  deps: ToolDeps;
  /** transporte: browser = proxy /api/gemini; headless = makeDirectGeminiFetch */
  fetchFn?: FetchLike;
  /** conversación previa (se extiende in place); omitir = conversación nueva */
  contents?: GeminiContent[];
  maxTurns?: number;
  /** decisión sobre CONFIRM_TOOLS; default headless: NO ejecutar */
  confirm?: (call: ToolCall) => Promise<boolean>;
  onEvent?: (event: LoopEvent) => void;
};

export type AgentLoopResult = {
  finalText: string;
  executed: ExecutedCall[];
  contents: GeminiContent[];
  /** ok = terminó con texto; partial = se cortó por maxTurns; error = transporte/fatal */
  status: "ok" | "partial" | "error";
};

/** Ejecuta una tool sin tirar: el error vuelve como resultado visible (y para el modelo). */
async function runSafely(call: ToolCall, deps: ToolDeps): Promise<ToolResult> {
  try {
    return await executeTool(call, deps);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const contents = opts.contents ?? [];
  const maxTurns = opts.maxTurns ?? LOOP_MAX_TURNS;
  const confirm = opts.confirm ?? (async () => false);
  const emit = (event: LoopEvent): void => opts.onEvent?.(event);

  contents.push({ role: "user", parts: [{ text: opts.userText }] });
  const executed: ExecutedCall[] = [];
  let finalText = "";
  let status: AgentLoopResult["status"] = "partial";

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const content = await generateTurn(
        { system: opts.system, contents, tools: AGENT_TOOLS, maxTokens: 4096 },
        opts.fetchFn,
      );
      contents.push(content);
      const calls = functionCallsOf(content);
      const turnText = textOf(content);
      if (calls.length === 0) {
        finalText = turnText || "(sin respuesta)";
        status = "ok";
        emit({ kind: "agent", text: finalText });
        break;
      }
      if (turnText) emit({ kind: "agent", text: turnText });

      const responseParts: GeminiContent["parts"] = [];
      for (const fc of calls) {
        const call: ToolCall = { name: fc.name, args: fc.args ?? {} };
        let result: ToolResult;
        if (CONFIRM_TOOLS.has(call.name)) {
          result = (await confirm(call))
            ? await runSafely(call, opts.deps)
            : {
                cancelado: true,
                nota: "Tool destructiva sin confirmación humana en este runtime — quedó registrada, no ejecutada.",
              };
        } else {
          result = await runSafely(call, opts.deps);
        }
        if (result["error"] !== undefined) emit({ kind: "error", text: `${call.name}: ${String(result["error"])}` });
        emit({ kind: "tool", call, result });
        executed.push({ tool: call.name, args: call.args, result });
        responseParts.push({ functionResponse: { name: call.name, response: result } });
      }
      contents.push({ role: "user", parts: responseParts });
      if (turn === maxTurns - 1) {
        finalText = "(corté la corrida: demasiadas iteraciones de tools)";
        emit({ kind: "error", text: finalText });
      }
    }
  } catch (e) {
    finalText = e instanceof Error ? e.message : String(e);
    status = "error";
    emit({ kind: "error", text: finalText });
  }
  return { finalText, executed, contents, status };
}

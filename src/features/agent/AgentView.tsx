// Tab "Agente" (Fase 8) — chat con tools tipadas (estilo ChatBox viejo, sin supervisor).
// El modelo PROPONE tool calls; executeTool las ejecuta CLIENT-side vía la capa de datos
// (mutaciones por fila, identidad por resolveModel). Destructivas → confirmación UI.
// Errores VISIBLES en el chat y timeout ruidoso a 30s (transporte). Cada turno queda
// en chat_log (append por fila).
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Json } from "../../data/database.types";
import { useCategories, useDepartments } from "../../data/departments";
import { keys } from "../../data/keys";
import { useAppendChatLog, useKnowledge } from "../../data/misc";
import { useModels } from "../../data/models";
import { useSuppliers } from "../../data/suppliers";
import s from "../mesa/styles";
import { executeTool, type ToolCall, type ToolResult } from "./executor";
import { functionCallsOf, generateTurn, textOf, type GeminiContent } from "./gemini";
import { buildLiveDeps } from "./liveDeps";
import { AGENT_TOOLS, buildAgentSystem, CONFIRM_TOOLS, MUTATING_TOOLS } from "./tools";

const MAX_TURNS = 8;

type ChatMsg =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string };

type PendingConfirm = { call: ToolCall; resolve: (ok: boolean) => void };

const chatStyles = {
  log: {
    background: "#0d1119",
    border: "1px solid #1c2433",
    borderRadius: 8,
    padding: 10,
    height: "52vh",
    overflowY: "auto" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },
  user: { color: "#e6ebf5", fontSize: 12.5, whiteSpace: "pre-wrap" as const },
  agent: { color: "#9fd3a8", fontSize: 12.5, whiteSpace: "pre-wrap" as const },
  tool: { color: "#6b7385", fontSize: 11, fontFamily: "monospace" },
  error: { color: "#f87171", fontSize: 12 },
  confirm: {
    background: "#1a1410",
    border: "1px solid #5a4a1d",
    borderRadius: 8,
    padding: "8px 10px",
    marginTop: 8,
  },
} as const;

function argsPreview(args: Record<string, unknown>): string {
  const j = JSON.stringify(args);
  return j.length > 140 ? j.slice(0, 140) + "…" : j;
}

export function AgentView() {
  const departments = useDepartments();
  const categories = useCategories();
  const suppliers = useSuppliers();
  const models = useModels();
  const knowledge = useKnowledge();
  const appendLog = useAppendChatLog();
  const qc = useQueryClient();

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const contentsRef = useRef<GeminiContent[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending]);

  const push = (m: ChatMsg) => setMessages((prev) => [...prev, m]);

  const askConfirm = (call: ToolCall): Promise<boolean> =>
    new Promise<boolean>((resolve) => setPending({ call, resolve }));

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    push({ kind: "user", text });

    const system = buildAgentSystem({
      departments: (departments.data ?? []).map((d) => d.name),
      categories: (categories.data ?? []).map((c) => c.name),
      suppliers: (suppliers.data ?? []).filter((sp) => sp.active).map((sp) => sp.name),
      modelCount: (models.data ?? []).length,
      knowledge: (knowledge.data ?? []).map((k) => k.rule_text),
    });
    const deps = buildLiveDeps();
    const contents = contentsRef.current;
    contents.push({ role: "user", parts: [{ text }] });

    const executed: Array<{ tool: string; args: Record<string, unknown>; result: ToolResult }> = [];
    let finalText = "";
    let mutated = false;
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const content = await generateTurn({
          system,
          contents,
          tools: AGENT_TOOLS,
          maxTokens: 4096,
        });
        contents.push(content);
        const calls = functionCallsOf(content);
        const turnText = textOf(content);
        if (calls.length === 0) {
          finalText = turnText || "(sin respuesta)";
          push({ kind: "agent", text: finalText });
          break;
        }
        if (turnText) push({ kind: "agent", text: turnText });

        const responseParts: GeminiContent["parts"] = [];
        for (const fc of calls) {
          const call: ToolCall = { name: fc.name, args: fc.args ?? {} };
          let result: ToolResult;
          if (CONFIRM_TOOLS.has(call.name)) {
            push({
              kind: "tool",
              text: `⚠ ${call.name}(${argsPreview(call.args)}) — esperando confirmación…`,
            });
            const ok = await askConfirm(call);
            if (ok) {
              result = await runSafely(call, deps);
              if (MUTATING_TOOLS.has(call.name) && result["error"] === undefined) mutated = true;
            } else {
              result = { cancelado: true, nota: "El usuario NO confirmó; no se ejecutó." };
            }
          } else {
            push({ kind: "tool", text: `→ ${call.name}(${argsPreview(call.args)})` });
            result = await runSafely(call, deps);
            if (MUTATING_TOOLS.has(call.name) && result["error"] === undefined) mutated = true;
          }
          if (result["error"] !== undefined) {
            push({ kind: "error", text: `${call.name}: ${String(result["error"])}` });
          }
          executed.push({ tool: call.name, args: call.args, result });
          responseParts.push({ functionResponse: { name: call.name, response: result } });
        }
        contents.push({ role: "user", parts: responseParts });
        if (turn === MAX_TURNS - 1) {
          finalText = "(corté el turno: demasiadas iteraciones de tools)";
          push({ kind: "error", text: finalText });
        }
      }
    } catch (e) {
      finalText = e instanceof Error ? e.message : String(e);
      push({ kind: "error", text: finalText });
    } finally {
      setBusy(false);
      setPending(null);
      if (mutated) {
        void Promise.all([
          qc.invalidateQueries({ queryKey: keys.models }),
          qc.invalidateQueries({ queryKey: keys.aliases() }),
          qc.invalidateQueries({ queryKey: keys.categories }),
          qc.invalidateQueries({ queryKey: keys.departments }),
          qc.invalidateQueries({ queryKey: keys.suppliers }),
          qc.invalidateQueries({ queryKey: keys.prices() }),
          qc.invalidateQueries({ queryKey: keys.priceTiers() }),
          qc.invalidateQueries({ queryKey: keys.salePrices }),
          qc.invalidateQueries({ queryKey: keys.priceHistory() }),
        ]);
      }
      appendLog.mutate({
        user_text: text,
        actions: executed as unknown as Json,
        final_text: finalText,
      });
    }
  };

  const reset = () => {
    contentsRef.current = [];
    setMessages([]);
    setPending(null);
  };

  return (
    <div>
      <section style={s.section}>
        <div style={s.sectionTitle}>
          Agente (Gemini 2.5 Flash + tools tipadas) — propone; el código ejecuta vía el
          resolvedor y las mutaciones por fila. Destructivas piden confirmación.
        </div>

        <div style={chatStyles.log} ref={scrollRef}>
          {messages.length === 0 && (
            <div style={s.hint}>
              Ej.: “creá la categoría Samsung Gama Alta y mové el S26 ahí” · “cargá S26 12+512
              a 610 de Bax con escala 20→605 50→595” · “¿cómo vienen las cuentas?” · “¿mejor
              proveedor para 30 S26?”
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={chatStyles[m.kind]}>
              {m.kind === "user" ? "» " : ""}
              {m.text}
            </div>
          ))}
          {busy && !pending && <div style={s.hint}>pensando…</div>}
        </div>

        {pending && (
          <div style={chatStyles.confirm}>
            <div style={{ fontSize: 12, color: "#e6c98b", marginBottom: 6 }}>
              El agente quiere ejecutar una acción destructiva:
              <code style={{ marginLeft: 6 }}>
                {pending.call.name}({argsPreview(pending.call.args)})
              </code>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={s.primaryBtn}
                onClick={() => {
                  pending.resolve(true);
                  setPending(null);
                }}
              >
                Ejecutar
              </button>
              <button
                style={{ ...s.toolBtn, ...s.toolBtnGhost }}
                onClick={() => {
                  pending.resolve(false);
                  setPending(null);
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void send()}
            placeholder="Pedile algo al agente… (Enter para enviar)"
            style={{ ...s.textInput, flex: 1 }}
            disabled={busy}
          />
          <button
            onClick={() => void send()}
            disabled={busy || !input.trim()}
            style={{ ...s.primaryBtn, ...(busy ? s.busy : {}) }}
          >
            {busy ? "Trabajando…" : "Enviar"}
          </button>
          <button onClick={reset} style={{ ...s.toolBtn, ...s.toolBtnGhost }} disabled={busy}>
            Nueva conversación
          </button>
        </div>
      </section>
    </div>
  );
}

/** Ejecuta una tool sin tirar: el error vuelve como resultado visible (y para el modelo). */
async function runSafely(
  call: ToolCall,
  deps: ReturnType<typeof buildLiveDeps>,
): Promise<ToolResult> {
  try {
    return await executeTool(call, deps);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

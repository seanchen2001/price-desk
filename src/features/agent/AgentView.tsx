// Panel LATERAL del agente (Fase 8) — paridad con el ChatBox del viejo: vive colapsable
// a la derecha, disponible desde TODOS los tabs (la vista principal se encoge por flex).
// Siempre MONTADO (display:none al colapsar) para que la conversación sobreviva al
// abrir/cerrar; el estado abierto/cerrado persiste en localStorage (store.ts).
//
// El motor no cambia respecto de Fase 8: el modelo PROPONE tool calls; executeTool las
// ejecuta CLIENT-side vía la capa de datos (mutaciones por fila, identidad por
// resolveModel). Destructivas → confirmación UI. Errores VISIBLES, timeout ruidoso 30s,
// log por turno en chat_log. Recibe el tab activo para contextualizar pedidos ambiguos.
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
import { useAgentPanel } from "./store";
import { AGENT_TOOLS, buildAgentSystem, CONFIRM_TOOLS, MUTATING_TOOLS } from "./tools";

const MAX_TURNS = 8;

type ChatMsg =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string };

type PendingConfirm = { call: ToolCall; resolve: (ok: boolean) => void };

const chatStyles = {
  aside: {
    width: 372,
    flexShrink: 0,
    position: "sticky" as const,
    top: 10,
    alignSelf: "flex-start" as const,
    background: "#0b0f17",
    border: "1px solid #1c2433",
    borderRadius: 10,
    padding: 10,
    flexDirection: "column" as const,
    gap: 8,
    maxHeight: "calc(100vh - 24px)",
  },
  head: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 12,
    fontWeight: 700,
    color: "#8ea0bf",
    letterSpacing: 0.4,
  },
  collapse: {
    background: "transparent",
    border: "none",
    color: "#8b94a7",
    cursor: "pointer",
    fontSize: 13,
  },
  reopen: {
    position: "fixed" as const,
    right: 0,
    top: "45%",
    zIndex: 50,
    background: "#1d2A44",
    color: "#e6ebf5",
    border: "1px solid #3b4a68",
    borderRight: "none",
    borderRadius: "8px 0 0 8px",
    padding: "10px 6px",
    cursor: "pointer",
    fontSize: 12,
    writingMode: "vertical-rl" as const,
  },
  log: {
    background: "#0d1119",
    border: "1px solid #1c2433",
    borderRadius: 8,
    padding: 10,
    flex: 1,
    minHeight: 220,
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
  },
} as const;

function argsPreview(args: Record<string, unknown>): string {
  const j = JSON.stringify(args);
  return j.length > 140 ? j.slice(0, 140) + "…" : j;
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

export function AgentPanel(props: { activeTabLabel: string }) {
  const open = useAgentPanel((st) => st.open);
  const setOpen = useAgentPanel((st) => st.setOpen);

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
      activeTab: props.activeTabLabel,
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
    <>
      {!open && (
        <button onClick={() => setOpen(true)} style={chatStyles.reopen} title="Abrir el asistente">
          💬 ASISTENTE
        </button>
      )}
      {/* siempre montado: display none al colapsar conserva la conversación */}
      <aside style={{ ...chatStyles.aside, display: open ? "flex" : "none" }}>
        <div style={chatStyles.head}>
          <span>💬 ASISTENTE</span>
          <span style={{ fontWeight: 400, color: "#5b657a", fontSize: 10.5 }}>
            mirando: {props.activeTabLabel}
          </span>
          <button
            onClick={() => setOpen(false)}
            title="Colapsar hacia la derecha"
            style={chatStyles.collapse}
          >
            ▶
          </button>
        </div>

        <div style={chatStyles.log} ref={scrollRef}>
          {messages.length === 0 && (
            <div style={s.hint}>
              Tools tipadas sobre la base real (el agente propone; el código ejecuta vía el
              resolvedor). Ej.: “creá la categoría Samsung Gama Alta y mové el S26 ahí” ·
              “cargá S26 12+512 a 610 de Bax con escala 20→605 50→595” · “¿cómo vienen las
              cuentas?” · “¿mejor proveedor para 30 S26?”
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
              Acción destructiva propuesta:
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

        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void send()}
            placeholder="Pedile algo… (Enter envía)"
            style={{ ...s.textInput, flex: 1, minWidth: 0 }}
            disabled={busy}
          />
          <button
            onClick={() => void send()}
            disabled={busy || !input.trim()}
            style={{ ...s.primaryBtn, ...(busy ? s.busy : {}) }}
          >
            {busy ? "…" : "Enviar"}
          </button>
          <button
            onClick={reset}
            style={{ ...s.toolBtn, ...s.toolBtnGhost }}
            disabled={busy}
            title="Nueva conversación"
          >
            ⟲
          </button>
        </div>
      </aside>
    </>
  );
}

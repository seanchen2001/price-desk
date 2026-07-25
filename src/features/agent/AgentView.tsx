// Panel LATERAL del agente — VISUAL 1:1 con el ChatBox del viejo (styles.js): aside
// FIJO a la derecha (360px, #0f1420, borde #22304a) que se desliza con translateX al
// colapsar (el shell corre el contenido con padding-right), pestaña vertical
// "💬 ASISTENTE" para reabrir, burbujas agYou/agBot y tools en itálica gris.
// Siempre MONTADO → la conversación sobrevive al abrir/cerrar; open persiste (store.ts).
//
// El motor no cambia respecto de Fase 8: el modelo PROPONE tool calls; executeTool las
// ejecuta CLIENT-side vía la capa de datos (mutaciones por fila, identidad por
// resolveModel). Destructivas → confirmación UI. Errores VISIBLES, timeout ruidoso 30s,
// log por turno en chat_log. Recibe el tab activo para contextualizar pedidos ambiguos.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Json } from "../../data/database.types";
import { useClients } from "../../data/clients";
import { useCategories, useDepartments } from "../../data/departments";
import { keys } from "../../data/keys";
import { useAppendChatLog, useKnowledge } from "../../data/misc";
import { useModels } from "../../data/models";
import { useSuppliers } from "../../data/suppliers";
import { orderNotesByMention } from "../../domain/negotiation";
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
  const clients = useClients();
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

    // memoria del negociador: SIEMPRE va toda; si el mensaje menciona un proveedor o
    // cliente, sus notas van PRIMERO (el agente negocia con el contexto de la casa)
    const partyNames = [
      ...(suppliers.data ?? []).map((sp) => sp.name),
      ...(clients.data ?? []).map((c) => c.name),
    ];
    const mentioned = partyNames.filter((n) => text.toLowerCase().includes(n.toLowerCase()));
    const system = buildAgentSystem({
      departments: (departments.data ?? []).map((d) => d.name),
      categories: (categories.data ?? []).map((c) => c.name),
      suppliers: (suppliers.data ?? []).filter((sp) => sp.active).map((sp) => sp.name),
      modelCount: (models.data ?? []).length,
      knowledge: orderNotesByMention(
        (knowledge.data ?? []).map((k) => k.rule_text),
        mentioned,
      ),
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
          qc.invalidateQueries({ queryKey: keys.knowledge }),
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
        <button onClick={() => setOpen(true)} style={s.chatReopen} title="Abrir el asistente">
          💬 ASISTENTE
        </button>
      )}
      {/* siempre montado: translateX al colapsar (como el viejo) conserva la conversación */}
      <aside style={{ ...s.chatBox, transform: open ? "none" : "translateX(100%)" }}>
        <div style={s.chatHead}>
          <span>💬 ASISTENTE</span>
          <span style={{ fontWeight: 400, color: "#6b7385", fontSize: 10, letterSpacing: 0 }}>
            mirando: {props.activeTabLabel}
          </span>
          <button
            onClick={() => setOpen(false)}
            title="Colapsar hacia la derecha"
            style={s.chatCollapse}
          >
            ▶
          </button>
        </div>

        <div style={s.chatResults} ref={scrollRef}>
          {messages.length === 0 && (
            <div style={s.chatEmpty}>
              Tools tipadas sobre la base real (el agente propone; el código ejecuta vía el
              resolvedor). Ej.: “creá la categoría Samsung Gama Alta y mové el S26 ahí” ·
              “cargá S26 12+512 a 610 de Bax con escala 20→605 50→595” · pegá una lista de
              proveedor para cargarla · “¿mejor proveedor para 30 S26?”
            </div>
          )}
          {messages.map((m, i) =>
            m.kind === "user" ? (
              <div key={i} style={s.agYou}>
                {m.text}
              </div>
            ) : m.kind === "agent" ? (
              <div key={i} style={s.agBot}>
                {m.text}
              </div>
            ) : m.kind === "tool" ? (
              <div key={i} style={s.agTool}>
                {m.text}
              </div>
            ) : (
              <div key={i} style={{ ...s.errorMsg, marginTop: 0 }}>
                {m.text}
              </div>
            ),
          )}
          {busy && !pending && <div style={s.agTool}>pensando…</div>}
        </div>

        {pending && (
          <div style={s.newWrap}>
            <div style={{ fontSize: 11.5, color: "#6fa8e6", fontWeight: 600, marginBottom: 8 }}>
              Acción destructiva propuesta:
              <code style={{ marginLeft: 6, color: "#fbbf24" }}>
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

        <div style={s.chatInputWrap}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void send()}
              placeholder="Pedile algo… (Enter envía)"
              style={{ ...s.chatInput, flex: 1, minWidth: 0 }}
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
              style={s.chatCollapse}
              disabled={busy}
              title="Nueva conversación"
            >
              ⟲
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

// P5 — Escenarios GOLDEN de evaluación del agente (compartidos por el eval OFFLINE
// (replay + executor real sobre mockDeps; corre en CI) y el eval LIVE (GEMINI_LIVE,
// dry-run: el modelo real elige tools, los resultados son sintéticos). Producen M1
// (tool-selection correcta) — el guardián de la escalera de confianza.
import type { GeminiPart } from "../../src/features/agent/gemini";

export type ArgCheck = {
  key: string;
  equals?: unknown;
  /** regex (source) contra el valor (JSON si no es string) */
  matches?: string;
  /** regex que NO debe matchear */
  notMatches?: string;
  truthy?: boolean;
  /** el valor (string) NO debe estar vacío */
  nonEmpty?: boolean;
};

export type CallExpect = { tool: string; args?: ArgCheck[] };
/** expectativa con formas EQUIVALENTES aceptadas (ej. all+except ≡ models explícitos) */
export type MustCall = CallExpect | { anyOf: CallExpect[] };

export type EvalScenario = {
  id: string;
  descripcion: string;
  /** mensajes del usuario en orden (cada uno corre hasta turno de texto) */
  user: string[];
  /** respuestas sintéticas por tool para el LIVE (array = se consume por llamada) */
  toolResponses: Record<string, Array<Record<string, unknown>>>;
  expect: {
    mustCall: MustCall[];
    mustNotCall?: string[];
    /** llamadas PROHIBIDAS con esa forma (ej. set_price con force sin OK) */
    mustNotCallWith?: CallExpect[];
  };
  /** guion del modelo para el replay OFFLINE (secuencia global de turnos) */
  replay: GeminiPart[][];
};

export function checkArgs(args: Record<string, unknown>, checks: readonly ArgCheck[]): boolean {
  return checks.every((c) => {
    const v = args[c.key];
    if (c.equals !== undefined && JSON.stringify(v) !== JSON.stringify(c.equals)) return false;
    const asText = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
    // arrays/objetos se matchean por su JSON (ej. tiers=[{price:595}] matchea "595")
    if (c.matches !== undefined && !new RegExp(c.matches, "i").test(asText)) return false;
    if (c.notMatches !== undefined && new RegExp(c.notMatches, "i").test(asText)) return false;
    if (c.truthy === true && v !== true) return false;
    if (c.nonEmpty === true && String(v ?? "").trim() === "") return false;
    return true;
  });
}

/** una llamada matchea la expectativa (tool + arg checks) */
export function callMatches(
  call: { name: string; args?: Record<string, unknown> },
  exp: CallExpect,
): boolean {
  return call.name === exp.tool && checkArgs(call.args ?? {}, exp.args ?? []);
}

/** una llamada satisface un MustCall (directo o cualquiera de sus formas equivalentes) */
export function mustCallSatisfied(
  calls: ReadonlyArray<{ name: string; args?: Record<string, unknown> }>,
  exp: MustCall,
): boolean {
  const variants = "anyOf" in exp ? exp.anyOf : [exp];
  return variants.some((v) => calls.some((c) => callMatches(c, v)));
}

export function mustCallLabel(exp: MustCall): string {
  const variants = "anyOf" in exp ? exp.anyOf : [exp];
  return variants.map((v) => `${v.tool}(${JSON.stringify(v.args ?? [])})`).join(" | ");
}

const LISTA_PLANET = "te paso la lista de Planet:\nS26 12+512 5G DS 585\nA17 4+128 DS 118";

const ANALYSIS_RESPONSE: Record<string, unknown> = {
  proveedor: "Planet",
  resumen: { oportunidades: 1, en_linea: 0, caras: 1, sin_referencia: 0, frase: "1 oportunidad — aplicala; 1 cara — pedí mejora" },
  lineas: [
    { modelo: "S26 12+512 5G DS", precio: 585, clasificacion: "oportunidad", vs_min_pct: -2.5, min: { precio: 600, proveedor: "Bax" } },
    { modelo: "A17 4+128 DS", precio: 118, clasificacion: "caro", vs_min_pct: 7.3, min: { precio: 110, proveedor: "Vitel" } },
  ],
  nuevos_en_cola: [],
  nota: "NADA se aplicó: quedó en la mesa de negociación.",
};

const fc = (name: string, args: Record<string, unknown>): GeminiPart => ({
  functionCall: { name, args },
});
const txt = (text: string): GeminiPart => ({ text });

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    id: "analyze-lista",
    descripcion: "lista pegada → analyze_quote con el texto COMPLETO (no aplica nada)",
    user: [LISTA_PLANET],
    toolResponses: { analyze_quote: [ANALYSIS_RESPONSE] },
    expect: {
      mustCall: [
        { tool: "analyze_quote", args: [{ key: "supplier", matches: "planet" }, { key: "text", matches: "585" }] },
      ],
      mustNotCall: ["apply_lines", "set_price", "load_quote"],
    },
    replay: [
      [fc("analyze_quote", { supplier: "Planet", text: LISTA_PLANET })],
      [txt("Analizada: 1 oportunidad (S26 −2.5%), 1 cara (A17 +7.3%). ¿Aplico algo?")],
    ],
  },
  {
    id: "apply-oportunidades",
    descripcion: "'aplicá solo las oportunidades' → apply_lines por clasificación",
    user: [LISTA_PLANET, "dale, aplicá solo las oportunidades"],
    toolResponses: {
      analyze_quote: [ANALYSIS_RESPONSE],
      apply_lines: [{ proveedor: "Planet", aplicadas: [{ modelo: "S26 12+512 5G DS", precio: 585 }], bloqueadas: [], quedan_en_mesa: 1, verificacion: { coincide: true } }],
    },
    expect: {
      mustCall: [{ tool: "apply_lines", args: [{ key: "classification", equals: "oportunidad" }] }],
      mustNotCall: ["set_price"],
    },
    replay: [
      [fc("analyze_quote", { supplier: "Planet", text: LISTA_PLANET })],
      [txt("1 oportunidad y 1 cara. ¿Aplico?")],
      [fc("apply_lines", { classification: "oportunidad" })],
      [txt("Aplicada la oportunidad; la cara sigue en la mesa.")],
    ],
  },
  {
    id: "apply-todo-menos",
    descripcion: "'todo menos el A17' → apply_lines all+except (selector, no de a uno)",
    user: [LISTA_PLANET, "aplicá todo menos el A17"],
    toolResponses: {
      analyze_quote: [ANALYSIS_RESPONSE],
      apply_lines: [{ proveedor: "Planet", aplicadas: [{ modelo: "S26 12+512 5G DS", precio: 585 }], bloqueadas: [], quedan_en_mesa: 1, verificacion: { coincide: true } }],
    },
    expect: {
      mustCall: [
        {
          anyOf: [
            // forma canónica: todo menos A17…
            { tool: "apply_lines", args: [{ key: "all", truthy: true }, { key: "except", matches: "a17" }] },
            // …o los selectores EQUIVALENTES: except solo (implica all) o modelos explícitos
            { tool: "apply_lines", args: [{ key: "except", matches: "a17" }] },
            { tool: "apply_lines", args: [{ key: "models", matches: "s26" }, { key: "models", notMatches: "a17" }] },
          ],
        },
      ],
      mustNotCall: ["set_price"],
    },
    replay: [
      [fc("analyze_quote", { supplier: "Planet", text: LISTA_PLANET })],
      [txt("Analizada. ¿Aplico?")],
      [fc("apply_lines", { all: true, except: ["A17"] })],
      [txt("Aplicado todo menos el A17.")],
    ],
  },
  {
    id: "bloqueado-pregunta",
    descripcion: "gate bloquea → mostrar flags y PREGUNTAR (jamás auto-force)",
    user: ["cargá el S26 12+512 5G DS a 61 de Bax"],
    toolResponses: {
      set_price: [
        { bloqueado: true, flags: [{ motivo: "posible error de unidad: ~1/10 del Mín actual del modelo ($600)", sugerencia: 610 }], nota: "NO escribí nada." },
      ],
    },
    expect: {
      mustCall: [{ tool: "set_price", args: [{ key: "price", equals: 61 }] }],
      mustNotCallWith: [{ tool: "set_price", args: [{ key: "force", truthy: true }] }],
    },
    replay: [
      [fc("set_price", { model: "S26 12+512 5G DS", supplier: "Bax", price: 61 })],
      [txt("🚩 61 parece 1/10 del mín actual ($600): ¿era $610?")],
    ],
  },
  {
    id: "force-con-ok",
    descripcion: "bloqueo → OK explícito del usuario → force:true con reason NO inventado",
    user: ["cargá el S26 12+512 5G DS a 720 de Bax", "sí, forzalo: subió de verdad por el dólar"],
    toolResponses: {
      set_price: [
        { bloqueado: true, flags: [{ motivo: "+20% vs el precio anterior de este proveedor ($600)" }], nota: "NO escribí nada." },
        { ok: true, precio: 720, verificacion: { leido: { precio: 720 }, coincide: true }, forzado: { reason: "…" } },
      ],
    },
    expect: {
      mustCall: [
        { tool: "set_price", args: [{ key: "price", equals: 720 }] },
        { tool: "set_price", args: [{ key: "force", truthy: true }, { key: "reason", nonEmpty: true }] },
      ],
    },
    replay: [
      [fc("set_price", { model: "S26 12+512 5G DS", supplier: "Bax", price: 720 })],
      [txt("🚩 +20% vs su precio anterior ($600). ¿Lo fuerzo?")],
      [fc("set_price", { model: "S26 12+512 5G DS", supplier: "Bax", price: 720, force: true, reason: "usuario confirma suba real por el dólar" })],
      [txt("Cargado a $720 (forzado con tu OK).")],
    ],
  },
  {
    id: "typo-proveedor",
    descripcion: "proveedor con typo → preguntar por el existente, JAMÁS crear uno nuevo",
    user: ["cargá esta lista de Baxx:\nS26 12+512 5G DS 610"],
    toolResponses: {
      analyze_quote: [
        { error: 'No existe el proveedor "Baxx".', quisiste_decir: "Bax", proveedores: ["Bax", "Planet", "Vitel"], nota: "No se crean proveedores solos." },
      ],
      load_quote: [
        { error: 'No existe el proveedor "Baxx".', quisiste_decir: "Bax", proveedores: ["Bax", "Planet", "Vitel"], nota: "No se crean proveedores solos." },
      ],
    },
    expect: {
      mustCall: [{ tool: "analyze_quote", args: [{ key: "supplier", matches: "bax" }] }],
      mustNotCall: ["create_supplier"],
    },
    replay: [
      [fc("analyze_quote", { supplier: "Baxx", text: "S26 12+512 5G DS 610" })],
      [txt('No tengo el proveedor "Baxx" — ¿quisiste decir Bax?')],
    ],
  },
  {
    id: "escalera-una-tool",
    descripcion: "escalera dictada → UNA set_tiers (jamás varios set_price)",
    user: ["cargá el S26 12+512 5G DS de Bax: base 620, 20 o más a 610, 50 o más a 595"],
    toolResponses: {
      set_tiers: [{ ok: true, escalones: 3, verificacion: { coincide: true } }],
    },
    expect: {
      mustCall: [{ tool: "set_tiers", args: [{ key: "tiers", matches: "595" }] }],
      mustNotCall: ["set_price"],
    },
    replay: [
      [
        fc("set_tiers", {
          model: "S26 12+512 5G DS",
          supplier: "Bax",
          tiers: [
            { min_qty: 1, price: 620 },
            { min_qty: 20, price: 610 },
            { min_qty: 50, price: 595 },
          ],
        }),
      ],
      [txt("Escalera cargada (3 escalones).")],
    ],
  },
  {
    id: "batch-categoria",
    descripcion: "crear categoría + mover DOS modelos (batch en el mismo pedido)",
    user: ["creá la categoría Samsung Gama Media y mové el S26 12+512 5G DS y el A17 4+128 DS ahí"],
    toolResponses: {
      create_category: [{ creada: true, category_id: "c9", name: "Samsung Gama Media" }],
      move_model_category: [
        { ok: true, modelo: "S26 12+512 5G DS", categoria: "Samsung Gama Media" },
        { ok: true, modelo: "A17 4+128 DS", categoria: "Samsung Gama Media" },
      ],
    },
    expect: {
      mustCall: [
        { tool: "create_category", args: [{ key: "name", matches: "gama media" }] },
        { tool: "move_model_category", args: [{ key: "model", matches: "s26" }] },
        { tool: "move_model_category", args: [{ key: "model", matches: "a17" }] },
      ],
    },
    replay: [
      [fc("create_category", { name: "Samsung Gama Media" })],
      [
        fc("move_model_category", { model: "S26 12+512 5G DS", category: "Samsung Gama Media" }),
        fc("move_model_category", { model: "A17 4+128 DS", category: "Samsung Gama Media" }),
      ],
      [txt("Categoría creada y los 2 modelos movidos.")],
    ],
  },
  {
    id: "agent-runs-qa",
    descripcion: "preguntar por el agente autónomo → get_agent_runs (Q&A del journal)",
    user: ["¿qué encontró el agente autónomo en el último QA de precios?"],
    toolResponses: {
      get_agent_runs: [
        { corridas: [{ id: "run-9", ts: "2026-07-25", task: "qa", mode: "shadow", status: "ok", review: "sin revisar", reporte: "19 hallazgos: 1 off-median, 3 sin Lista, 9 proveedores vencidos" }] },
      ],
    },
    expect: {
      mustCall: [{ tool: "get_agent_runs" }],
      mustNotCall: ["apply_lines", "set_price"],
    },
    replay: [
      [fc("get_agent_runs", { task: "qa" })],
      [txt("Último QA (sombra): 19 hallazgos — 1 proveedor off-median, 3 sin Lista, 9 con precios vencidos.")],
    ],
  },
  {
    id: "review-aprobado",
    descripcion: "veredicto del usuario → review_agent_run (nunca inventado)",
    user: ["la corrida run-9 estuvo perfecta, aprobala"],
    toolResponses: {
      review_agent_run: [{ ok: true, id: "run-9", verdict: "aprobado" }],
    },
    expect: {
      mustCall: [
        { tool: "review_agent_run", args: [{ key: "id", matches: "run-9" }, { key: "verdict", equals: "aprobado" }] },
      ],
    },
    replay: [
      [fc("review_agent_run", { id: "run-9", verdict: "aprobado" })],
      [txt("Aprobada — suma a las métricas de promoción.")],
    ],
  },
  {
    id: "dry-run-pregunta",
    descripcion: "'¿qué pasaría si…?' → dry_run:true (simular, no escribir)",
    user: [LISTA_PLANET, "¿qué pasaría si aplico toda la lista?"],
    toolResponses: {
      analyze_quote: [ANALYSIS_RESPONSE],
      apply_lines: [{ dry_run: true, aplicaria: [{ modelo: "S26 12+512 5G DS", precio: 585 }], bloqueadas: [], quedan_en_mesa: 2 }],
    },
    expect: {
      mustCall: [{ tool: "apply_lines", args: [{ key: "dry_run", truthy: true }] }],
    },
    replay: [
      [fc("analyze_quote", { supplier: "Planet", text: LISTA_PLANET })],
      [txt("Analizada. ¿Aplico algo?")],
      [fc("apply_lines", { all: true, dry_run: true })],
      [txt("Simulación: aplicaría 1, nada escrito.")],
    ],
  },
  {
    id: "whatsapp-selectivo",
    descripcion: "pedido de lista WhatsApp → whatsapp_list con filtro (solo texto)",
    user: ["pasame la lista de Samsung Gama Alta para WhatsApp"],
    toolResponses: {
      whatsapp_list: [{ modelos: 2, texto_whatsapp: "*Samsung Gama Alta*\nS26 12+512 5G DS\t$618" }],
    },
    expect: {
      mustCall: [{ tool: "whatsapp_list", args: [{ key: "category", matches: "gama alta" }] }],
      mustNotCall: ["apply_lines", "set_price", "set_sale_price"],
    },
    replay: [
      [fc("whatsapp_list", { category: "Samsung Gama Alta" })],
      [txt("*Samsung Gama Alta*\nS26 12+512 5G DS\t$618")],
    ],
  },
];

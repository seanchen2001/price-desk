// Tools TIPADAS del agente de chat (Fase 8) — declaraciones function-calling de Gemini
// (formato REST v1beta: function_declarations) + system prompt del agente.
// Guardrail central: el agente PROPONE tool calls; el CÓDIGO las ejecuta vía la capa de
// datos existente (executor.ts). Toda referencia a un modelo entra como texto y pasa por
// resolveModel — el agente jamás inventa identidad ni escribe por nombre.

type Declaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const STR = (description: string) => ({ type: "STRING", description });
const NUM = (description: string) => ({ type: "NUMBER", description });

const BOOL = (description: string) => ({ type: "BOOLEAN", description });

// params del gate (P1) — compartidos por las tools de precio
const GATE_PARAMS = {
  force: BOOL(
    "SOLO tras un bloqueo y con OK explícito del usuario. NO la uses de entrada ni la inventes.",
  ),
  reason: STR("Obligatoria con force: la justificación DEL USUARIO (queda en el journal)."),
  dry_run: BOOL("true = simular sin escribir nada (devuelve 'escribiria')."),
};

const MODEL_PARAM = STR(
  "Nombre del modelo tal cual lo conocés (se resuelve con el resolvedor de identidad; si no existe, la tool lo dice — no se crea nada solo).",
);

const DECLARATIONS: Declaration[] = [
  // ---------- catálogo (CRUD completo, siempre vía resolveModel / mutaciones por fila) ----------
  {
    name: "create_model",
    description:
      "Agrega un modelo NUEVO al catálogo. Primero resuelve el nombre: si ya existe (aunque esté escrito distinto) NO duplica y te devuelve el existente. department: Teléfonos | iPhone | Laptops | Otros. category: una categoría existente (ej. Samsung, Samsung Gama Alta); si no existe, creala antes con create_category.",
    parameters: {
      type: "OBJECT",
      properties: {
        name: STR("Nombre canónico del modelo (ej. 'S26 12+512 5G DS')."),
        department: STR("Departamento (opcional; default Teléfonos)."),
        category: STR("Categoría existente (opcional)."),
      },
      required: ["name"],
    },
  },
  {
    name: "rename_model",
    description:
      "Renombra un modelo (renombre canónico: conserva aliases, precios e historial). Si el nombre nuevo ya resuelve a OTRO modelo, falla y te avisa (no se fusiona solo).",
    parameters: {
      type: "OBJECT",
      properties: { model: MODEL_PARAM, new_name: STR("Nombre canónico nuevo.") },
      required: ["model", "new_name"],
    },
  },
  {
    name: "move_model_category",
    description:
      "Mueve un modelo a otra categoría (ej. armar 'Samsung Gama Alta' y mover ahí los S26). La categoría debe existir (create_category si no).",
    parameters: {
      type: "OBJECT",
      properties: { model: MODEL_PARAM, category: STR("Categoría destino (existente).") },
      required: ["model", "category"],
    },
  },
  {
    name: "create_category",
    description:
      "Crea una categoría nueva de la Mesa (ej. 'Samsung Gama Alta', 'Samsung Gama Baja'). Las categorías se muestran como secciones separadas de la grilla. Si ya existe, te lo dice.",
    parameters: {
      type: "OBJECT",
      properties: { name: STR("Nombre de la categoría.") },
      required: ["name"],
    },
  },
  {
    name: "rename_category",
    description: "Renombra una categoría existente (todos sus modelos la siguen).",
    parameters: {
      type: "OBJECT",
      properties: { from: STR("Nombre actual."), to: STR("Nombre nuevo.") },
      required: ["from", "to"],
    },
  },
  {
    name: "create_supplier",
    description: "Agrega un proveedor nuevo (columna de la Mesa). Si ya existe, te lo dice.",
    parameters: {
      type: "OBJECT",
      properties: { name: STR("Nombre del proveedor.") },
      required: ["name"],
    },
  },
  {
    name: "toggle_supplier",
    description:
      "Activa o desactiva un proveedor. Desactivado: su columna deja de mostrarse pero sus precios quedan guardados.",
    parameters: {
      type: "OBJECT",
      properties: {
        supplier: STR("Nombre del proveedor."),
        active: { type: "BOOLEAN", description: "true = activo, false = oculto." },
      },
      required: ["supplier", "active"],
    },
  },
  {
    name: "set_price",
    description:
      "Carga/actualiza el precio de UN modelo para UN proveedor (upsert por fila + historial + verificación releída). GATEADA: si el precio dispara flags (unidad, >±30% vs Mín, >±15% vs par) devuelve {bloqueado, flags} SIN escribir. CUÁNDO NO USARLA: para listas de varios modelos usá analyze_quote→apply_lines; para escaleras usá set_tiers.",
    parameters: {
      type: "OBJECT",
      properties: {
        model: MODEL_PARAM,
        supplier: STR("Proveedor del precio."),
        price: NUM("Precio en USD."),
        ...GATE_PARAMS,
      },
      required: ["model", "supplier", "price"],
    },
  },
  {
    name: "set_tiers",
    description:
      "Define la escalera por cantidad de UN par modelo+proveedor (reemplaza la escalera de ESE par; [] la borra; verificación releída). GATEADA: escalera invertida o mejor-precio insano → {bloqueado, flags} sin escribir. La fila sigue siendo UNA: las cantidades jamás crean filas. CUÁNDO NO USARLA: si no te pasaron escalones explícitos.",
    parameters: {
      type: "OBJECT",
      properties: {
        model: MODEL_PARAM,
        supplier: STR("Proveedor."),
        tiers: {
          type: "ARRAY",
          description: "Escalones [{min_qty, price}] ascendentes.",
          items: {
            type: "OBJECT",
            properties: { min_qty: { type: "INTEGER" }, price: NUM("Precio del escalón.") },
            required: ["min_qty", "price"],
          },
        },
        ...GATE_PARAMS,
      },
      required: ["model", "supplier", "tiers"],
    },
  },
  {
    name: "set_sale_price",
    description:
      "Fija la Lista (precio de venta manual) de un modelo, con verificación releída. Sin 'price' → vuelve a automática (Mín + margen). Acepta dry_run. CUÁNDO NO USARLA: no toca costos de proveedor (eso es set_price).",
    parameters: {
      type: "OBJECT",
      properties: {
        model: MODEL_PARAM,
        price: NUM("Precio de Lista en USD (omitir = automática)."),
        dry_run: GATE_PARAMS.dry_run,
      },
      required: ["model"],
    },
  },
  {
    name: "delete_price",
    description:
      "BORRA el precio de un modelo para un proveedor (destructivo: el usuario confirma en la UI antes de ejecutarse).",
    parameters: {
      type: "OBJECT",
      properties: { model: MODEL_PARAM, supplier: STR("Proveedor.") },
      required: ["model", "supplier"],
    },
  },
  {
    name: "analyze_quote",
    description:
      "MESA DE NEGOCIACIÓN: el usuario pega una lista de precios de un proveedor → extrae con IA, resuelve identidad y STAGEA la lista con el análisis por línea contra la Mesa actual (🟢 oportunidad = mejor que nuestro mín · 🟡 en línea ±1.5% · 🔴 cara: cuánto y quién la tiene mejor · vs mediana y vs el precio anterior del MISMO proveedor, con frescura). NO aplica nada. Los modelos nuevos van a la cola de confirmación. Usala SIEMPRE que peguen una lista con varios modelos+precios; pasá el texto COMPLETO tal cual.",
    parameters: {
      type: "OBJECT",
      properties: {
        supplier: STR("Proveedor de la lista (existente; si no está claro, preguntá antes)."),
        text: STR("La lista COMPLETA tal cual la pegó el usuario (no la resumas)."),
      },
      required: ["supplier", "text"],
    },
  },
  {
    name: "apply_lines",
    description:
      "Aplica SELECTIVAMENTE líneas de la negociación en curso a la Mesa (precio+escala por fila, con verificación releída por línea). Selector: models[] (nombres), category, classification ('oportunidad'|'en_linea'|'caro') o all:true — combinable con except[] ('todo menos X'). GATEADA POR LÍNEA contra la Mesa ACTUAL: las limpias se aplican, las flaggeadas vuelven en 'bloqueadas' y siguen en la mesa. Solo por instrucción explícita del usuario. CUÁNDO NO USARLA: sin analyze_quote previo no hay nada stageado.",
    parameters: {
      type: "OBJECT",
      properties: {
        models: { type: "ARRAY", items: { type: "STRING" }, description: "Nombres/fragmentos de modelo." },
        category: STR("Categoría de la Mesa (ej. 'Samsung Gama Alta')."),
        classification: STR("'oportunidad' | 'en_linea' | 'caro'."),
        all: { type: "BOOLEAN", description: "true = todas las líneas stageadas." },
        except: { type: "ARRAY", items: { type: "STRING" }, description: "Excluir estos modelos." },
        ...GATE_PARAMS,
      },
    },
  },
  {
    name: "discard_lines",
    description:
      "Descarta líneas de la negociación en curso SIN aplicarlas (mismo selector que apply_lines; all:true descarta todo).",
    parameters: {
      type: "OBJECT",
      properties: {
        models: { type: "ARRAY", items: { type: "STRING" } },
        category: STR("Categoría."),
        classification: STR("'oportunidad' | 'en_linea' | 'caro'."),
        all: { type: "BOOLEAN" },
        except: { type: "ARRAY", items: { type: "STRING" } },
      },
    },
  },
  {
    name: "counter_offer",
    description:
      "Arma la CONTRAOFERTA para el proveedor de la lista en negociación: para las líneas 🔴 caras propone el precio objetivo (matchear nuestro mín, o mín−1 con mode 'undercut') y devuelve el texto listo para WhatsApp. Las 🟢 no se mencionan (no despertar al proveedor). Números determinísticos de la Mesa.",
    parameters: {
      type: "OBJECT",
      properties: { mode: STR("'match' (default: igualar nuestro mín) o 'undercut' (mín − 1).") },
    },
  },
  {
    name: "price_position",
    description:
      "Dónde estamos parados (brief del negociador): por modelo — todos los proveedores con precio/frescura/escala, quién tiene el mín, mediana y spread. Por categoría — el resumen de cada modelo. Usala antes de negociar.",
    parameters: {
      type: "OBJECT",
      properties: { model: STR("Modelo puntual (opcional)."), category: STR("Categoría (opcional).") },
    },
  },
  {
    name: "discount_plan",
    description:
      "Lado CLIENTE: si un cliente pide mejor precio en un pedido, propone DÓNDE conceder (modelos con margen gordo entre costo real y Lista) y dónde sostener, con el impacto total. Usa el costo REAL a esa cantidad (escalas). target_pct = descuento total que pide el cliente; floor_pct = piso de margen (default 1%).",
    parameters: {
      type: "OBJECT",
      properties: {
        items: {
          type: "ARRAY",
          description: "El pedido: [{model, qty}].",
          items: {
            type: "OBJECT",
            properties: { model: STR("Modelo."), qty: { type: "INTEGER" } },
            required: ["model"],
          },
        },
        target_pct: NUM("Descuento total % que pide el cliente (opcional)."),
        floor_pct: NUM("Piso de margen % por línea (default 1)."),
        margin_pct: NUM("Margen % para la Lista automática (default 3)."),
      },
      required: ["items"],
    },
  },
  {
    name: "remember",
    description:
      "Guarda un APRENDIZAJE de negociación en la memoria de la casa (ej. 'afloja 2% con volumen', 'paga a 30 días, no conceder más de 1%'). Usala cuando el usuario te enseña algo o al cerrar una negociación con una lección clara. 'about' = proveedor/cliente/modelo al que refiere.",
    parameters: {
      type: "OBJECT",
      properties: {
        note: STR("La nota, corta y accionable."),
        about: STR("Proveedor/cliente/modelo al que refiere (opcional)."),
      },
      required: ["note"],
    },
  },
  {
    name: "recall",
    description:
      "Trae las notas de la memoria sobre una parte ('about' = proveedor/cliente/modelo) o todas. Usala antes de negociar con alguien si no tenés sus notas a mano.",
    parameters: { type: "OBJECT", properties: { about: STR("Filtro (opcional).") } },
  },
  {
    name: "whatsapp_list",
    description:
      "Arma el texto de cotización para WhatsApp (agrupado por categoría en *negrita*, precio de Lista o Mín+margen). Filtrable por departamento, categoría y/o texto del modelo. Devuelve texto listo para copiar — NO toca la base.",
    parameters: {
      type: "OBJECT",
      properties: {
        department: STR("Departamento (opcional)."),
        category: STR("Categoría (opcional)."),
        filter: STR("Filtro por texto del nombre (opcional, ej. 'S26')."),
        margin_pct: NUM("Margen % para el fallback Mín+margen (default 3)."),
      },
    },
  },
  {
    name: "get_agent_runs",
    description:
      "Lista las corridas del agente AUTÓNOMO (journal agent_runs): qué encontró, qué hizo (o habría hecho en sombra), reporte y veredicto humano. Usala cuando pregunten '¿qué hizo el agente solo?' o para revisar una corrida antes del veredicto.",
    parameters: {
      type: "OBJECT",
      properties: {
        task: STR("Filtrar por tarea (ej. 'qa'). Opcional."),
        limit: { type: "INTEGER", description: "Máx corridas (default 20)." },
      },
    },
  },
  {
    name: "review_agent_run",
    description:
      "Guarda el VEREDICTO HUMANO sobre una corrida autónoma ('aprobado'|'rechazado' + notas) — alimenta las métricas de promoción de la escalera de confianza. SOLO cuando el usuario da el veredicto explícito; jamás lo inventes vos.",
    parameters: {
      type: "OBJECT",
      properties: {
        id: STR("Id de la corrida (de get_agent_runs)."),
        verdict: STR("'aprobado' o 'rechazado' (palabras del usuario)."),
        notas: STR("Notas del usuario (opcional)."),
      },
      required: ["id", "verdict"],
    },
  },
  // ---------- consulta / briefing ----------
  {
    name: "get_mesa_summary",
    description:
      "Resumen de la Mesa: por modelo, precios por proveedor + Mín/Mediana/Cliente (margen %). Filtrable por departamento. Usalo antes de opinar sobre precios.",
    parameters: {
      type: "OBJECT",
      properties: {
        department: STR("Departamento (opcional; ej. Teléfonos, iPhone)."),
        margin_pct: NUM("Margen % para el precio Cliente (default 3)."),
      },
    },
  },
  {
    name: "client_pulse",
    description:
      "Pulso de clientes: saldo (lo que nos deben), facturas con entrega/pago pendiente y días, hace cuánto no compran. Ordenado por urgencia. Sin 'client' devuelve todos.",
    parameters: {
      type: "OBJECT",
      properties: { client: STR("Cliente puntual (opcional).") },
    },
  },
  {
    name: "analytics_summary",
    description:
      "PnL del período: ventas, costo, gastos, margen bruto/neto, piezas, top clientes y proveedores. period: 'semana' (desde el lunes) | 'mes' | 'todo'.",
    parameters: {
      type: "OBJECT",
      properties: { period: STR("'semana' | 'mes' | 'todo' (default mes).") },
    },
  },
  {
    name: "cuentas_summary",
    description:
      "Cuentas corrientes de un lado con su saldo. side 'client' = lo que NOS DEBEN; side 'supplier' = lo que LES DEBEMOS.",
    parameters: {
      type: "OBJECT",
      properties: { side: STR("'client' (default) o 'supplier'.") },
    },
  },
  {
    name: "best_suppliers",
    description:
      "Ranking de proveedores por costo para un modelo y una cantidad (respeta la escalera por cantidad). Incluye brecha con la alternativa para negociar.",
    parameters: {
      type: "OBJECT",
      properties: { model: MODEL_PARAM, qty: { type: "INTEGER", description: "Cantidad (default 1)." } },
      required: ["model"],
    },
  },
];

/** Tools en el formato que espera Gemini (`tools` del generateContent). */
export const AGENT_TOOLS = [{ function_declarations: DECLARATIONS }];

export const TOOL_NAMES: ReadonlySet<string> = new Set(DECLARATIONS.map((d) => d.name));

/** Destructivas → confirmación UI ANTES de ejecutar (patrón AgentCommitModal viejo). */
export const CONFIRM_TOOLS: ReadonlySet<string> = new Set(["delete_price", "toggle_supplier"]);

/** Tools que mutan la base → invalidar el cache de React Query al terminar el turno. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "create_model",
  "rename_model",
  "move_model_category",
  "create_category",
  "rename_category",
  "create_supplier",
  "toggle_supplier",
  "set_price",
  "set_tiers",
  "set_sale_price",
  "delete_price",
  "apply_lines",
  "remember",
  "review_agent_run",
]);

export type AgentSystemContext = {
  departments: readonly string[];
  categories: readonly string[];
  suppliers: readonly string[];
  modelCount: number;
  knowledge?: readonly string[];
  /** tab activo de la app ("Mesa", "Órdenes", …) — desambigua comandos vagos */
  activeTab?: string;
};

/** System prompt del agente — dinámico (catálogos reales) y propose-only. */
export function buildAgentSystem(ctx: AgentSystemContext): string {
  return [
    "Sos el VENDEDOR/NEGOCIADOR del Price Desk de un mayorista de celulares — no un cargador de datos. Comprás bien (proveedores) y vendés bien (clientes), con memoria de la casa. Operás la Mesa (modelos, categorías, proveedores, precios, escalas, Lista) y respondés consultas del negocio usando SOLO tus tools.",
    "",
    "NEGOCIACIÓN (tu flujo central): una lista pegada = MESA DE NEGOCIACIÓN, no aplicar-todo.",
    "  1) analyze_quote la stagea y te da el análisis por línea: 🟢 oportunidad (mejor que nuestro mín — decile al usuario que consiguió buen precio y cuánto mejora), 🟡 en línea, 🔴 cara (cuánto arriba y quién la tiene mejor).",
    "  2) Contale el resumen como negociador ('5 oportunidades — aplicalas; 8 caras — pedile mejora') y esperá la decisión.",
    "  3) apply_lines aplica SOLO lo que el usuario diga (por clasificación, categoría, modelos o todo-menos). discard_lines tira el resto.",
    "  4) counter_offer arma el pedido de mejora al proveedor (solo las 🔴; las 🟢 ni mencionarlas). Si piden otro tono, redactalo vos con LOS MISMOS números.",
    "  5) Lado cliente: discount_plan decide dónde conceder (margen gordo) y dónde sostener. price_position es tu brief antes de cualquier negociación.",
    "  6) MEMORIA: remember guarda lo aprendido ('planET afloja 2% con volumen') — usala cuando el usuario te enseña algo o se cierra una negociación; recall la trae. Tus notas ya vienen en este prompt: usalas al negociar sin que te las repitan.",
    "",
    "IDENTIDAD (regla de oro): los modelos se referencian por NOMBRE y el sistema los resuelve con un resolvedor determinístico. Si una tool contesta que el modelo no existe, NO insistas con variantes inventadas: decile al usuario qué no encontraste (con los parecidos que te dio la tool) y preguntá. create_model NUNCA duplica: si el nombre ya resuelve, te devuelve el existente.",
    "",
    "PODÉS (CRUD completo, dinámico): crear modelos y proveedores nuevos, crear/renombrar categorías (ej. separar 'Samsung Gama Alta' y 'Samsung Gama Baja' y mover los modelos con move_model_category — la grilla las muestra como secciones separadas), cargar precios y escaleras por cantidad, fijar la Lista.",
    "",
    "CONFIRMACIONES: delete_price y toggle_supplier son destructivas → la UI le pide confirmación al usuario antes de ejecutarlas; avisá que quedó a la espera si el resultado dice cancelado/confirmación. El resto se ejecuta directo.",
    "",
    "CONTRATO DEL GATE (escrituras de precio — set_price/set_tiers/apply_lines):",
    "- Si la tool devuelve {bloqueado:true, flags}: NO escribió NADA. Mostrale los flags AL USUARIO tal cual y preguntá. Re-llamá con force:true + reason ÚNICAMENTE con su OK explícito. JAMÁS fuerces por tu cuenta ni inventes el reason (es la justificación del usuario, textual).",
    "- force sin reason = error. dry_run:true simula sin escribir ('a ver qué pasaría').",
    "- COHERENCIA POST-MUTACIÓN: toda escritura devuelve verificacion:{leido,coincide} (releído de la base). Si coincide:false, avisá el mismatch y FRENÁ: no encadenes más escrituras en ese turno.",
    "- En apply_lines las líneas 'bloqueadas' siguen en la mesa de negociación: no las des por aplicadas.",
    "EJEMPLOS (secuencias correctas):",
    "  · user: 'cargá el S26 a 61 de Bax' → set_price(61) → {bloqueado, flags:[~1/10 del mín $610]} → vos: '🚩 61 parece 1/10 del mín ($610), ¿era 610?' → user: 'sí, 610' → set_price(610) — SIN force: el precio corregido pasa limpio.",
    "  · user: 'cargá 720, sé que subió' → set_price(720) → {bloqueado, flags:[+20% vs par]} → vos preguntás → user: 'sí, forzalo: subió por el dólar' → set_price(720, force:true, reason:'usuario confirma suba real por el dólar').",
    "  · user: '¿qué pasaría si aplico toda la lista?' → apply_lines(all:true, dry_run:true) → mostrás aplicaria/bloqueadas sin tocar nada.",
    "",
    "CONTEXTO ACTUAL:",
    `- Departamentos: ${ctx.departments.join(", ") || "(ninguno)"}.`,
    `- Categorías: ${ctx.categories.join(", ") || "(ninguna)"}.`,
    `- Proveedores: ${ctx.suppliers.join(", ") || "(ninguno)"}.`,
    `- Modelos en catálogo: ${ctx.modelCount}.`,
    ctx.activeTab !== undefined && ctx.activeTab !== ""
      ? `- El usuario está mirando el tab "${ctx.activeTab}" ahora mismo: interpretá los pedidos ambiguos en ese contexto (ej. "esta tabla"/"acá" = ese tab).`
      : "",
    ctx.knowledge && ctx.knowledge.length
      ? "REGLAS APRENDIDAS (respetalas):\n" + ctx.knowledge.map((r) => `  • ${r}`).join("\n")
      : "",
    "",
    "REGLAS:",
    "- Si el usuario PEGA una lista de precios (varios modelos con números), usá analyze_quote con el TEXTO COMPLETO y el proveedor (nada se aplica solo: queda en la mesa de negociación). Si no sabés de qué proveedor es, preguntá primero.",
    "- 'pasame la lista para WhatsApp' / 'cotizame X para mandar' = whatsapp_list; mostrá texto_whatsapp TAL CUAL (es solo texto, no toca nada).",
    "- Escaleras por cantidad: SIEMPRE set_tiers sobre el par modelo+proveedor. Las cantidades jamás crean modelos ni filas nuevas.",
    "- Antes de mover modelos a una categoría, asegurate de que exista (create_category primero si hace falta). Para varios modelos, llamá move_model_category una vez por modelo en el MISMO turno.",
    "- Perspectiva trader: el proveedor nos VENDE (su precio es nuestro costo); el cliente nos COMPRA (side 'client' = nos debe).",
    "- Respuestas CORTAS, en español, bullets de una línea por modelo. No narres las tools ('procedo a…'): ejecutá y cerrá con una frase.",
    "- Si la tool devuelve error, mostralo tal cual (no lo escondas) y sugerí el paso siguiente.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

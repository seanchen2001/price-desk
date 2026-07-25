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
      "Carga/actualiza el precio de UN modelo para UN proveedor (upsert por fila + historial). Devuelve el precio anterior y la variación.",
    parameters: {
      type: "OBJECT",
      properties: {
        model: MODEL_PARAM,
        supplier: STR("Proveedor del precio."),
        price: NUM("Precio en USD."),
      },
      required: ["model", "supplier", "price"],
    },
  },
  {
    name: "set_tiers",
    description:
      "Define la escalera por cantidad de UN par modelo+proveedor (reemplaza la escalera de ESE par; [] la borra). La fila sigue siendo UNA: las cantidades jamás crean filas.",
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
      },
      required: ["model", "supplier", "tiers"],
    },
  },
  {
    name: "set_sale_price",
    description:
      "Fija la Lista (precio de venta manual) de un modelo. Sin 'price' → vuelve a automática (Mín + margen).",
    parameters: {
      type: "OBJECT",
      properties: { model: MODEL_PARAM, price: NUM("Precio de Lista en USD (omitir = automática).") },
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
    "Sos el TRADER-ASISTENTE del Price Desk de un mayorista de celulares. Operás la base de datos de la Mesa (modelos, categorías, proveedores, precios, escalas, Lista) y respondés consultas del negocio (cuentas, clientes, PnL, mejores proveedores) usando SOLO tus tools.",
    "",
    "IDENTIDAD (regla de oro): los modelos se referencian por NOMBRE y el sistema los resuelve con un resolvedor determinístico. Si una tool contesta que el modelo no existe, NO insistas con variantes inventadas: decile al usuario qué no encontraste (con los parecidos que te dio la tool) y preguntá. create_model NUNCA duplica: si el nombre ya resuelve, te devuelve el existente.",
    "",
    "PODÉS (CRUD completo, dinámico): crear modelos y proveedores nuevos, crear/renombrar categorías (ej. separar 'Samsung Gama Alta' y 'Samsung Gama Baja' y mover los modelos con move_model_category — la grilla las muestra como secciones separadas), cargar precios y escaleras por cantidad, fijar la Lista.",
    "",
    "CONFIRMACIONES: delete_price y toggle_supplier son destructivas → la UI le pide confirmación al usuario antes de ejecutarlas; avisá que quedó a la espera si el resultado dice cancelado/confirmación. El resto se ejecuta directo.",
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
    "- Escaleras por cantidad: SIEMPRE set_tiers sobre el par modelo+proveedor. Las cantidades jamás crean modelos ni filas nuevas.",
    "- Antes de mover modelos a una categoría, asegurate de que exista (create_category primero si hace falta). Para varios modelos, llamá move_model_category una vez por modelo en el MISMO turno.",
    "- Perspectiva trader: el proveedor nos VENDE (su precio es nuestro costo); el cliente nos COMPRA (side 'client' = nos debe).",
    "- Respuestas CORTAS, en español, bullets de una línea por modelo. No narres las tools ('procedo a…'): ejecutá y cerrá con una frase.",
    "- Si la tool devuelve error, mostralo tal cual (no lo escondas) y sugerí el paso siguiente.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

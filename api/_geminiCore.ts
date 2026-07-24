// Núcleo compartido del proxy Gemini — lo usan api/gemini.ts (Vercel serverless) y el
// middleware de dev de vite.config.ts. La GEMINI_API_KEY vive SOLO acá (server-side);
// el navegador llama /api/gemini y jamás ve la key (verificado: grep del bundle).
// El prefijo "_" hace que Vercel NO exponga este archivo como endpoint.

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/** Contrato del POST /api/gemini (subset del generateContent de Gemini v1beta). */
export type GeminiProxyPayload = {
  /** system_instruction */
  system?: string;
  /** atajo single-turn: texto del usuario */
  content?: string;
  /** atajo single-turn: imágenes inline (screenshot de cotización) */
  images?: Array<{ mimeType: string; data: string }>;
  /** conversación multi-turno completa (agente / function calling); pisa content/images */
  contents?: unknown[];
  /** function_declarations para function calling */
  tools?: unknown[];
  toolConfig?: unknown;
  /** responseMimeType application/json */
  json?: boolean;
  /** responseSchema tipado (extracción propose-only); implica json */
  responseSchema?: unknown;
  maxTokens?: number;
  model?: string;
};

type GenerationConfig = {
  temperature: number;
  maxOutputTokens: number;
  thinkingConfig?: { thinkingBudget: number };
  responseMimeType?: string;
  responseSchema?: unknown;
};

/** Payload del proxy → body del generateContent (temperatura 0 SIEMPRE: extracción/tools). */
export function buildGeminiRequest(p: GeminiProxyPayload): {
  model: string;
  body: Record<string, unknown>;
} {
  const model = p.model ?? DEFAULT_GEMINI_MODEL;
  let contents = Array.isArray(p.contents) ? p.contents : null;
  if (!contents) {
    const parts: unknown[] = [];
    for (const im of p.images ?? []) {
      parts.push({ inline_data: { mime_type: im.mimeType, data: im.data } });
    }
    if (p.content) parts.push({ text: p.content });
    contents = [{ role: "user", parts }];
  }
  const generationConfig: GenerationConfig = {
    temperature: 0,
    maxOutputTokens: p.maxTokens ?? 2048,
  };
  // thinkingBudget 0 SOLO para Flash (rápido, sin pensar); los Pro lo rechazan con 400.
  if (/flash/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (p.json === true || p.responseSchema !== undefined) {
    generationConfig.responseMimeType = "application/json";
  }
  if (p.responseSchema !== undefined) generationConfig.responseSchema = p.responseSchema;
  const body: Record<string, unknown> = { contents, generationConfig };
  if (p.system) body["system_instruction"] = { parts: [{ text: p.system }] };
  if (p.tools) body["tools"] = p.tools;
  if (p.toolConfig) body["tool_config"] = p.toolConfig;
  return { model, body };
}

/** Llama a Gemini y devuelve status + body crudo (pass-through hacia el cliente). */
export async function forwardGemini(
  payload: GeminiProxyPayload,
  apiKey: string,
): Promise<{ status: number; body: string }> {
  const { model, body } = buildGeminiRequest(payload);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.text() };
}

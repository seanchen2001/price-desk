// Transporte del CLIENTE hacia el proxy /api/gemini (dev: middleware de vite;
// prod: api/gemini.ts en Vercel). La key jamás toca el navegador.
// Guardrail anti-cuelgue: AbortController a los 30s y errores RUIDOSOS con el mensaje
// real de Gemini (el agente viejo se colgaba 90s en silencio).

export const GEMINI_TIMEOUT_MS = 30_000;
export const GEMINI_PROXY_PATH = "/api/gemini";

export type GeminiFunctionCall = { name: string; args?: Record<string, unknown> };

export type GeminiPart = {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown> };
  inline_data?: { mime_type: string; data: string };
};

export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

export type GeminiImage = { mimeType: string; data: string };

export type GeminiCallInput = {
  system?: string;
  content?: string;
  images?: GeminiImage[];
  contents?: GeminiContent[];
  tools?: unknown[];
  responseSchema?: unknown;
  json?: boolean;
  maxTokens?: number;
  model?: string;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  error?: { message?: string };
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function callGeminiProxy(
  payload: GeminiCallInput,
  fetchFn: FetchLike = (input, init) => fetch(input, init),
  timeoutMs: number = GEMINI_TIMEOUT_MS,
): Promise<GeminiResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(GEMINI_PROXY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        `Timeout: Gemini no respondió en ${Math.round(timeoutMs / 1000)}s. Probá de nuevo.`,
      );
    }
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: GeminiResponse;
  try {
    data = JSON.parse(text) as GeminiResponse;
  } catch {
    throw new Error(`Gemini ${res.status}: respuesta no-JSON del proxy: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${data.error?.message ?? text.slice(0, 300)}`);
  }
  return data;
}

/** Extrae el texto concatenado del primer candidato (extracción JSON, respuestas). */
export async function generateText(
  input: GeminiCallInput,
  fetchFn?: FetchLike,
  timeoutMs?: number,
): Promise<string> {
  const data = await callGeminiProxy(input, fetchFn, timeoutMs);
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

/** Un turno del agente (function calling): devuelve el content del modelo tal cual. */
export async function generateTurn(
  input: GeminiCallInput,
  fetchFn?: FetchLike,
  timeoutMs?: number,
): Promise<GeminiContent> {
  const data = await callGeminiProxy(input, fetchFn, timeoutMs);
  const content = data.candidates?.[0]?.content;
  if (!content) throw new Error("Gemini no devolvió ningún candidato (respuesta vacía)");
  return { role: "model", parts: content.parts ?? [] };
}

/** functionCalls de un turno del modelo (en orden). */
export function functionCallsOf(content: GeminiContent): GeminiFunctionCall[] {
  return content.parts
    .map((p) => p.functionCall)
    .filter((c): c is GeminiFunctionCall => c !== undefined && typeof c.name === "string");
}

/** texto plano de un turno del modelo. */
export function textOf(content: GeminiContent): string {
  return content.parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

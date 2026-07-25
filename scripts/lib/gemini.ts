// Transporte DIRECTO a Gemini para Node (P3): mismo contrato FetchLike que usa el
// cliente (POST /api/gemini con GeminiCallInput en el body), pero resuelto acá con
// forwardGemini (api/_geminiCore) — sin proxy, la key vive en el env del proceso.
// AGENT_MODEL (env) permite correr el agente autónomo con otro modelo sin tocar código.
import { forwardGemini, type GeminiProxyPayload } from "../../api/_geminiCore";
import type { FetchLike } from "../../src/features/agent/gemini";

export function makeDirectGeminiFetch(apiKey: string, model?: string): FetchLike {
  const defaultModel =
    model ??
    (typeof process !== "undefined" && process.env["AGENT_MODEL"] ? process.env["AGENT_MODEL"] : undefined);
  return async (_input: string, init: RequestInit): Promise<Response> => {
    const payload = JSON.parse(String(init.body ?? "{}")) as GeminiProxyPayload;
    if (defaultModel !== undefined && payload.model === undefined) payload.model = defaultModel;
    const out = await forwardGemini(payload, apiKey);
    return new Response(out.body, {
      status: out.status,
      headers: { "content-type": "application/json" },
    });
  };
}

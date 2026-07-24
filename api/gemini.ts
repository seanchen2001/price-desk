// Proxy serverless de Gemini (formato Vercel) — puerto TS del api/gemini.js viejo.
// El navegador llama POST /api/gemini; la GEMINI_API_KEY vive en el env del server
// (Vercel → Settings → Environment Variables) y NUNCA llega al bundle del cliente.
// APP_PASSWORD (opcional): si está seteada, se exige el header x-app-password.
import { forwardGemini, type GeminiProxyPayload } from "./_geminiCore";

// Tipos estructurales mínimos del runtime de Vercel (evita depender de @vercel/node).
type VercelLikeRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};
type VercelLikeResponse = {
  status: (code: number) => VercelLikeResponse;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => void;
  send: (body: string) => void;
};

export default async function handler(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const appPassword = process.env["APP_PASSWORD"];
  if (appPassword !== undefined && appPassword !== "" && req.headers["x-app-password"] !== appPassword) {
    res.status(401).json({ error: "Contraseña incorrecta" });
    return;
  }
  const key = process.env["GEMINI_API_KEY"];
  if (key === undefined || key === "") {
    res.status(500).json({ error: "GEMINI_API_KEY no está configurada en el servidor" });
    return;
  }
  const payload = (req.body ?? {}) as GeminiProxyPayload;
  try {
    const out = await forwardGemini(payload, key);
    res.status(out.status);
    res.setHeader("content-type", "application/json");
    res.send(out.body); // pass-through: la respuesta (y el status) de Gemini tal cual
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

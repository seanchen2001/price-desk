/// <reference types="vitest/config" />
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { forwardGemini, type GeminiProxyPayload } from "./api/_geminiCore";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// DEV: sirve /api/gemini en localhost:5173 leyendo GEMINI_API_KEY del .env (server-side,
// SIN prefijo VITE_ → vite jamás la inyecta al bundle del cliente). En producción el
// mismo path lo atiende api/gemini.ts (Vercel). Errores SIEMPRE visibles (JSON con error).
function geminiDevProxy(apiKey: string | undefined): Plugin {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const fail = (status: number, error: string) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error }));
    };
    if (req.method !== "POST") {
      fail(405, "Method not allowed");
      return;
    }
    if (apiKey === undefined || apiKey === "") {
      fail(500, "GEMINI_API_KEY no está configurada en .env (sin prefijo VITE_)");
      return;
    }
    try {
      const raw = await readBody(req);
      const payload = (raw ? JSON.parse(raw) : {}) as GeminiProxyPayload;
      const out = await forwardGemini(payload, apiKey);
      res.statusCode = out.status;
      res.setHeader("content-type", "application/json");
      res.end(out.body);
    } catch (e) {
      fail(502, e instanceof Error ? e.message : String(e));
    }
  };
  return {
    name: "gemini-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/api/gemini", (req, res) => {
        void handle(req, res);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // prefijo "" → carga TAMBIÉN las variables sin VITE_ (solo acá, en Node; al cliente
  // únicamente llegan las VITE_* — GEMINI_API_KEY no puede filtrarse al bundle).
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), geminiDevProxy(env["GEMINI_API_KEY"])],
    test: {
      globals: true,
      environment: "node",
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    },
  };
});

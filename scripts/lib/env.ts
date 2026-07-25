// Loader .env COMPARTIDO (P0) — dedup del que estaba copiado en migrate.ts y en cada
// test de integración. Lee el .env de la raíz del repo (formato KEY=VALUE, # comenta)
// y superpone process.env (CI / overrides). Nunca escribe nada.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_KEYS = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_KEY",
  "GEMINI_API_KEY",
] as const;

export function loadDeskEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && !line.trim().startsWith("#")) {
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
  }
  for (const k of ENV_KEYS) {
    const v = typeof process !== "undefined" ? process.env?.[k] : undefined;
    if (v !== undefined && v !== "" && (out[k] === undefined || out[k] === "")) out[k] = v;
  }
  return out;
}

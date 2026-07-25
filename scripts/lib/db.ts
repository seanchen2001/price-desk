// Cliente Supabase con SERVICE KEY para Node (P0): scripts + tests de integración.
// Incluye el stub de WebSocket que createClient exige en Node < 22 (jamás conecta).
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/data/database.types";
import type { Db } from "../../src/data/supabase";
import { loadDeskEnv } from "./env";

class StubWebSocket {
  close(): void {}
  send(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

export function installWebSocketStub(): void {
  (globalThis as { WebSocket?: unknown }).WebSocket ??= StubWebSocket;
}

export function hasServiceEnv(env: Record<string, string> = loadDeskEnv()): boolean {
  return (env["VITE_SUPABASE_URL"] ?? "") !== "" && (env["SUPABASE_SERVICE_KEY"] ?? "") !== "";
}

/** Cliente service-role tipado (Db) listo para Node. Throw ruidoso si falta el env. */
export function makeServiceDb(env: Record<string, string> = loadDeskEnv()): Db {
  const url = env["VITE_SUPABASE_URL"] ?? "";
  const key = env["SUPABASE_SERVICE_KEY"] ?? "";
  if (url === "" || key === "") {
    throw new Error("Faltan VITE_SUPABASE_URL / SUPABASE_SERVICE_KEY en .env / process.env");
  }
  installWebSocketStub();
  return createClient<Database>(url, key);
}

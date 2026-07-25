// Cliente Supabase de la app — INIT PEREZOSA (P0 del plan de autonomía):
// importar este módulo es seguro en cualquier runtime (browser con vite, Node de los
// scripts/runner headless); el env se lee y el cliente se crea recién en el PRIMER USO,
// y ahí sí explota ruidoso si faltan credenciales. Los call sites quedan intactos
// (`db: Db = supabase` sigue funcionando: el default es un proxy que delega).
// Env: import.meta.env (vite) ?? process.env (Node).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Los módulos de src/data/ aceptan un cliente inyectable (default: el de la app) para
// que tests/scripts puedan usar el service key o simular DOS clientes independientes.
export type Db = SupabaseClient<Database>;

function readCred(name: "VITE_SUPABASE_URL" | "VITE_SUPABASE_ANON_KEY"): string {
  // vite inyecta import.meta.env en el bundle; en Node puro puede quedar undefined y
  // caemos a process.env (guardado: en el browser `process` no existe)
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromVite = viteEnv?.[name];
  if (typeof fromVite === "string" && fromVite !== "") return fromVite;
  const fromNode = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return typeof fromNode === "string" ? fromNode : "";
}

let client: Db | null = null;

function getClient(): Db {
  if (client !== null) return client;
  const url = readCred("VITE_SUPABASE_URL");
  const anonKey = readCred("VITE_SUPABASE_ANON_KEY");
  if (url === "" || anonKey === "") {
    throw new Error(
      "Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (en .env para vite, o en process.env del runtime Node)",
    );
  }
  client = createClient<Database>(url, anonKey);
  return client;
}

// Proxy perezoso: mismo objeto exportado de siempre; el cliente real se materializa en
// el primer acceso a una propiedad (`supabase.from(...)`), no al importar.
export const supabase: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getClient() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(real, prop);
    return typeof value === "function"
      ? (value as (...a: unknown[]) => unknown).bind(real)
      : value;
  },
});

type PgResponse<T> = { data: T | null; error: Error | null };

/** Desenvuelve una respuesta PostgREST: error → throw (visible), data → tipada. */
export function unwrap<T>(res: PgResponse<T>): T {
  if (res.error) throw res.error;
  if (res.data === null) {
    throw new Error("PostgREST devolvió data=null sin error (¿faltó .select()?)");
  }
  return res.data;
}

/** Para operaciones sin retorno (delete/insert sin .select()): solo chequea error. */
export function unwrapVoid(res: { error: Error | null }): void {
  if (res.error) throw res.error;
}

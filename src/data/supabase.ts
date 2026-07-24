import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  throw new Error("Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY en .env");
}

export const supabase = createClient<Database>(url, anonKey);

// Los módulos de src/data/ aceptan un cliente inyectable (default: el de la app) para
// que tests/scripts puedan usar el service key o simular DOS clientes independientes.
export type Db = SupabaseClient<Database>;

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

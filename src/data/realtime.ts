// Realtime (postgres_changes) → invalidación de query keys. UN solo canal para todas
// las tablas mutables; los cambios de otra pestaña/dispositivo refrescan el cache local
// (fin del last-writer-wins que borraba datos).
//
// REQUISITO: las tablas tienen que estar en la publication `supabase_realtime`
// (supabase/migrations/0002_realtime.sql). Verificable con scripts/check-realtime.mjs.
import type { QueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { reportDataError } from "./errors";
import { realtimeInvalidation } from "./keys";
import { supabase } from "./supabase";

const CHANNEL_NAME = "price-desk-db-changes";

/**
 * Suscribe el canal y devuelve el cleanup. Pensado para un useEffect en el shell:
 * `useEffect(() => startRealtime(queryClient), [queryClient])`.
 */
export function startRealtime(qc: QueryClient): () => void {
  let channel: RealtimeChannel = supabase.channel(CHANNEL_NAME);
  for (const [table, rootKey] of realtimeInvalidation) {
    channel = channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table },
      () => {
        void qc.invalidateQueries({ queryKey: rootKey });
      },
    );
  }
  channel.subscribe((status, err) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      // visible: si Realtime no está habilitado o se cae, el hub central lo reporta
      reportDataError({ operation: `realtime (${status})`, error: err ?? new Error(status) });
    }
  });
  return () => {
    void supabase.removeChannel(channel);
  };
}

// Verifica end-to-end que Realtime esté habilitado (0002_realtime.sql aplicado):
// se suscribe a postgres_changes de `suppliers`, inserta y borra una fila de prueba,
// y comprueba que lleguen los eventos.
//
// Uso: node scripts/check-realtime.mjs        (Node 22+, o Node 21 con --experimental-websocket)
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (typeof WebSocket === "undefined") {
  console.error("Este Node no tiene WebSocket nativo. Corré: node --experimental-websocket scripts/check-realtime.mjs");
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const db = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const events = [];
const channel = db
  .channel("check-realtime")
  .on("postgres_changes", { event: "*", schema: "public", table: "suppliers" }, (p) => {
    events.push(p.eventType);
  });

const status = await new Promise((resolve) => {
  channel.subscribe((s, err) => {
    if (s === "SUBSCRIBED") resolve(s);
    if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") resolve(`${s}: ${err?.message ?? ""}`);
  });
  setTimeout(() => resolve("TIMEOUT"), 10_000);
});
console.log("suscripción:", status);

if (status === "SUBSCRIBED") {
  const { data, error } = await db
    .from("suppliers")
    .insert({ name: `check-realtime-${Date.now()}` })
    .select()
    .single();
  if (error) throw error;
  await db.from("suppliers").delete().eq("id", data.id);
  await new Promise((r) => setTimeout(r, 4000));
  if (events.length > 0) {
    console.log(`✅ Realtime HABILITADO — eventos recibidos: ${events.join(", ")}`);
  } else {
    console.log("❌ Realtime NO habilitado: suscripción OK pero cero eventos.");
    console.log("   → correr supabase/migrations/0002_realtime.sql en el SQL editor del proyecto.");
  }
}

await db.removeAllChannels();
process.exit(0);

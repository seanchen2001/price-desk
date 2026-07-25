// Fusión ÚNICA en la base YA migrada (2026-07-25): INTALPER = Ojus (decisión del usuario).
// Mutaciones POR FILA (sin re-correr la migración): repunta invoices.client_id y
// ledger.party_id del fusionado al canónico, completa los datos vacíos del canónico con
// los del fusionado, soft-deletea INTALPER (queda sin referencias) y deja la nota en
// knowledge. Idempotente: re-corrida reporta "ya fusionado" y no toca nada.
// El merge DURABLE para futuras corridas de la migración vive en scripts/migrate.ts
// (CLIENT_MERGES = { INTALPER: "Ojus" }).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
globalThis.WebSocket ??= class {
  close() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
};
const db = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const die = (msg) => {
  console.error("ERROR:", msg);
  process.exit(1);
};

const KNOWLEDGE_NOTE =
  "[[ojus]] INTALPER es el mismo cliente (fusionados 2026-07-25; facturas y saldos unificados bajo Ojus)";

// saldo estilo computeAccounts (cargo facturas − pagos + gastos/cargos manuales)
async function saldoOf(clientId) {
  const inv = (await db.from("invoices").select("type,total,deleted_at").eq("client_id", clientId)).data ?? [];
  const led =
    (await db.from("ledger").select("type,amount").eq("party_type", "client").eq("party_id", clientId)).data ?? [];
  const cargos =
    inv.filter((f) => f.type === "factura" && f.deleted_at === null).reduce((a, f) => a + (Number(f.total) || 0), 0) +
    led.filter((e) => e.type !== "pago").reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const pagos = led.filter((e) => e.type === "pago").reduce((a, e) => a + (Number(e.amount) || 0), 0);
  return +(cargos - pagos).toFixed(2);
}

const clients = (await db.from("clients").select("*")).data ?? [];
const ojus = clients.find((c) => c.name.toLowerCase().includes("ojus"));
const intal = clients.find((c) => c.name.toLowerCase().includes("intalper"));
if (!ojus) die("no encontré el cliente canónico Ojus");
if (!intal) die("no encontré INTALPER (¿ya fusionado y borrado?)");

console.log(`Canónico: "${ojus.name}" (${ojus.id})`);
console.log(`Fusionado: "${intal.name}" (${intal.id})${intal.deleted_at ? " [ya soft-deleteado]" : ""}`);

const before = { ojus: await saldoOf(ojus.id), intalper: await saldoOf(intal.id) };
console.log(`\nSALDOS ANTES  → Ojus: $${before.ojus} · INTALPER: $${before.intalper}`);

// referencias a repuntar
const invRefs = (await db.from("invoices").select("id,no").eq("client_id", intal.id)).data ?? [];
const ledRefs =
  (await db.from("ledger").select("id").eq("party_type", "client").eq("party_id", intal.id)).data ?? [];

if (invRefs.length === 0 && ledRefs.length === 0 && intal.deleted_at !== null) {
  console.log("\nYA FUSIONADO: sin referencias y el cliente está soft-deleteado. Nada que hacer.");
} else {
  // 1) repuntar invoices (por fila)
  for (const f of invRefs) {
    const r = await db.from("invoices").update({ client_id: ojus.id }).eq("id", f.id);
    if (r.error) die(`invoice #${f.no}: ${r.error.message}`);
    console.log(`repunté factura #${f.no} → Ojus`);
  }
  // 2) repuntar ledger (por fila)
  for (const e of ledRefs) {
    const r = await db.from("ledger").update({ party_id: ojus.id }).eq("id", e.id);
    if (r.error) die(`ledger ${e.id}: ${r.error.message}`);
    console.log(`repunté movimiento ${e.id} → Ojus`);
  }
  // 3) canónico con los datos más completos de los dos (lo vacío se llena, trim incluido)
  const clean = (v) => {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  };
  const patch = {};
  for (const k of ["address", "ruc", "phone"]) {
    if (clean(ojus[k]) === null && clean(intal[k]) !== null) patch[k] = clean(intal[k]);
  }
  if (intal.cuenta_corriente === true && ojus.cuenta_corriente !== true) patch.cuenta_corriente = true;
  if (Object.keys(patch).length > 0) {
    const r = await db.from("clients").update(patch).eq("id", ojus.id);
    if (r.error) die(`update Ojus: ${r.error.message}`);
    console.log("completé datos del canónico:", JSON.stringify(patch));
  }
  // 4) soft-delete del fusionado (el schema lo permite; queda auditable y sin referencias)
  if (intal.deleted_at === null) {
    const r = await db.from("clients").update({ deleted_at: new Date().toISOString() }).eq("id", intal.id);
    if (r.error) die(`soft-delete INTALPER: ${r.error.message}`);
    console.log("soft-delete de INTALPER listo");
  }
}

// 5) memoria del agente (idempotente por texto exacto)
const existing = await db.from("knowledge").select("id").eq("rule_text", KNOWLEDGE_NOTE).maybeSingle();
if (existing.error) die(existing.error.message);
if (!existing.data) {
  const r = await db.from("knowledge").insert({ rule_text: KNOWLEDGE_NOTE });
  if (r.error) die(`knowledge: ${r.error.message}`);
  console.log("nota guardada en knowledge");
} else {
  console.log("nota de knowledge ya existía");
}

// verificación final
const after = { ojus: await saldoOf(ojus.id), intalper: await saldoOf(intal.id) };
const restInv = (await db.from("invoices").select("id", { count: "exact", head: true }).eq("client_id", intal.id)).count;
const restLed = (
  await db.from("ledger").select("id", { count: "exact", head: true }).eq("party_type", "client").eq("party_id", intal.id)
).count;
console.log(`\nSALDOS DESPUÉS → Ojus: $${after.ojus} · INTALPER: $${after.intalper}`);
console.log(`referencias colgando a INTALPER: invoices=${restInv} · ledger=${restLed}`);
if (restInv !== 0 || restLed !== 0) die("quedaron referencias a INTALPER");
if (Math.abs(after.ojus - (before.ojus + before.intalper)) > 0.005) die("el saldo fusionado no cierra");
console.log("\nOK: cuenta única Ojus con el neto esperado.");

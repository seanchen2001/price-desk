// Reasignación ÚNICA (re-corrible: idempotente) de los modelos migrados a categorías
// finas para que las secciones de la Mesa queden cortas:
//   Samsung Gama Alta (S/Z: Sxx, Z Fold, Z Flip, Ultra) · Samsung Gama Baja (A/M/F-series)
//   Motorola LATIN / Motorola EURO (se respeta el spec ya asignado; XT→EURO, Motorola→LATIN)
//   iPhone Último Modelo (la generación más alta presente) · iPhone Otros
//   Computadoras · Otros (ambiguos → Otros y se LISTAN en el reporte)
// Regla 100% determinística por patrón de nombre. Solo toca models.category_id (update
// por fila); NO borra nada, NO toca precios/facturas. Imprime el reporte completo.
//
// Uso:  node scripts/recategorize.mjs           (aplica)
//       node scripts/recategorize.mjs --dry     (solo reporte, sin escribir)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DRY = process.argv.includes("--dry");

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

const FINE_CATEGORIES = [
  "Samsung Gama Alta",
  "Samsung Gama Baja",
  "Motorola LATIN",
  "Motorola EURO",
  "iPhone Último Modelo",
  "iPhone Otros",
  "Computadoras",
  "Otros",
];

// asegura las categorías finas (no pisa nada existente)
{
  const res = await db
    .from("categories")
    .upsert(FINE_CATEGORIES.map((name) => ({ name })), {
      onConflict: "name",
      ignoreDuplicates: true,
    });
  if (res.error) throw res.error;
}

const cats = (await db.from("categories").select("id,name")).data ?? [];
const depts = (await db.from("departments").select("id,name")).data ?? [];
const catIdByName = new Map(cats.map((c) => [c.name, c.id]));
const catNameById = new Map(cats.map((c) => [c.id, c.name]));
const deptNameById = new Map(depts.map((d) => [d.id, d.name]));

const modelsRes = await db
  .from("models")
  .select("id, canonical_name, category_id, department_id, deleted_at")
  .is("deleted_at", null)
  .order("canonical_name");
if (modelsRes.error) throw modelsRes.error;
const models = modelsRes.data;

// generación iPhone más alta presente (para "Último Modelo")
const IPHONE_GEN = /iphone\s*(\d{2})/i;
let maxGen = 0;
for (const m of models) {
  const g = IPHONE_GEN.exec(m.canonical_name);
  if (g) maxGen = Math.max(maxGen, Number(g[1]));
}

/** regla determinística → { cat, ambiguous? } */
function classify(m) {
  const n = m.canonical_name.trim();
  const lower = n.toLowerCase();
  const currentCat = catNameById.get(m.category_id) ?? null;
  const dept = deptNameById.get(m.department_id) ?? null;

  if (/iphone/i.test(lower)) {
    const g = IPHONE_GEN.exec(lower);
    if (g && Number(g[1]) === maxGen) return { cat: "iPhone Último Modelo" };
    return { cat: "iPhone Otros" };
  }
  if (
    dept === "Laptops" ||
    /\b(macbook|laptop|notebook|thinkpad|ideapad|chromebook|imac|mac mini|victus|pavilion)\b/i.test(lower)
  ) {
    return { cat: "Computadoras" };
  }
  // Motorola: el spec LATIN/EURO ya está codificado en la categoría actual y en el nombre
  if (/^xt\d/i.test(lower)) return { cat: "Motorola EURO" };
  if (/^(motorola|moto)\b/i.test(lower)) return { cat: "Motorola LATIN" };
  if (currentCat === "Motorola EURO" || currentCat === "Motorola LATIN") return { cat: currentCat };

  if (/\btab\b/i.test(lower)) return { cat: "Otros", ambiguous: "tablet (¿Samsung Tab?)" };
  // Samsung gama alta: S-series numérica, Z Fold/Flip, Ultra
  if (/^(galaxy\s+)?(s\d{2}\b|z\s?fold|z\s?flip)/i.test(lower) || /\bultra\b/i.test(lower)) {
    return { cat: "Samsung Gama Alta" };
  }
  // Samsung gama baja: A/M/F-series numérica
  if (/^(galaxy\s+)?[amf]\d{2}\b/i.test(lower)) return { cat: "Samsung Gama Baja" };

  return { cat: "Otros", ambiguous: "sin patrón conocido" };
}

const byTarget = new Map(FINE_CATEGORIES.map((c) => [c, []]));
const ambiguous = [];
const moves = [];
for (const m of models) {
  const { cat, ambiguous: reason } = classify(m);
  byTarget.get(cat).push(m.canonical_name);
  if (reason) ambiguous.push(`${m.canonical_name} — ${reason}`);
  const targetId = catIdByName.get(cat);
  if (!targetId) throw new Error(`Categoría destino sin id: ${cat}`);
  if (m.category_id !== targetId) {
    moves.push({ id: m.id, name: m.canonical_name, from: catNameById.get(m.category_id) ?? "—", to: cat, targetId });
  }
}

console.log(`\n=== REASIGNACIÓN DE CATEGORÍAS ${DRY ? "(DRY-RUN, no escribe)" : ""} ===`);
console.log(`modelos: ${models.length} · a mover: ${moves.length} · sin cambio: ${models.length - moves.length}\n`);
for (const cat of FINE_CATEGORIES) {
  const list = byTarget.get(cat);
  if (!list.length) {
    console.log(`— ${cat}: (vacía)`);
    continue;
  }
  console.log(`— ${cat} (${list.length}):`);
  for (const name of list) console.log(`    ${name}`);
}
console.log(`\nAMBIGUOS → Otros (${ambiguous.length}):${ambiguous.length ? "" : " ninguno"}`);
for (const a of ambiguous) console.log(`    ${a}`);
console.log(`\nMOVIMIENTOS (${moves.length}):`);
for (const mv of moves) console.log(`    ${mv.name}: ${mv.from} → ${mv.to}`);

if (!DRY) {
  for (const mv of moves) {
    const res = await db
      .from("models")
      .update({ category_id: mv.targetId, updated_at: new Date().toISOString() })
      .eq("id", mv.id);
    if (res.error) throw new Error(`update ${mv.name}: ${res.error.message}`);
  }
  console.log(`\nOK: ${moves.length} modelos actualizados (solo category_id, por fila).`);
}

// Genera src/data/database.types.ts desde el OpenAPI de PostgREST (schema real aplicado).
// Uso: node scripts/gen-types.mjs   (lee .env: VITE_SUPABASE_URL + SUPABASE_SERVICE_KEY)
import { readFileSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const url = env.VITE_SUPABASE_URL.replace(/\/$/, "");
const key = env.SUPABASE_SERVICE_KEY;
const spec = await (await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })).json();

const tsType = (p) => {
  const fmt = p.format ?? "";
  if (fmt.includes("json")) return "Json";
  switch (p.type) {
    case "integer": case "number": return "number";
    case "boolean": return "boolean";
    default: return "string";   // text, uuid, date, timestamptz, numeric(text en PostgREST)
  }
};

let out = `// GENERADO por scripts/gen-types.mjs contra el schema real — NO editar a mano.
// Regenerar tras cada migración: node scripts/gen-types.mjs
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
`;
for (const [name, def] of Object.entries(spec.definitions ?? {}).sort()) {
  const req = new Set(def.required ?? []);
  const cols = Object.entries(def.properties ?? {});
  const row = cols.map(([c, p]) => {
    const base = tsType(p);
    const nullable = !req.has(c);
    return `          ${c}: ${base}${nullable ? " | null" : ""};`;
  }).join("\n");
  const ins = cols.map(([c, p]) => {
    const base = tsType(p);
    const hasDefault = p.default !== undefined || (p.description ?? "").includes("Primary Key");
    const nullable = !req.has(c);
    const optional = hasDefault || nullable;
    return `          ${c}${optional ? "?" : ""}: ${base}${nullable ? " | null" : ""};`;
  }).join("\n");
  const upd = cols.map(([c, p]) => `          ${c}?: ${tsType(p)}${req.has(c) ? "" : " | null"};`).join("\n");
  // Relationships: [] — requerido por GenericTable de supabase-js (sin él, los tipos
  // de .insert()/.update() colapsan a never). No tipamos las FKs (no usamos joins tipados).
  out += `      ${name}: {\n        Row: {\n${row}\n        };\n        Insert: {\n${ins}\n        };\n        Update: {\n${upd}\n        };\n        Relationships: [];\n      };\n`;
}
out += `    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
`;
writeFileSync("src/data/database.types.ts", out);
console.log(`✅ src/data/database.types.ts generado (${Object.keys(spec.definitions ?? {}).length} tablas)`);

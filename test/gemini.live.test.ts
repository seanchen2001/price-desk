// Fase 8 — verificación REAL contra Gemini (y Supabase para el flujo ejecutado).
// Se corre A MANO con la key: GEMINI_LIVE=1 npx vitest run test/gemini.live.test.ts
// (sin GEMINI_LIVE se SKIPEA: `npm test` no toca la red).
//
// Cubre los 3 puntos del AC:
//   1) extracción con escalera y variante → el JSON respeta el contrato (tiers, no líneas
//      nuevas; rawName textual, nada inventado)
//   2) agente function-calling DRY-RUN: "crea la categoría Samsung Gama Alta y mové el
//      S26 ahí" → tool calls correctos SIN ejecutar nada
//   3) flujo ejecutado real: create_category + move_model_category contra la base
//      (queda como demo coherente: el S26 en "Samsung Gama Alta")
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { forwardGemini } from "../api/_geminiCore";
import { normalize } from "../src/domain/normalize";
import {
  buildExtractionSystem,
  extractedToQuoteEntries,
  EXTRACTION_RESPONSE_SCHEMA,
  parseExtractionJson,
} from "../src/features/agent/extraction";
import type { GeminiContent, GeminiFunctionCall, GeminiPart } from "../src/features/agent/gemini";
import { AGENT_TOOLS, buildAgentSystem } from "../src/features/agent/tools";

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && !line.trim().startsWith("#")) {
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
  }
  for (const k of ["GEMINI_API_KEY", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_KEY"]) {
    const v = process.env[k];
    if (v && !out[k]) out[k] = v;
  }
  return out;
}

const env = loadEnv();
const KEY = env["GEMINI_API_KEY"] ?? "";
const LIVE = process.env["GEMINI_LIVE"] === "1" && KEY !== "";
const HAS_DB = (env["VITE_SUPABASE_URL"] ?? "") !== "" && (env["SUPABASE_SERVICE_KEY"] ?? "") !== "";
const TIMEOUT = 60_000;

type LiveResponse = {
  candidates?: Array<{ content?: { role?: string; parts?: GeminiPart[] } }>;
  error?: { message?: string };
};

async function callLive(payload: Parameters<typeof forwardGemini>[0]): Promise<LiveResponse> {
  const out = await forwardGemini(payload, KEY);
  const data = JSON.parse(out.body) as LiveResponse;
  if (out.status !== 200) {
    throw new Error(`Gemini ${out.status}: ${data.error?.message ?? out.body.slice(0, 300)}`);
  }
  return data;
}

const partsOf = (r: LiveResponse): GeminiPart[] => r.candidates?.[0]?.content?.parts ?? [];
const textOf = (r: LiveResponse): string => partsOf(r).map((p) => p.text ?? "").join("");
const callsOf = (r: LiveResponse): GeminiFunctionCall[] =>
  partsOf(r)
    .map((p) => p.functionCall)
    .filter((c): c is GeminiFunctionCall => c !== undefined);

// el quote del AC: escalera + variante "Galaxy" del mismo modelo
const QUOTE = [
  "S26 12+512 5G DS (20 pcs) 610",
  "S26 12+512 5G DS (50+ pcs) 595",
  "Galaxy S26 12+512 620",
].join("\n");

describe.skipIf(!LIVE)("Fase 8 — Gemini REAL: extracción propose-only", () => {
  it(
    "escalera va en tiers (jamás líneas nuevas) y rawName es textual",
    async () => {
      const res = await callLive({
        system: buildExtractionSystem(),
        content: QUOTE,
        responseSchema: EXTRACTION_RESPONSE_SCHEMA,
        maxTokens: 8192,
      });
      const items = parseExtractionJson(textOf(res));
      expect(items.length).toBeGreaterThanOrEqual(1);

      // rawName TEXTUAL: cada nombre devuelto normaliza a la clave de alguna línea del
      // input (no hay nombres canónicos inventados ni modelos completados)
      const inputKeys = new Set(
        QUOTE.split("\n").map((l) => normalize(l.replace(/[\d.,]+\s*$/, ""))),
      );
      for (const item of items) {
        expect(inputKeys.has(normalize(item.rawName)), `rawName inventado: ${item.rawName}`).toBe(
          true,
        );
        expect([610, 595, 620]).toContain(item.price);
      }

      // la escalera 20→610 / 50→595 vive en tiers de UN ítem
      const ladder = items.find((i) => i.tiers.length >= 2);
      expect(ladder, "ningún ítem trajo la escalera en tiers").toBeDefined();
      const rungs = new Map(ladder!.tiers.map((t) => [t.min_qty, t.price]));
      expect(rungs.get(20)).toBe(610);
      expect(rungs.get(50)).toBe(595);

      // plegado defensivo: el flujo entero produce a lo sumo 2 entradas (S26 DS + Galaxy)
      const entries = extractedToQuoteEntries(items);
      expect(entries.length).toBeLessThanOrEqual(2);
      const s26 = entries.find((e) => e.aliasKey === normalize("S26 12+512 5G DS"));
      expect(s26?.tiers.length ?? 0).toBeGreaterThanOrEqual(2);
    },
    TIMEOUT,
  );
});

const AGENT_CTX = {
  departments: ["Teléfonos", "iPhone", "Laptops", "Otros"],
  categories: ["Samsung", "Motorola LATIN", "Motorola EURO", "iPhone", "Laptops", "Otros"],
  suppliers: ["Planet", "Vitel"],
  modelCount: 4,
};

describe.skipIf(!LIVE)("Fase 8 — Gemini REAL: agente function-calling (dry-run)", () => {
  it(
    "'crea la categoría Samsung Gama Alta y mové el S26 ahí' → tools correctas SIN ejecutar",
    async () => {
      const contents: GeminiContent[] = [
        {
          role: "user",
          parts: [
            {
              text: "creá la categoría Samsung Gama Alta y mové el modelo S26 12+512 5G DS ahí",
            },
          ],
        },
      ];
      const seen: GeminiFunctionCall[] = [];
      for (let turn = 0; turn < 4; turn++) {
        const res = await callLive({
          system: buildAgentSystem(AGENT_CTX),
          contents,
          tools: AGENT_TOOLS,
          maxTokens: 2048,
        });
        const content = r2content(res);
        contents.push(content);
        const calls = callsOf(res);
        if (calls.length === 0) break;
        seen.push(...calls);
        // DRY-RUN: respondemos éxito sintético, NADA se ejecuta contra la base
        contents.push({
          role: "user",
          parts: calls.map((c) => ({
            functionResponse: { name: c.name, response: { ok: true, dry_run: true } },
          })),
        });
      }
      const names = seen.map((c) => c.name);
      expect(names).toContain("create_category");
      expect(names).toContain("move_model_category");
      const create = seen.find((c) => c.name === "create_category");
      expect(String(create?.args?.["name"] ?? "")).toMatch(/samsung gama alta/i);
      const move = seen.find((c) => c.name === "move_model_category");
      expect(String(move?.args?.["model"] ?? "")).toMatch(/s26/i);
      expect(String(move?.args?.["category"] ?? "")).toMatch(/gama alta/i);
    },
    TIMEOUT,
  );
});

function r2content(r: LiveResponse): GeminiContent {
  return { role: "model", parts: partsOf(r) };
}

describe.skipIf(!LIVE || !HAS_DB)("Fase 8 — flujo EJECUTADO real: create_category + move", () => {
  it(
    "crea 'Samsung Gama Alta' y mueve el S26 (queda como demo coherente)",
    async () => {
      // stub de WebSocket para createClient en Node (igual que mesa.integration)
      (globalThis as { WebSocket?: unknown }).WebSocket ??= class {
        close(): void {}
        send(): void {}
        addEventListener(): void {}
        removeEventListener(): void {}
      };
      const { createClient } = await import("@supabase/supabase-js");
      const { buildLiveDeps } = await import("../src/features/agent/liveDeps");
      const { executeTool } = await import("../src/features/agent/executor");
      const db = createClient(env["VITE_SUPABASE_URL"]!, env["SUPABASE_SERVICE_KEY"]!);
      const deps = buildLiveDeps(db as never);

      const created = await executeTool(
        { name: "create_category", args: { name: "Samsung Gama Alta" } },
        deps,
      );
      expect(created["creada"] === true || created["ya_existe"] === true).toBe(true);

      const moved = await executeTool(
        { name: "move_model_category", args: { model: "S26 12+512 5G DS", category: "Samsung Gama Alta" } },
        deps,
      );
      expect(moved["ok"]).toBe(true);

      // verificación contra la base: el S26 quedó en la categoría nueva
      const cat = await db
        .from("categories")
        .select("id")
        .eq("name", "Samsung Gama Alta")
        .single();
      expect(cat.error).toBeNull();
      const model = await db
        .from("models")
        .select("category_id, canonical_name")
        .eq("canonical_name", "S26 12+512 5G DS")
        .single();
      expect(model.error).toBeNull();
      expect((model.data as { category_id: string }).category_id).toBe(
        (cat.data as { id: string }).id,
      );
    },
    TIMEOUT,
  );
});

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
import { forwardGemini } from "../api/_geminiCore";
import { loadDeskEnv } from "../scripts/lib/env";
import { normalize } from "../src/domain/normalize";
import {
  buildExtractionSystem,
  extractedToQuoteEntries,
  EXTRACTION_RESPONSE_SCHEMA,
  parseExtractionJson,
} from "../src/features/agent/extraction";
import type { GeminiContent, GeminiFunctionCall, GeminiPart } from "../src/features/agent/gemini";
import { AGENT_TOOLS, buildAgentSystem } from "../src/features/agent/tools";


const env = loadDeskEnv();
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

describe.skipIf(!LIVE)("Negociador REAL — analyze → apply parcial → counter_offer (dry-run)", () => {
  it(
    "una negociación simulada end-to-end elige las tools y selectores correctos",
    async () => {
      const system = buildAgentSystem(AGENT_CTX);
      const contents: GeminiContent[] = [];
      const allCalls: GeminiFunctionCall[] = [];

      // corre turnos hasta que el modelo deja de llamar tools; responde SINTÉTICO (dry-run)
      const runTurns = async (respond: (c: GeminiFunctionCall) => Record<string, unknown>) => {
        for (let i = 0; i < 4; i++) {
          const res = await callLive({ system, contents, tools: AGENT_TOOLS, maxTokens: 2048 });
          contents.push(r2content(res));
          const calls = callsOf(res);
          if (calls.length === 0) break;
          allCalls.push(...calls);
          contents.push({
            role: "user",
            parts: calls.map((c) => ({
              functionResponse: { name: c.name, response: respond(c) },
            })),
          });
        }
      };

      // 1) el usuario pega la lista → analyze_quote (staging, sin aplicar)
      contents.push({
        role: "user",
        parts: [
          {
            text:
              "te paso la lista de Planet:\nS26 12+512 5G DS 585\nS26 ULTRA 12/512GB 5G 940\nA17 4+128 DS 118",
          },
        ],
      });
      const analysis = {
        proveedor: "Planet",
        resumen: { oportunidades: 1, en_linea: 1, caras: 1, sin_referencia: 0, frase: "1 oportunidad — aplicala; 1 cara — pedí mejora" },
        lineas: [
          { modelo: "S26 12+512 5G DS", precio: 585, clasificacion: "oportunidad", vs_min_pct: -2.5, min: { precio: 600, proveedor: "Bax" } },
          { modelo: "S26 ULTRA 12/512GB 5G", precio: 940, clasificacion: "en_linea", vs_min_pct: 0.5, min: { precio: 935, proveedor: "Bax" } },
          { modelo: "A17 4+128 DS", precio: 118, clasificacion: "caro", vs_min_pct: 7.3, min: { precio: 110, proveedor: "Vitel" } },
        ],
        nuevos_en_cola: [],
        nota: "NADA se aplicó: quedó en la mesa de negociación.",
      };
      await runTurns((c) => (c.name === "analyze_quote" ? analysis : { ok: true, dry_run: true }));
      expect(allCalls.some((c) => c.name === "analyze_quote")).toBe(true);
      const aq = allCalls.find((c) => c.name === "analyze_quote")!;
      expect(String(aq.args?.["supplier"] ?? "")).toMatch(/planet/i);
      expect(String(aq.args?.["text"] ?? "")).toContain("585"); // texto completo, no resumido

      // 2) aplicar SOLO las oportunidades
      const before = allCalls.length;
      contents.push({ role: "user", parts: [{ text: "dale, aplicá solo las oportunidades" }] });
      await runTurns((c) =>
        c.name === "apply_lines"
          ? { proveedor: "Planet", aplicadas: [{ modelo: "S26 12+512 5G DS", precio: 585 }], quedan_en_mesa: 2 }
          : { ok: true, dry_run: true },
      );
      const applied = allCalls.slice(before).find((c) => c.name === "apply_lines");
      expect(applied).toBeDefined();
      expect(applied?.args?.["classification"]).toBe("oportunidad");

      // 3) contraoferta para las caras
      const before2 = allCalls.length;
      contents.push({
        role: "user",
        parts: [{ text: "armame la contraoferta para Planet por lo que quedó caro" }],
      });
      await runTurns((c) =>
        c.name === "counter_offer"
          ? {
              proveedor: "Planet",
              lineas: [{ modelo: "A17 4+128 DS", ofrecido: 118, nuestro_min: 110, min_de: "Vitel", objetivo: 110 }],
              texto_whatsapp: "Hola Planet, revisé tu lista. A17 4+128 DS\tme pasaste $118 · lo tengo a $110 → te cierro a $110",
            }
          : { ok: true, dry_run: true },
      );
      expect(allCalls.slice(before2).some((c) => c.name === "counter_offer")).toBe(true);
    },
    TIMEOUT * 2,
  );
});

describe.skipIf(!LIVE)("P4 — triage QA real: anti-alucinación (ids ⊆ input)", () => {
  it(
    "el LLM prioriza SOLO ids provistos; los inventados se filtran",
    async () => {
      const { triageQaFindings } = await import("../scripts/lib/qa-task");
      const { makeDirectGeminiFetch } = await import("../scripts/lib/gemini");
      const findings = [
        {
          id: "lista_below_cost:mLB",
          tipo: "lista_below_cost" as const,
          severidad: "critico" as const,
          modelo: "ListaBaja 8+256",
          detalle: "Lista $150 DEBAJO del mejor costo $200",
        },
        {
          id: "stale:spStale",
          tipo: "stale" as const,
          severidad: "bajo" as const,
          proveedor: "Viejo",
          detalle: "2 precios vencidos",
        },
      ];
      const triage = await triageQaFindings(findings, makeDirectGeminiFetch(KEY));
      expect(triage.resumen.length).toBeGreaterThan(10);
      expect(triage.prioridades.length).toBeGreaterThan(0);
      const validIds = new Set(findings.map((f) => f.id));
      for (const p of triage.prioridades) {
        expect(validIds.has(p.id), `id alucinado: ${p.id}`).toBe(true);
      }
      // lo crítico debería venir priorizado arriba
      const lb = triage.prioridades.find((p) => p.id === "lista_below_cost:mLB");
      expect(lb?.prioridad).toBe(1);
    },
    TIMEOUT,
  );
});

describe.skipIf(!LIVE || !HAS_DB)("Fase 8 — flujo EJECUTADO real: create_category + move", () => {
  it(
    "crea 'Samsung Gama Alta' y mueve el S26 (queda como demo coherente)",
    async () => {
      const { makeServiceDb } = await import("../scripts/lib/db");
      const { buildLiveDeps } = await import("../src/features/agent/liveDeps");
      const { executeTool } = await import("../src/features/agent/executor");
      const db = makeServiceDb(env);
      const deps = buildLiveDeps(db);

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

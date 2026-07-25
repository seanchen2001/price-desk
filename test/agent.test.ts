// Fase 8 — unit tests del lado IA SIN red ni base:
//   1) prompt-builder + saneo de la extracción (contrato propose-only, plegado de tiers)
//   2) mapeo tools→mutaciones del ejecutor (deps mockeadas — la identidad la cubren los
//      golden del resolver; acá se verifica QUÉ mutación se llama y con qué IDs)
//   3) transporte /api/gemini (fetch mockeado): parseo, errores ruidosos
//   4) clientPulse portado (puro)
import { describe, expect, it, vi } from "vitest";
import { normalize } from "../src/domain/normalize";
import { clientPulse } from "../src/domain/pulse";
import {
  analyzeOffer,
  counterOffer,
  discountPlan,
  encodeNote,
  noteAbout,
  orderNotesByMention,
  recallNotes,
  selectLines,
} from "../src/domain/negotiation";
import { listaPrice, whatsappQuoteText } from "../src/domain/whatsapp";
import {
  applyGate,
  buildExtractionSystem,
  checkQuoteEntry,
  deltaPct,
  extractedToQuoteEntries,
  EXTRACTION_RESPONSE_SCHEMA,
  parseExtractionJson,
  PRICE_AUTO_THRESHOLD,
  toPrice,
  withinAutoThreshold,
} from "../src/features/agent/extraction";
import {
  executeTool,
  EXECUTABLE_TOOLS,
  matchSupplier,
  type ToolDeps,
} from "../src/features/agent/executor";
import {
  DEFAULT_LIMITS,
  wrapDepsWithPolicy,
  type AgentPolicy,
  type PolicyEvent,
} from "../src/features/agent/policy";
import { mockDeps, setAgentRunRows, setKnowledgeRows } from "./helpers/mockDeps";
import { functionCallsOf, generateText, generateTurn, textOf } from "../src/features/agent/gemini";
import {
  AGENT_TOOLS,
  buildAgentSystem,
  CONFIRM_TOOLS,
  MUTATING_TOOLS,
  TOOL_NAMES,
} from "../src/features/agent/tools";

// ---------- extracción ----------

describe("Fase 8 — prompt de extracción (contrato propose-only)", () => {
  it("el system prompt endurecido fija el contrato", () => {
    const sys = buildExtractionSystem();
    expect(sys).toContain("rawName");
    expect(sys).toContain("tiers");
    expect(sys).toMatch(/NO inventes un nombre canónico/);
    expect(sys).toMatch(/PROHIBIDO devolver esos escalones como ítems separados/);
    expect(sys).toMatch(/NO completes RAM/);
  });

  it("el responseSchema exige rawName + price y tipa los tiers", () => {
    expect(EXTRACTION_RESPONSE_SCHEMA.type).toBe("ARRAY");
    expect(EXTRACTION_RESPONSE_SCHEMA.items.required).toEqual(["rawName", "price"]);
    expect(EXTRACTION_RESPONSE_SCHEMA.items.properties.tiers.items.required).toEqual([
      "min_qty",
      "price",
    ]);
  });
});

describe("Fase 8 — saneo de la respuesta de extracción", () => {
  it("parsea, tira lo malformado y ordena los tiers", () => {
    const raw = JSON.stringify([
      {
        rawName: "S26 12+512 5G DS",
        supplier: "Bax",
        price: 620,
        tiers: [
          { min_qty: 50, price: 595 },
          { min_qty: 1, price: 620 },
          { min_qty: 20, price: 610 },
          { min_qty: 5, price: "no-precio" }, // malformado → afuera
        ],
      },
      { rawName: "", price: 100 }, // sin nombre → afuera
      { rawName: "A17 4+128 DS", price: "1.105,00" }, // precio AR-string → 1105
      { rawName: "X sin precio" }, // sin precio → afuera
    ]);
    const items = parseExtractionJson("```json\n" + raw + "\n```"); // tolera fences
    expect(items).toHaveLength(2);
    expect(items[0]?.tiers.map((t) => t.min_qty)).toEqual([1, 20, 50]);
    expect(items[1]?.price).toBe(1105);
  });

  it("respuesta no-array → error ruidoso", () => {
    expect(() => parseExtractionJson('{"matched":{}}')).toThrow(/array/i);
    expect(() => parseExtractionJson("truncado{{{")).toThrow(/malformada/);
  });

  it("toPrice: formatos AR/EN/number", () => {
    expect(toPrice("1.105,00")).toBe(1105);
    expect(toPrice("1,105.00")).toBe(1105);
    expect(toPrice("$610")).toBe(610);
    expect(toPrice(595.5)).toBe(595.5);
    expect(toPrice(-3)).toBeNull();
    expect(toPrice("")).toBeNull();
  });

  it("contrato bien cumplido: un ítem con escalera → UNA entrada con tiers", () => {
    const entries = extractedToQuoteEntries([
      {
        rawName: "S26 12+512 5G DS",
        supplier: "",
        price: 620,
        tiers: [
          { min_qty: 1, price: 620 },
          { min_qty: 20, price: 610 },
          { min_qty: 50, price: 595 },
        ],
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tiers).toHaveLength(3);
    expect(entries[0]?.price).toBe(595); // la celda muestra el mejor precio (semántica del parser)
  });

  it("red defensiva: escalones como ítems separados '(N pcs)' se PLIEGAN (jamás filas)", () => {
    const entries = extractedToQuoteEntries([
      { rawName: "S26 12+512 5G DS (20 pcs)", supplier: "", price: 610, tiers: [] },
      { rawName: "S26 12+512 5G DS (50+ pcs)", supplier: "", price: 595, tiers: [] },
      { rawName: "S26 12+512 5G DS", supplier: "", price: 620, tiers: [] },
    ]);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e?.aliasKey).toBe(normalize("S26 12+512 5G DS"));
    expect(e?.rawName).toBe("S26 12+512 5G DS"); // representante sin "(N pcs)"
    expect(e?.tiers).toEqual([
      { min_qty: 1, price: 620 },
      { min_qty: 20, price: 610 },
      { min_qty: 50, price: 595 },
    ]);
  });

  it("umbral de auto-aplicación portado del viejo (±15%)", () => {
    expect(PRICE_AUTO_THRESHOLD).toBe(15);
    expect(withinAutoThreshold(null, 600)).toBe(true); // sin precio previo → auto
    expect(withinAutoThreshold(600, 660)).toBe(true); // +10%
    expect(withinAutoThreshold(600, 720)).toBe(false); // +20%
    expect(deltaPct(600, 660)).toBeCloseTo(10);
  });
});

// ---------- tools / ejecutor ----------





describe("Fase 8 — declaraciones de tools", () => {
  it("cada tool declarada tiene ejecutor; load_quote queda como alias legado", () => {
    for (const t of TOOL_NAMES) expect(EXECUTABLE_TOOLS.has(t), t).toBe(true);
    expect(TOOL_NAMES.has("analyze_quote")).toBe(true);
    expect(TOOL_NAMES.has("load_quote")).toBe(false); // no se declara (alias en el executor)
    expect(EXECUTABLE_TOOLS.has("load_quote")).toBe(true);
  });

  it("las destructivas piden confirmación y todas las de escritura invalidan cache", () => {
    expect(CONFIRM_TOOLS.has("delete_price")).toBe(true);
    expect(CONFIRM_TOOLS.has("toggle_supplier")).toBe(true);
    expect(CONFIRM_TOOLS.has("set_price")).toBe(false);
    for (const t of CONFIRM_TOOLS) expect(MUTATING_TOOLS.has(t)).toBe(true);
    for (const t of MUTATING_TOOLS) expect(TOOL_NAMES.has(t)).toBe(true);
    expect(MUTATING_TOOLS.has("apply_lines")).toBe(true); // aplica precios
    expect(MUTATING_TOOLS.has("remember")).toBe(true); // escribe knowledge
    expect(MUTATING_TOOLS.has("analyze_quote")).toBe(false); // solo stagea
  });

  it("el system del agente lleva el contexto dinámico", () => {
    const sys = buildAgentSystem({
      departments: ["Teléfonos", "iPhone"],
      categories: ["Samsung", "Samsung Gama Alta"],
      suppliers: ["Bax", "South"],
      modelCount: 42,
      knowledge: ["Los iPhone van al depto iPhone"],
      activeTab: "Órdenes",
    });
    expect(sys).toContain("Samsung Gama Alta");
    expect(sys).toContain("Bax, South");
    expect(sys).toContain("42");
    expect(sys).toContain("Los iPhone van al depto iPhone");
    expect(sys).toContain('tab "Órdenes"'); // contexto del panel lateral (tab activo)
    expect(sys).toMatch(/resolvedor/);
    // sin activeTab no se inyecta la línea de contexto
    expect(
      buildAgentSystem({ departments: [], categories: [], suppliers: [], modelCount: 0 }),
    ).not.toContain("mirando el tab");
    expect(AGENT_TOOLS[0]?.function_declarations.length).toBe(TOOL_NAMES.size);
  });
});

describe("Fase 8 — ejecutor: tools → mutaciones por fila (deps mockeadas)", () => {
  it("create_model con nombre YA existente (variante) NO duplica: devuelve el existente", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "create_model", args: { name: "Galaxy S26 12+512 5G DS (US SPECS)" } },
      deps,
    );
    expect(r["ya_existe"]).toBe(true);
    expect(r["model_id"]).toBe("m1");
    expect(deps.createModelWithAlias).not.toHaveBeenCalled();
  });

  it("create_model nuevo → createModelWithAlias con IDs de depto/categoría resueltos", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      {
        name: "create_model",
        args: { name: "S27 12+512", department: "teléfonos", category: "samsung gama alta" },
      },
      deps,
    );
    expect(r["creado"]).toBe(true);
    expect(deps.createModelWithAlias).toHaveBeenCalledWith("S27 12+512", {
      category_id: "c-alta",
      department_id: "d-tel",
    });
  });

  it("create_model con categoría inexistente → error (no adivina, no crea)", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "create_model", args: { name: "S27 12+512", category: "Gama Suprema" } },
      deps,
    );
    expect(String(r["error"])).toMatch(/create_category/);
    expect(deps.createModelWithAlias).not.toHaveBeenCalled();
  });

  it("move_model_category resuelve modelo por alias y categoría por nombre (ci)", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "move_model_category", args: { model: "galaxy s26 12+512 5g ds", category: "SAMSUNG GAMA ALTA" } },
      deps,
    );
    expect(r["ok"]).toBe(true);
    expect(deps.setModelCategory).toHaveBeenCalledWith("m1", "c-alta");
  });

  it("modelo no resuelto → error con parecidos, sin tocar la base", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "set_price", args: { model: "S99 Ultra", supplier: "Bax", price: 500 } },
      deps,
    );
    expect(String(r["error"])).toMatch(/No encontré el modelo/);
    expect(deps.upsertPrice).not.toHaveBeenCalled();
  });

  it("set_price → upsert por fila + history append, con delta vs anterior", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "set_price", args: { model: "S26 12+512 5G DS", supplier: "bax", price: 630 } },
      deps,
    );
    expect(r["ok"]).toBe(true);
    expect(r["precio_anterior"]).toBe(600);
    expect(r["variacion_pct"]).toBe(5);
    const row = { model_id: "m1", supplier_id: "s-bax", price: 630 };
    expect(deps.upsertPrice).toHaveBeenCalledWith(row);
    expect(deps.appendPriceHistory).toHaveBeenCalledWith(row);
  });

  it("set_tiers → escalera del PAR (scoped) + celda al mejor precio", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      {
        name: "set_tiers",
        args: {
          model: "S26 12+512 5G DS",
          supplier: "Bax",
          tiers: [
            { min_qty: 50, price: 595 },
            { min_qty: 1, price: 620 },
          ],
        },
      },
      deps,
    );
    expect(r["ok"]).toBe(true);
    expect(deps.setTiersForPair).toHaveBeenCalledWith({ model_id: "m1", supplier_id: "s-bax" }, [
      { min_qty: 1, price: 620 },
      { min_qty: 50, price: 595 },
    ]);
    expect(deps.upsertPrice).toHaveBeenCalledWith({ model_id: "m1", supplier_id: "s-bax", price: 595 });
  });

  it("set_sale_price sin price → borra la Lista manual (vuelve a automática)", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "set_sale_price", args: { model: "A17 4+128 DS" } },
      deps,
    );
    expect(r["ok"]).toBe(true);
    expect(deps.deleteSalePrice).toHaveBeenCalledWith("m2");
    expect(deps.upsertSalePrice).not.toHaveBeenCalled();
  });

  it("delete_price ejecuta el delete del par exacto", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "delete_price", args: { model: "S26 12+512 5G DS", supplier: "South" } },
      deps,
    );
    expect(r["ok"]).toBe(true);
    expect(deps.deletePrice).toHaveBeenCalledWith({ model_id: "m1", supplier_id: "s-sou" });
  });

  it("create_category ya existente (ci) no re-crea", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "create_category", args: { name: "samsung gama alta" } },
      deps,
    );
    expect(r["ya_existe"]).toBe(true);
    expect(deps.insertCategory).not.toHaveBeenCalled();
  });

  it("best_suppliers respeta la escala por cantidad", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "best_suppliers", args: { model: "S26 12+512 5G DS", qty: 50 } },
      deps,
    );
    const mejor = r["mejor"] as { proveedor: string; costo: number };
    expect(mejor.proveedor).toBe("Bax");
    expect(mejor.costo).toBe(580); // tier de 50, no el precio base 600
  });

  it("get_mesa_summary arma precios por nombre de proveedor + agregados", async () => {
    const deps = mockDeps();
    const r = await executeTool({ name: "get_mesa_summary", args: {} }, deps);
    const filas = r["filas"] as Array<Record<string, unknown>>;
    expect(r["con_precio"]).toBe(1);
    expect(filas[0]?.["precios"]).toEqual({ Bax: 600, South: 640 });
    expect(filas[0]?.["min"]).toBe(600);
  });

  it("cuentas_summary: factura + pago → saldo por parte con nombre", async () => {
    const deps = mockDeps({
      deskData: async () => ({
        invoices: [
          { id: "f1", no: "101", type: "factura", ts: 1, date: "2026-07-01", clientId: "cl1", total: 1000 },
        ],
        ledger: [
          {
            id: "l1",
            ts: 2,
            partyType: "client",
            partyId: "cl1",
            type: "pago",
            amount: 400,
            date: "2026-07-02",
          },
        ],
      }),
    });
    const r = await executeTool({ name: "cuentas_summary", args: {} }, deps);
    const cuentas = r["cuentas"] as Array<Record<string, unknown>>;
    expect(cuentas[0]).toMatchObject({ parte: "Ojus", saldo: 600 });
  });

  it("tool desconocida → error visible (no explota)", async () => {
    const r = await executeTool({ name: "hack_the_planet", args: {} }, mockDeps());
    expect(String(r["error"])).toMatch(/desconocida/);
  });
});

// ---------- mesa de negociación (analyze → apply parcial → counter_offer) ----------

describe("Negociador — analyze_quote stagea y clasifica (no aplica nada)", () => {
  const quoteItems = [
    // 🟢 oportunidad: 585 vs mín 600 (−2.5%)
    { rawName: "S26 12+512 5G DS", supplier: "", price: 585, tiers: [] },
    // 🔴 cara + flag de unidad: 6100 vs mín 610 del modelo (~10×)
    { rawName: "A17 4+128 DS", supplier: "", price: 6100, tiers: [] },
    // nuevo → cola de confirmación (no se stagea)
    { rawName: "iPhone 18 Fold 1TB", supplier: "", price: 1500, tiers: [] },
  ];
  const negotiationSeed = {
    prices: [
      { model_id: "m1", supplier_id: "s-bax", price: 600 },
      { model_id: "m1", supplier_id: "s-sou", price: 640 },
      { model_id: "m2", supplier_id: "s-sou", price: 610 },
    ],
    tiers: [],
  };

  async function stageNegotiation(deps: ToolDeps) {
    return executeTool(
      { name: "analyze_quote", args: { supplier: "bax", text: "S26 585\nA17 6100\niPhone 18 Fold 1500" } },
      deps,
    );
  }

  it("clasifica 🟢/🔴 contra la Mesa, encola lo nuevo y NO aplica", async () => {
    const deps = mockDeps({
      extractQuote: vi.fn(async () => quoteItems),
    }, negotiationSeed);
    const r = await stageNegotiation(deps);
    expect(r["proveedor"]).toBe("Bax");
    const resumen = r["resumen"] as Record<string, unknown>;
    expect(resumen["oportunidades"]).toBe(1);
    expect(resumen["caras"]).toBe(1);
    const lineas = r["lineas"] as Array<Record<string, unknown>>;
    const s26 = lineas.find((l) => l["modelo"] === "S26 12+512 5G DS")!;
    expect(s26["clasificacion"]).toBe("oportunidad");
    expect(s26["vs_min_pct"]).toBe(-2.5);
    expect((s26["min"] as Record<string, unknown>)["proveedor"]).toBe("Bax");
    const a17 = lineas.find((l) => l["modelo"] === "A17 4+128 DS")!;
    expect(a17["clasificacion"]).toBe("caro");
    expect(String((a17["flags"] as string[]).join(" "))).toMatch(/unidad/);
    expect(r["nuevos_en_cola"]).toEqual(["iPhone 18 Fold 1TB"]);
    // guardrails: nada aplicado, nada creado; quedó STAGEADO
    expect(deps.applyQuoteEntry).not.toHaveBeenCalled();
    expect(deps.createModelWithAlias).not.toHaveBeenCalled();
    expect(deps.getStaged()?.lines).toHaveLength(2);
    expect(deps.queueCandidates).toHaveBeenCalledTimes(1);
  });

  it("load_quote sigue funcionando como alias (mismo staging)", async () => {
    const deps = mockDeps({
      extractQuote: vi.fn(async () => [quoteItems[0]!]),
    }, negotiationSeed);
    const r = await executeTool({ name: "load_quote", args: { supplier: "Bax", text: "S26 585" } }, deps);
    expect((r["resumen"] as Record<string, unknown>)["oportunidades"]).toBe(1);
    expect(deps.getStaged()?.lines).toHaveLength(1);
  });

  it("apply_lines por clasificación aplica SOLO eso y lo saca de la mesa", async () => {
    const deps = mockDeps({
      extractQuote: vi.fn(async () => quoteItems),
    }, negotiationSeed);
    await stageNegotiation(deps);
    const r = await executeTool(
      { name: "apply_lines", args: { classification: "oportunidad" } },
      deps,
    );
    const aplicadas = r["aplicadas"] as Array<Record<string, unknown>>;
    expect(aplicadas).toHaveLength(1);
    expect(aplicadas[0]?.["modelo"]).toBe("S26 12+512 5G DS");
    expect(deps.applyQuoteEntry).toHaveBeenCalledTimes(1);
    expect(deps.applyQuoteEntry).toHaveBeenCalledWith(
      "m1",
      "s-bax",
      expect.objectContaining({ price: 585 }),
    );
    expect(r["quedan_en_mesa"]).toBe(1); // la cara sigue en negociación
    expect(deps.getStaged()?.lines[0]?.modelName).toBe("A17 4+128 DS");
  });

  it("apply_lines all + except ('todo menos el A17')", async () => {
    const deps = mockDeps({
      extractQuote: vi.fn(async () => quoteItems),
    }, negotiationSeed);
    await stageNegotiation(deps);
    const r = await executeTool(
      { name: "apply_lines", args: { all: true, except: ["A17"] } },
      deps,
    );
    expect((r["aplicadas"] as unknown[]).length).toBe(1);
    expect(r["quedan_en_mesa"]).toBe(1);
  });

  it("apply_lines sin selector o sin staging → error claro", async () => {
    const deps = mockDeps();
    const sinStaging = await executeTool({ name: "apply_lines", args: { all: true } }, deps);
    expect(String(sinStaging["error"])).toMatch(/analyze_quote/);
    const deps2 = mockDeps({ extractQuote: vi.fn(async () => quoteItems) }, negotiationSeed);
    await stageNegotiation(deps2);
    const sinSelector = await executeTool({ name: "apply_lines", args: {} }, deps2);
    expect(String(sinSelector["error"])).toMatch(/QUÉ aplicar/);
    expect(deps2.applyQuoteEntry).not.toHaveBeenCalled();
  });

  it("discard_lines all limpia la mesa sin aplicar", async () => {
    const deps = mockDeps({ extractQuote: vi.fn(async () => quoteItems) }, negotiationSeed);
    await stageNegotiation(deps);
    const r = await executeTool({ name: "discard_lines", args: { all: true } }, deps);
    expect(r["descartadas"]).toBe(2);
    expect(deps.getStaged()).toBeNull();
    expect(deps.applyQuoteEntry).not.toHaveBeenCalled();
  });

  it("counter_offer: solo las 🔴, objetivo = nuestro mín (o mín−1), texto con números de la Mesa", async () => {
    const deps = mockDeps({ extractQuote: vi.fn(async () => quoteItems) }, negotiationSeed);
    await stageNegotiation(deps);
    const r = await executeTool({ name: "counter_offer", args: {} }, deps);
    const lineas = r["lineas"] as Array<Record<string, unknown>>;
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatchObject({ modelo: "A17 4+128 DS", ofrecido: 6100, nuestro_min: 610, objetivo: 610 });
    const texto = String(r["texto_whatsapp"]);
    expect(texto).toContain("Bax");
    expect(texto).toContain("A17 4+128 DS");
    expect(texto).not.toContain("S26"); // la 🟢 no se menciona
    const under = await executeTool({ name: "counter_offer", args: { mode: "undercut" } }, deps);
    expect((under["lineas"] as Array<Record<string, unknown>>)[0]?.["objetivo"]).toBe(609);
  });

  it("proveedor con typo → NO analiza, propone el existente", async () => {
    const deps = mockDeps({ extractQuote: vi.fn(async () => quoteItems) });
    const r = await executeTool({ name: "analyze_quote", args: { supplier: "Baxx", text: "S26 585" } }, deps);
    expect(String(r["error"])).toMatch(/No existe el proveedor/);
    expect(r["quisiste_decir"]).toBe("Bax");
    expect(deps.extractQuote).not.toHaveBeenCalled();
  });
});

describe("Negociador — price_position / discount_plan / memoria", () => {
  it("price_position por modelo: proveedores ordenados, mín, spread", async () => {
    const deps = mockDeps();
    const r = await executeTool({ name: "price_position", args: { model: "S26 12+512 5G DS" } }, deps);
    const proveedores = r["proveedores"] as Array<Record<string, unknown>>;
    expect(proveedores.map((p) => p["proveedor"])).toEqual(["Bax", "South"]);
    expect((r["min"] as Record<string, unknown>)["proveedor"]).toBe("Bax");
    expect((r["spread"] as Record<string, unknown>)["abs"]).toBe(40);
    expect(proveedores[0]?.["escala"]).toBe(true); // Bax tiene escalera en el mock
  });

  it("discount_plan: concede en margen gordo, respeta el piso y usa costForQty (escala)", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "discount_plan", args: { items: [{ model: "S26 12+512 5G DS", qty: 50 }] } },
      deps,
    );
    const linea = (r["lineas"] as Array<Record<string, unknown>>)[0]!;
    expect(linea["costo"]).toBe(580); // tier de 50 de Bax, no el precio base 600
    expect(linea["lista"]).toBe(618); // mín 600 + 3%
    expect(linea["sugerencia"]).toBe("conceder"); // margen 6.1% > piso
    expect(Number(linea["precio_final"])).toBeLessThan(618);
    expect(Number(linea["margen_final_pct"])).toBeGreaterThanOrEqual(1);
  });

  it("discount_plan con target_pct: alcanza el descuento sin perforar el piso", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      {
        name: "discount_plan",
        args: { items: [{ model: "S26 12+512 5G DS", qty: 50 }], target_pct: 2, floor_pct: 1 },
      },
      deps,
    );
    const tot = r["totales"] as Record<string, number>;
    expect(tot.descuento_pct).toBeGreaterThan(1.5);
    expect(tot.descuento_pct).toBeLessThanOrEqual(2.1);
    const linea = (r["lineas"] as Array<Record<string, unknown>>)[0]!;
    expect(Number(linea["margen_final_pct"])).toBeGreaterThanOrEqual(1);
  });

  it("remember encodea [[about]] y recall filtra por parte", async () => {
    setKnowledgeRows([{ id: "k0", rule_text: "Los iPhone van al depto iPhone" }]);
    const deps = mockDeps();
    const saved = await executeTool(
      { name: "remember", args: { note: "afloja 2% con volumen", about: "planET" } },
      deps,
    );
    expect(saved["guardada"]).toBe("[[planet]] afloja 2% con volumen");
    const r = await executeTool({ name: "recall", args: { about: "planet" } }, deps);
    expect(r["notas"]).toEqual(["[[planet]] afloja 2% con volumen"]);
    expect(r["total_memoria"]).toBe(2);
    const all = await executeTool({ name: "recall", args: {} }, deps);
    expect((all["notas"] as string[]).length).toBe(2);
  });
});

// ---------- domain del negociador (puro) ----------

describe("Negociador — analyzeOffer (casos borde)", () => {
  const now = Date.now();
  const ref = (supplierId: string, price: number, ageMs = 0) => ({
    supplierId,
    price,
    updatedAtMs: now - ageMs,
  });

  it("sin referencias → sin_referencia (y sin prev)", () => {
    const a = analyzeOffer(500, "sp1", [], now);
    expect(a.clasificacion).toBe("sin_referencia");
    expect(a.min).toBeNull();
    expect(a.prev_propio).toBeNull();
  });

  it("banda ±1.5%: mejora chica = en_linea; mejora real = oportunidad; arriba = caro", () => {
    const refs = [ref("sp1", 600), ref("sp2", 640)];
    expect(analyzeOffer(595, "sp3", refs, now).clasificacion).toBe("en_linea"); // −0.8%
    expect(analyzeOffer(585, "sp3", refs, now).clasificacion).toBe("oportunidad"); // −2.5%
    expect(analyzeOffer(620, "sp3", refs, now).clasificacion).toBe("caro"); // +3.3%
    expect(analyzeOffer(585, "sp3", refs, now).vs_min_pct).toBe(-2.5);
  });

  it("prev_propio: delta vs el precio anterior del MISMO proveedor + frescura", () => {
    const refs = [ref("sp1", 600, 10 * 24 * 3600 * 1000), ref("sp2", 590)];
    const a = analyzeOffer(612, "sp1", refs, now);
    expect(a.prev_propio?.price).toBe(600);
    expect(a.prev_propio?.delta_pct).toBe(2);
    expect(a.prev_propio?.fresh).toBe("expired"); // 10 días → ciclo vencido
    expect(a.min?.supplierId).toBe("sp2");
  });
});

describe("Negociador — selectLines / counterOffer / discountPlan / notas (puros)", () => {
  const line = (over: Partial<import("../src/domain/negotiation").StagedLine>) => ({
    aliasKey: "k",
    rawName: "X",
    modelId: "m",
    modelName: "X",
    categoryName: null,
    price: 100,
    tiers: [],
    analysis: {
      clasificacion: "en_linea" as const,
      min: null,
      mediana: null,
      vs_min_pct: null,
      prev_propio: null,
    },
    flags: [],
    ...over,
  });

  it("selectLines: category ci, classification y all+except", () => {
    const lines = [
      line({ aliasKey: "a", modelName: "S26", categoryName: "Samsung Gama Alta" }),
      line({ aliasKey: "b", modelName: "A17", categoryName: "Samsung Gama Baja" }),
    ];
    expect(selectLines(lines, { category: "samsung gama alta" }).selected.map((l) => l.aliasKey)).toEqual(["a"]);
    expect(selectLines(lines, { all: true, except: ["a17"] }).selected.map((l) => l.aliasKey)).toEqual(["a"]);
    expect(selectLines(lines, { models: ["s26"] }).rest.map((l) => l.aliasKey)).toEqual(["b"]);
  });

  it("counterOffer sin líneas caras → texto vacío", () => {
    const neg = {
      supplierId: "sp",
      supplierName: "Bax",
      ts: 0,
      lines: [line({ analysis: { clasificacion: "oportunidad", min: null, mediana: null, vs_min_pct: null, prev_propio: null } })],
    };
    const r = counterOffer(neg, () => "X");
    expect(r.lineas).toHaveLength(0);
    expect(r.texto_whatsapp).toBe("");
  });

  it("discountPlan sostiene el margen fino aunque haya target", () => {
    const plan = discountPlan(
      [
        { modelId: "a", modelName: "Gordo", qty: 10, cost: 500, lista: 560 }, // 10.7%
        { modelId: "b", modelName: "Fino", qty: 10, cost: 500, lista: 506 }, // 1.2%
      ],
      { targetPct: 3, floorPct: 1 },
    );
    const gordo = plan.lineas.find((l) => l.modelName === "Gordo")!;
    const fino = plan.lineas.find((l) => l.modelName === "Fino")!;
    expect(gordo.sugerencia).toBe("conceder");
    expect(fino.precio_final).toBe(506); // no se toca: ya está al piso
    expect(fino.sugerencia).toBe("sostener");
    expect(gordo.margen_final_pct).toBeGreaterThanOrEqual(1);
    expect(plan.totales.descuento_pct).toBeGreaterThan(2.5);
  });

  it("notas: encode/decode [[about]], recall y orden por mención", () => {
    expect(encodeNote("afloja 2%", "PlanET")).toBe("[[planet]] afloja 2%");
    expect(noteAbout("[[ojus]] paga a 30 días")).toBe("ojus");
    expect(noteAbout("regla general")).toBeNull();
    const rules = ["[[ojus]] paga a 30 días", "regla general", "planET afloja con volumen"];
    expect(recallNotes(rules, "ojus")).toEqual(["[[ojus]] paga a 30 días"]);
    expect(orderNotesByMention(rules, ["planet"])[0]).toBe("planET afloja con volumen");
    expect(orderNotesByMention(rules, [])).toEqual(rules);
  });
});

describe("Fase 8+ — matchSupplier (difuso, determinístico)", () => {
  const list = [{ name: "Bax" }, { name: "South Miami" }, { name: "Planet" }];
  it("exacto ci y clave alfanumérica matchean; typo solo sugiere; lejano nada", () => {
    expect(matchSupplier(list, "bax").match?.name).toBe("Bax");
    expect(matchSupplier(list, " south-miami ").match?.name).toBe("South Miami");
    const typo = matchSupplier(list, "Planett");
    expect(typo.match).toBeNull();
    expect(typo.suggestion?.name).toBe("Planet");
    const nada = matchSupplier(list, "Corvex");
    expect(nada.match).toBeNull();
    expect(nada.suggestion).toBeNull();
  });
});

// ---------- checks determinísticos de precio ----------

describe("Fase 8+ — checkQuoteEntry (sanidad antes de aplicar)", () => {
  it("limpio → sin flags (auto-aplicable)", () => {
    expect(
      checkQuoteEntry({ price: 610, tiers: [] }, { pairPrice: 600, modelMin: 595 }),
    ).toEqual([]);
  });
  it("error de unidad ~1/10 → flag con sugerencia ×10", () => {
    const flags = checkQuoteEntry({ price: 61, tiers: [] }, { pairPrice: null, modelMin: 610 });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.motivo).toMatch(/unidad/);
    expect(flags[0]?.sugerencia).toBe(610);
  });
  it("error de unidad ~10× → flag con sugerencia ÷10", () => {
    const flags = checkQuoteEntry({ price: 6100, tiers: [] }, { pairPrice: null, modelMin: 610 });
    expect(flags[0]?.sugerencia).toBe(610);
  });
  it(">30% vs Mín del modelo → flag (sin parecer unidad)", () => {
    const flags = checkQuoteEntry({ price: 850, tiers: [] }, { pairPrice: null, modelMin: 600 });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.motivo).toMatch(/Mín actual del modelo/);
  });
  it(">15% vs precio anterior del proveedor → flag (umbral viejo)", () => {
    const flags = checkQuoteEntry({ price: 720, tiers: [] }, { pairPrice: 600, modelMin: 700 });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.motivo).toMatch(/proveedor/);
  });
  it("escalera invertida → flag", () => {
    const flags = checkQuoteEntry(
      {
        price: 595,
        tiers: [
          { min_qty: 1, price: 595 },
          { min_qty: 20, price: 620 },
        ],
      },
      { pairPrice: 600, modelMin: 600 },
    );
    expect(flags.some((f) => f.motivo.includes("escalera invertida"))).toBe(true);
  });
});

// ---------- whatsapp ----------

describe("Fase 8+ — cotización WhatsApp (formato del viejo)", () => {
  it("categoría en *negrita*, NOMBRE<TAB>$redondeado, grupos con línea en blanco", () => {
    const txt = whatsappQuoteText([
      {
        category: "Samsung Gama Alta",
        items: [
          { name: "S26 12+512 5G DS", price: 628.4 },
          { name: "Z FOLD 7 12+512 5G", price: null },
        ],
      },
      { category: "iPhone Último Modelo", items: [{ name: "iPhone 17 256GB", price: 900 }] },
      { category: "Vacía", items: [] },
    ]);
    expect(txt).toBe(
      "*Samsung Gama Alta*\nS26 12+512 5G DS\t$628\nZ FOLD 7 12+512 5G\t—\n\n*iPhone Último Modelo*\niPhone 17 256GB\t$900",
    );
  });
  it("listaPrice: manual gana; si no, (min ?? minAny) + margen; nada → null", () => {
    expect(listaPrice(700, 600, 590, 3)).toBe(700);
    expect(listaPrice(null, 600, null, 3)).toBe(618);
    expect(listaPrice(null, null, 590, 3)).toBe(608);
    expect(listaPrice(null, null, null, 3)).toBeNull();
  });

  it("tool whatsapp_list: agrupa por categoría con precio Lista/Mín+margen", async () => {
    const deps = mockDeps({
      listSalePrices: async () => [{ model_id: "m2", price: 700 }],
    });
    const r = await executeTool({ name: "whatsapp_list", args: { department: "Teléfonos" } }, deps);
    const txt = String(r["texto_whatsapp"]);
    expect(txt).toContain("*Samsung*");
    expect(txt).toContain("S26 12+512 5G DS\t$618"); // mín 600 + 3%
    expect(txt).toContain("A17 4+128 DS\t$700"); // Lista manual
    expect(r["modelos"]).toBe(2);
  });

  it("tool whatsapp_list con filter recorta por nombre", async () => {
    const deps = mockDeps();
    const r = await executeTool({ name: "whatsapp_list", args: { filter: "S26" } }, deps);
    expect(String(r["texto_whatsapp"])).toContain("S26");
    expect(String(r["texto_whatsapp"])).not.toContain("A17");
  });
});

// ---------- P1: compliance del gate de escritura ----------

describe("Gate P1 — applyGate (única definición de enforcement)", () => {
  it("flags sin force → bloqueado; force o sin flags → pasa", () => {
    const flags = [{ motivo: "x" }];
    expect(applyGate(flags, false)).toEqual({ allowed: false, flags });
    expect(applyGate(flags, true)).toEqual({ allowed: true });
    expect(applyGate([], false)).toEqual({ allowed: true });
  });
});

describe("Gate P1 — set_price gateado", () => {
  it("precio con flag (unidad) → {bloqueado, flags} y CERO escrituras", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "set_price", args: { model: "S26 12+512 5G DS", supplier: "Bax", price: 61 } },
      deps,
    );
    expect(r["bloqueado"]).toBe(true);
    expect(String((r["flags"] as Array<{ motivo: string }>)[0]?.motivo)).toMatch(/unidad/);
    expect(String(r["nota"])).toMatch(/NO escribí nada/);
    expect(deps.upsertPrice).not.toHaveBeenCalled();
    expect(deps.appendPriceHistory).not.toHaveBeenCalled();
  });

  it("force:true SIN reason → error y CERO escrituras", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "set_price", args: { model: "S26 12+512 5G DS", supplier: "Bax", price: 61, force: true } },
      deps,
    );
    expect(String(r["error"])).toMatch(/reason/);
    expect(deps.upsertPrice).not.toHaveBeenCalled();
  });

  it("force + reason del usuario → escribe, deja forzado.reason y verifica releyendo", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      {
        name: "set_price",
        args: {
          model: "S26 12+512 5G DS",
          supplier: "Bax",
          price: 720,
          force: true,
          reason: "usuario confirma suba real por el dólar",
        },
      },
      deps,
    );
    expect(r["ok"]).toBe(true);
    expect((r["forzado"] as Record<string, unknown>)["reason"]).toMatch(/dólar/);
    const verificacion = r["verificacion"] as { leido: Record<string, unknown>; coincide: boolean };
    expect(verificacion.coincide).toBe(true);
    expect(verificacion.leido["precio"]).toBe(720);
    expect(deps.upsertPrice).toHaveBeenCalledTimes(1);
  });

  it("dry_run → simulación con 'escribiria' y CERO escrituras (aunque haya flags)", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      { name: "set_price", args: { model: "S26 12+512 5G DS", supplier: "Bax", price: 61, dry_run: true } },
      deps,
    );
    expect(r["dry_run"]).toBe(true);
    expect((r["escribiria"] as Record<string, unknown>)["precio"]).toBe(61);
    expect(String(r["nota"])).toMatch(/BLOQUEADO/);
    expect(deps.upsertPrice).not.toHaveBeenCalled();
    expect(deps.appendPriceHistory).not.toHaveBeenCalled();
  });

  it("verify mismatch → error ruidoso con lo releído (la escritura no impactó)", async () => {
    const deps = mockDeps({ upsertPrice: vi.fn(async () => {}) }); // write que NO impacta
    const r = await executeTool(
      { name: "set_price", args: { model: "S26 12+512 5G DS", supplier: "Bax", price: 630 } },
      deps,
    );
    expect(String(r["error"])).toMatch(/verify-after-write/);
    const verificacion = r["verificacion"] as { leido: Record<string, unknown>; coincide: boolean };
    expect(verificacion.coincide).toBe(false);
    expect(verificacion.leido["precio"]).toBe(600); // lo que hay de verdad
  });
});

describe("Gate P1 — set_tiers / set_sale_price", () => {
  it("escalera invertida → bloqueada sin escribir", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      {
        name: "set_tiers",
        args: {
          model: "S26 12+512 5G DS",
          supplier: "Bax",
          tiers: [
            { min_qty: 1, price: 595 },
            { min_qty: 20, price: 620 },
          ],
        },
      },
      deps,
    );
    expect(r["bloqueado"]).toBe(true);
    expect(String((r["flags"] as Array<{ motivo: string }>).map((f) => f.motivo).join(" "))).toMatch(
      /escalera invertida/,
    );
    expect(deps.setTiersForPair).not.toHaveBeenCalled();
    expect(deps.upsertPrice).not.toHaveBeenCalled();
  });

  it("set_tiers limpia escribe + verifica escalera Y precio de celda releídos", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      {
        name: "set_tiers",
        args: {
          model: "S26 12+512 5G DS",
          supplier: "Bax",
          tiers: [
            { min_qty: 1, price: 620 },
            { min_qty: 50, price: 595 },
          ],
        },
      },
      deps,
    );
    expect(r["ok"]).toBe(true);
    const verificacion = r["verificacion"] as { leido: Record<string, unknown>; coincide: boolean };
    expect(verificacion.coincide).toBe(true);
    expect(verificacion.leido["precio_celda"]).toBe(595);
  });

  it("set_tiers dry_run → cero escrituras", async () => {
    const deps = mockDeps();
    const r = await executeTool(
      {
        name: "set_tiers",
        args: {
          model: "S26 12+512 5G DS",
          supplier: "Bax",
          tiers: [{ min_qty: 1, price: 610 }],
          dry_run: true,
        },
      },
      deps,
    );
    expect(r["dry_run"]).toBe(true);
    expect(deps.setTiersForPair).not.toHaveBeenCalled();
  });

  it("set_sale_price: dry_run no escribe; escribir y borrar verifican releyendo", async () => {
    const deps = mockDeps();
    const dry = await executeTool(
      { name: "set_sale_price", args: { model: "A17 4+128 DS", price: 700, dry_run: true } },
      deps,
    );
    expect(dry["dry_run"]).toBe(true);
    expect(deps.upsertSalePrice).not.toHaveBeenCalled();
    const set = await executeTool(
      { name: "set_sale_price", args: { model: "A17 4+128 DS", price: 700 } },
      deps,
    );
    expect((set["verificacion"] as { coincide: boolean }).coincide).toBe(true);
    const del = await executeTool({ name: "set_sale_price", args: { model: "A17 4+128 DS" } }, deps);
    expect((del["verificacion"] as { coincide: boolean; leido: Record<string, unknown> }).coincide).toBe(true);
    expect((del["verificacion"] as { leido: Record<string, unknown> }).leido["lista"]).toBeNull();
  });
});

describe("Gate P1 — apply_lines gatea POR LÍNEA (recalculado contra la Mesa actual)", () => {
  const quoteItems = [
    { rawName: "S26 12+512 5G DS", supplier: "", price: 585, tiers: [] }, // limpia
    { rawName: "A17 4+128 DS", supplier: "", price: 6100, tiers: [] }, // flag unidad
  ];
  const seed = {
    prices: [
      { model_id: "m1", supplier_id: "s-bax", price: 600 },
      { model_id: "m2", supplier_id: "s-sou", price: 610 },
    ],
    tiers: [],
  };
  const stage = async (deps: ToolDeps) =>
    executeTool({ name: "analyze_quote", args: { supplier: "Bax", text: "lista" } }, deps);

  it("sin force: la limpia se aplica (verificada), la flaggeada vuelve en 'bloqueadas' y sigue en la mesa", async () => {
    const deps = mockDeps({ extractQuote: vi.fn(async () => quoteItems) }, seed);
    await stage(deps);
    const r = await executeTool({ name: "apply_lines", args: { all: true } }, deps);
    expect((r["aplicadas"] as unknown[]).length).toBe(1);
    const bloqueadas = r["bloqueadas"] as Array<Record<string, unknown>>;
    expect(bloqueadas).toHaveLength(1);
    expect(bloqueadas[0]?.["modelo"]).toBe("A17 4+128 DS");
    expect(deps.applyQuoteEntry).toHaveBeenCalledTimes(1);
    expect(deps.getStaged()?.lines.map((l) => l.modelName)).toEqual(["A17 4+128 DS"]);
    expect((r["verificacion"] as { coincide: boolean }).coincide).toBe(true);
    expect(r["quedan_en_mesa"]).toBe(1);
  });

  it("force sin reason → error y nada aplicado", async () => {
    const deps = mockDeps({ extractQuote: vi.fn(async () => quoteItems) }, seed);
    await stage(deps);
    const r = await executeTool({ name: "apply_lines", args: { all: true, force: true } }, deps);
    expect(String(r["error"])).toMatch(/reason/);
    expect(deps.applyQuoteEntry).not.toHaveBeenCalled();
  });

  it("force + reason aplica también las flaggeadas y lo deja registrado", async () => {
    const deps = mockDeps({ extractQuote: vi.fn(async () => quoteItems) }, seed);
    await stage(deps);
    const r = await executeTool(
      { name: "apply_lines", args: { all: true, force: true, reason: "usuario confirmó los 6100" } },
      deps,
    );
    expect((r["aplicadas"] as unknown[]).length).toBe(2);
    expect((r["bloqueadas"] as unknown[]).length).toBe(0);
    expect((r["forzado"] as Record<string, unknown>)["reason"]).toMatch(/6100/);
    expect(deps.getStaged()).toBeNull();
  });

  it("dry_run: simulación completa, staging intacto, cero escrituras", async () => {
    const deps = mockDeps({ extractQuote: vi.fn(async () => quoteItems) }, seed);
    await stage(deps);
    const r = await executeTool({ name: "apply_lines", args: { all: true, dry_run: true } }, deps);
    expect(r["dry_run"]).toBe(true);
    expect((r["aplicaria"] as unknown[]).length).toBe(1);
    expect((r["bloqueadas"] as unknown[]).length).toBe(1);
    expect(deps.applyQuoteEntry).not.toHaveBeenCalled();
    expect(deps.getStaged()?.lines).toHaveLength(2);
  });
});

// ---------- P2: política de autonomía (escalera de confianza) ----------

function policyOf(mode: AgentPolicy["mode"], limits = DEFAULT_LIMITS): AgentPolicy {
  return { task: "qa", mode, limits };
}

describe("Política P2 — modo SOMBRA (recorder + overlay)", () => {
  it("las mutaciones NO tocan la base, quedan en el journal y el overlay las refleja", async () => {
    const deps = mockDeps();
    const journal: PolicyEvent[] = [];
    const wrapped = wrapDepsWithPolicy(deps, policyOf("shadow"), (e) => journal.push(e));
    await wrapped.upsertPrice({ model_id: "m1", supplier_id: "s-bax", price: 630 });
    expect(deps.upsertPrice).not.toHaveBeenCalled();
    expect(journal.map((e) => e.kind)).toEqual(["registrado"]);
    // overlay: la lectura releída refleja el estado "como-si"
    const after = (await wrapped.listPrices()).find(
      (r) => r.model_id === "m1" && r.supplier_id === "s-bax",
    );
    expect(after?.price).toBe(630);
    // la base REAL sigue intacta
    const real = (await deps.listPrices()).find(
      (r) => r.model_id === "m1" && r.supplier_id === "s-bax",
    );
    expect(real?.price).toBe(600);
  });

  it("set_price completo vía executor en sombra: ok + verificacion coherente, cero writes reales", async () => {
    const deps = mockDeps();
    const journal: PolicyEvent[] = [];
    const wrapped = wrapDepsWithPolicy(deps, policyOf("shadow"), (e) => journal.push(e));
    const r = await executeTool(
      { name: "set_price", args: { model: "S26 12+512 5G DS", supplier: "Bax", price: 630 } },
      wrapped,
    );
    expect(r["ok"]).toBe(true);
    expect((r["verificacion"] as { coincide: boolean }).coincide).toBe(true); // overlay
    expect(deps.upsertPrice).not.toHaveBeenCalled();
    expect(deps.appendPriceHistory).not.toHaveBeenCalled();
    expect(journal.filter((e) => e.kind === "registrado").map((e) => e.dep)).toEqual([
      "upsertPrice",
      "appendPriceHistory",
    ]);
  });

  it("el gate sigue mandando en sombra: precio insano → bloqueado (ni registro de escritura)", async () => {
    const deps = mockDeps();
    const journal: PolicyEvent[] = [];
    const wrapped = wrapDepsWithPolicy(deps, policyOf("shadow"), (e) => journal.push(e));
    const r = await executeTool(
      { name: "set_price", args: { model: "S26 12+512 5G DS", supplier: "Bax", price: 61 } },
      wrapped,
    );
    expect(r["bloqueado"]).toBe(true);
    expect(journal).toHaveLength(0);
  });

  it("confirmables (deletePrice) en sombra: solo registro", async () => {
    const deps = mockDeps();
    const journal: PolicyEvent[] = [];
    const wrapped = wrapDepsWithPolicy(deps, policyOf("shadow"), (e) => journal.push(e));
    await wrapped.deletePrice({ model_id: "m1", supplier_id: "s-bax" });
    expect(deps.deletePrice).not.toHaveBeenCalled();
    expect(journal[0]?.dep).toBe("deletePrice");
    expect(journal[0]?.kind).toBe("registrado");
  });
});

describe("Política P2 — modo AUTO_LIMITED (límites antes de delegar)", () => {
  it("dentro de límites → ejecuta y journalea 'ejecutado'", async () => {
    const deps = mockDeps();
    const journal: PolicyEvent[] = [];
    const wrapped = wrapDepsWithPolicy(deps, policyOf("auto_limited"), (e) => journal.push(e));
    await wrapped.upsertPrice({ model_id: "m1", supplier_id: "s-bax", price: 630 }); // +5%
    expect(deps.upsertPrice).toHaveBeenCalledTimes(1);
    expect(journal.some((e) => e.kind === "ejecutado" && e.dep === "upsertPrice")).toBe(true);
  });

  it("delta > maxDeltaPct → denegado_por_politica (throw ruidoso, cero writes)", async () => {
    const deps = mockDeps();
    const journal: PolicyEvent[] = [];
    const wrapped = wrapDepsWithPolicy(deps, policyOf("auto_limited"), (e) => journal.push(e));
    await expect(
      wrapped.upsertPrice({ model_id: "m1", supplier_id: "s-bax", price: 720 }), // +20%
    ).rejects.toThrow(/denegado_por_politica/);
    expect(deps.upsertPrice).not.toHaveBeenCalled();
    expect(journal[0]?.kind).toBe("denegado_por_politica");
    expect(String(journal[0]?.detalle["motivo"])).toMatch(/maxDeltaPct/);
  });

  it("maxLines por corrida: la línea N+1 se deniega", async () => {
    const deps = mockDeps();
    const journal: PolicyEvent[] = [];
    const wrapped = wrapDepsWithPolicy(
      deps,
      policyOf("auto_limited", { ...DEFAULT_LIMITS, maxLines: 2 }),
      (e) => journal.push(e),
    );
    await wrapped.upsertPrice({ model_id: "m1", supplier_id: "s-bax", price: 605 });
    await wrapped.upsertPrice({ model_id: "m1", supplier_id: "s-sou", price: 645 });
    await expect(
      wrapped.upsertPrice({ model_id: "m1", supplier_id: "s-bax", price: 606 }),
    ).rejects.toThrow(/maxLines/);
    expect(deps.upsertPrice).toHaveBeenCalledTimes(2);
  });

  it("impacto acumulado > maxTotalImpactUsd → denegado", async () => {
    const deps = mockDeps();
    const wrapped = wrapDepsWithPolicy(
      deps,
      policyOf("auto_limited", { ...DEFAULT_LIMITS, maxTotalImpactUsd: 30 }),
      () => {},
    );
    await wrapped.upsertPrice({ model_id: "m1", supplier_id: "s-bax", price: 620 }); // impacto 20
    await expect(
      wrapped.upsertPrice({ model_id: "m1", supplier_id: "s-sou", price: 660 }), // +20 → 40 > 30
    ).rejects.toThrow(/maxTotalImpactUsd/);
  });

  it("confirmables en limitado: solo registro; en FULL ejecutan", async () => {
    const deps = mockDeps();
    const journal: PolicyEvent[] = [];
    const limited = wrapDepsWithPolicy(deps, policyOf("auto_limited"), (e) => journal.push(e));
    await limited.deletePrice({ model_id: "m1", supplier_id: "s-bax" });
    expect(deps.deletePrice).not.toHaveBeenCalled();
    expect(journal.at(-1)?.kind).toBe("registrado");
    const full = wrapDepsWithPolicy(deps, policyOf("full"), (e) => journal.push(e));
    await full.deletePrice({ model_id: "m1", supplier_id: "s-bax" });
    expect(deps.deletePrice).toHaveBeenCalledTimes(1);
    expect(journal.at(-1)?.kind).toBe("ejecutado");
  });
});

describe("P2 — tools del journal (get_agent_runs / review_agent_run)", () => {
  it("get_agent_runs lista corridas con reporte y review", async () => {
    setAgentRunRows([
      {
        id: "run1",
        ts: "2026-07-25T10:00:00Z",
        task: "qa",
        mode: "shadow",
        status: "ok",
        report: "3 hallazgos: 2 stale, 1 escalera invertida",
        metrics: { findings: 3 },
        review: null,
      },
    ]);
    const deps = mockDeps();
    const r = await executeTool({ name: "get_agent_runs", args: { task: "qa" } }, deps);
    const corridas = r["corridas"] as Array<Record<string, unknown>>;
    expect(corridas).toHaveLength(1);
    expect(corridas[0]?.["review"]).toBe("sin revisar");
    expect(String(corridas[0]?.["reporte"])).toMatch(/escalera invertida/);
  });

  it("review_agent_run valida el verdict y lo guarda; sin corridas → nota", async () => {
    setAgentRunRows([
      { id: "run1", ts: "t", task: "qa", mode: "shadow", status: "ok", report: null, metrics: null, review: null },
    ]);
    const deps = mockDeps();
    const bad = await executeTool({ name: "review_agent_run", args: { id: "run1", verdict: "maso" } }, deps);
    expect(String(bad["error"])).toMatch(/aprobado.*rechazado/);
    const ok = await executeTool(
      { name: "review_agent_run", args: { id: "run1", verdict: "aprobado", notas: "buen QA" } },
      deps,
    );
    expect(ok["ok"]).toBe(true);
    expect(deps.reviewAgentRun).toHaveBeenCalledWith("run1", { verdict: "aprobado", notas: "buen QA" });
    setAgentRunRows([]);
    const empty = await executeTool({ name: "get_agent_runs", args: {} }, deps);
    expect(String(empty["nota"])).toMatch(/Sin corridas/);
  });
});

// ---------- clientPulse (puro) ----------

describe("Fase 8 — clientPulse por ID", () => {
  it("saldo + post-venta pendiente + sin comprar", () => {
    const now = Date.parse("2026-07-20T12:00:00Z");
    const out = clientPulse(
      {
        invoices: [
          {
            id: "f1",
            no: "101",
            type: "factura",
            ts: now - 5 * 86_400_000,
            clientId: "cl1",
            total: 1000,
          },
        ],
        ledger: [],
        clients: [
          { id: "cl1", name: "Ojus", esNuestra: false },
          { id: "cl9", name: "Cuenta Propia", esNuestra: true },
        ],
        ops: [{ invoiceId: "f1", afuera: true, local: false, pago: false }],
      },
      undefined,
      now,
    );
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c?.cliente).toBe("Ojus");
    expect(c?.saldo).toBe(1000);
    expect(c?.pendientes[0]?.falta).toEqual(["entrega local", "pago"]);
    expect(c?.flags.some((f) => f.startsWith("debe $1000"))).toBe(true);
  });

  it("cuentas nuestras (es_nuestra) quedan afuera y el filtro por nombre matchea parcial", () => {
    const now = Date.now();
    const inputs = {
      invoices: [
        { id: "f1", no: "1", type: "factura", ts: now, clientId: "cl9", total: 500 },
        { id: "f2", no: "2", type: "factura", ts: now, clientId: "cl1", total: 100 },
      ],
      ledger: [],
      clients: [
        { id: "cl1", name: "Ojus", esNuestra: false },
        { id: "cl9", name: "Cuenta Propia", esNuestra: true },
      ],
      ops: [],
    };
    expect(clientPulse(inputs).map((c) => c.cliente)).toEqual(["Ojus"]);
    expect(clientPulse(inputs, "oju")).toHaveLength(1);
    expect(clientPulse(inputs, "nadie")).toHaveLength(0);
  });
});

// ---------- transporte ----------

describe("Fase 8 — transporte /api/gemini (fetch mockeado)", () => {
  const okResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200 });

  it("generateText concatena las parts del primer candidato", async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({ candidates: [{ content: { parts: [{ text: "[{\"a\"" }, { text: ":1}]" }] } }] }),
    );
    const out = await generateText({ content: "hola" }, fetchFn);
    expect(out).toBe('[{"a":1}]');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/gemini");
    expect(JSON.parse(String(init.body))).toMatchObject({ content: "hola" });
  });

  it("generateTurn devuelve functionCalls tipadas", async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "create_category", args: { name: "Samsung Gama Alta" } } },
                { text: "creo la categoría" },
              ],
            },
          },
        ],
      }),
    );
    const turn = await generateTurn({ contents: [{ role: "user", parts: [{ text: "x" }] }] }, fetchFn);
    const calls = functionCallsOf(turn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("create_category");
    expect(textOf(turn)).toBe("creo la categoría");
  });

  it("error del proxy → mensaje RUIDOSO con el detalle de Gemini", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 }),
    );
    await expect(generateText({ content: "x" }, fetchFn)).rejects.toThrow(
      /Gemini 400: API key not valid/,
    );
  });

  it("timeout → aborta y explica (no se cuelga en silencio)", async () => {
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    await expect(generateText({ content: "x" }, fetchFn, 30)).rejects.toThrow(/Timeout/);
  });
});

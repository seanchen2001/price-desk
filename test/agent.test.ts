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
  buildExtractionSystem,
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
  type ToolDeps,
} from "../src/features/agent/executor";
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

function mockDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const models = [
    { id: "m1", canonical_name: "S26 12+512 5G DS", category_id: "c-sam", department_id: "d-tel" },
    { id: "m2", canonical_name: "A17 4+128 DS", category_id: "c-sam", department_id: "d-tel" },
  ];
  const aliasMap = new Map<string, string>([
    [normalize("S26 12+512 5G DS"), "m1"],
    [normalize("A17 4+128 DS"), "m2"],
  ]);
  const base: ToolDeps = {
    resolver: async () => ({
      findAliasKey: (k) => aliasMap.get(k) ?? null,
      findModelByKey: () => null,
    }),
    listModels: async () => models,
    listCategories: async () => [
      { id: "c-sam", name: "Samsung" },
      { id: "c-alta", name: "Samsung Gama Alta" },
    ],
    listDepartments: async () => [
      { id: "d-tel", name: "Teléfonos" },
      { id: "d-iph", name: "iPhone" },
    ],
    listSuppliers: async () => [
      { id: "s-bax", name: "Bax", active: true },
      { id: "s-sou", name: "South", active: true },
    ],
    listPrices: async () => [
      { model_id: "m1", supplier_id: "s-bax", price: 600, updated_at: new Date().toISOString() },
      { model_id: "m1", supplier_id: "s-sou", price: 640, updated_at: new Date().toISOString() },
    ],
    listTiers: async () => [
      { model_id: "m1", supplier_id: "s-bax", min_qty: 1, price: 600 },
      { model_id: "m1", supplier_id: "s-bax", min_qty: 50, price: 580 },
    ],
    listSalePrices: async () => [],
    listClients: async () => [{ id: "cl1", name: "Ojus", esNuestra: false }],
    listOps: async () => [],
    deskData: async () => ({ invoices: [], ledger: [] }),
    createModelWithAlias: vi.fn(async (name: string) => ({
      id: "m-new",
      canonical_name: name,
      category_id: null,
      department_id: null,
    })),
    renameModelWithAlias: vi.fn(async (modelId: string, newName: string) => ({
      id: modelId,
      canonical_name: newName,
      category_id: null,
      department_id: null,
    })),
    setModelCategory: vi.fn(async () => {}),
    insertCategory: vi.fn(async (name: string) => ({ id: "c-new", name })),
    renameCategory: vi.fn(async (id: string, name: string) => ({ id, name })),
    insertSupplier: vi.fn(async (name: string) => ({ id: "s-new", name, active: true })),
    setSupplierActive: vi.fn(async () => {}),
    upsertPrice: vi.fn(async () => {}),
    appendPriceHistory: vi.fn(async () => {}),
    setTiersForPair: vi.fn(async () => {}),
    deletePrice: vi.fn(async () => {}),
    upsertSalePrice: vi.fn(async () => {}),
    deleteSalePrice: vi.fn(async () => {}),
  };
  return { ...base, ...overrides };
}

describe("Fase 8 — declaraciones de tools", () => {
  it("cada tool declarada tiene ejecutor (y viceversa)", () => {
    expect(new Set(TOOL_NAMES)).toEqual(new Set(EXECUTABLE_TOOLS));
  });

  it("las destructivas piden confirmación y todas las de escritura invalidan cache", () => {
    expect(CONFIRM_TOOLS.has("delete_price")).toBe(true);
    expect(CONFIRM_TOOLS.has("toggle_supplier")).toBe(true);
    expect(CONFIRM_TOOLS.has("set_price")).toBe(false);
    for (const t of CONFIRM_TOOLS) expect(MUTATING_TOOLS.has(t)).toBe(true);
    for (const t of MUTATING_TOOLS) expect(TOOL_NAMES.has(t)).toBe(true);
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

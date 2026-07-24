# Price Desk v2 — Rebuild handoff para Fable

> Documento de handoff. Lo acompañan `SCHEMA.sql` (esquema Postgres/Supabase inicial) y
> `resolver.golden.test.ts` (batería de tests que el nuevo `normalize`/`resolveModel` debe pasar,
> sembrada con las variantes reales de duplicados que sufrimos).

## Context (por qué se rehace)

El Price Desk actual (`electronics-price-tool.jsx`, 2542 líneas, repo `seanchen2001/electronica`, deploy Vercel desde `main`) funciona pero **acumula errores recurrentes**. No son bugs sueltos: salen de 5 raíces estructurales. Este doc es el plan para **rehacerlo de cero en un repo nuevo**, arreglando cada raíz. Lo usa un trader mayorista de celulares en producción, con datos reales en Supabase — la migración de esos datos es parte del entregable.

### Las 5 raíces (diagnóstico, confirmado leyendo el código)
1. **Todo keyeado por el string del nombre.** `prices[nombreModelo][proveedor]`, `tiers`, `times`, `lista`, `snapshots`, `priceHistory.sku`, los items de orden, y las cuentas (por nombre de cliente/proveedor). Cualquier variante de escritura **bifurca** el registro. No hay ID estable de modelo.
2. **El parser de IA no tiene matching determinístico.** Confía en que Gemini emita el string exacto del catálogo. El dedup está parchado en **5 capas desconectadas** (`parseSupplierQuote` exact-match + rescue loop, `confirmNew`, `applyPriceLoad`, un `useEffect` continuo, y un removedor de basura "Galaxy…"). Nunca converge → lo parchamos 4+ veces.
3. **Un componente-Dios.** 77 `useState`, 56 `useEffect`, 12 `useRef`, 21 `useMemo` (~166 hooks) en una función. Persistencia duplicada por slice (un effect a localStorage + un effect a Supabase). Imposible de razonar.
4. **Sync frágil.** Supabase = tabla `kv` con **un blob JSON por colección**; cada guardado **pisa la fila entera** (whole-object overwrite), "DB gana si no está vacía", debounce 800ms, errores silenciados. Dos pestañas/dispositivos **se borran cambios entre sí** (last-writer-wins).
5. **Sin red de seguridad.** Sin TypeScript; cero tests sobre el componente, el parser y el sync (la lógica pura sí tiene tests).

### Decisiones tomadas con el usuario (bloqueadas)
- **Repo nuevo de cero**, cutover big-bang con **migración única** de los datos reales.
- **TypeScript** estricto en todo el código nuevo.
- **Esquema relacional** en Supabase (tablas + FKs + upsert por fila), no blobs.
- **La IA solo PROPONE; el código decide.** Un resolvedor determinístico único mapea cada línea a un modelo por ID. Lo genuinamente nuevo se confirma a mano. Las escalas por cantidad van SIEMPRE a `tiers`, nunca a filas `(20 pcs)` separadas.

---

## Target architecture

**Stack:** Vite + React 18 + **TypeScript** (strict). Estado servidor con **TanStack Query** (cache, optimistic updates, invalidación por entidad). Estado UI local con **Zustand**. Backend **Supabase** (Postgres + PostgREST + **Realtime** para propagación multi-dispositivo). PDFs con `@react-pdf/renderer` (se reusa). Excel con `xlsx` (import dinámico, se reusa).

**Por qué esto arregla las raíces:** IDs estables (R1), un resolvedor único (R2), módulos por feature en vez de god-component (R3), filas relacionales + upsert por fila + Realtime (R4), TS + tests (R5).

**Estructura de carpetas (nueva):**
```
src/
  domain/            # lógica pura, portada del viejo (ver "Reuso"), en TS, sin React
    pricing.ts        rowAggregates, median, client price, freshness
    planning.ts       planBestPrice / planMinSuppliers (sourcing)
    accounts.ts       cuentas derivadas (por ID, no por nombre)
    resolver.ts       ★ resolveModel — el corazón del fix (ver abajo)
    normalize.ts      skuKey/normalización (una sola definición, con tests golden)
  data/              # acceso a datos: Supabase client, queries/mutations por entidad, tipos generados
    supabase.ts, models.ts, prices.ts, clients.ts, invoices.ts, ...
  features/          # cada vista, con su store local y componentes
    mesa/ ordenes/ clientes/ cuentas/ historial/ pnl/ analitica/ agent/
  components/        # UI compartida (tabla, modal, etc.)
  app/               # shell, router de tabs, auth gate
api/                 # serverless: gemini proxy (oculta la key), migración one-shot
supabase/            # migrations SQL (schema), seed
```

---

## Data model relacional (Supabase) — ver `SCHEMA.sql`

Reemplaza los 20 blobs por tablas. **`models.id` (uuid) es la identidad estable**; el nombre es un atributo. Todo lo que hoy se keyea por string pasa a FK por `model_id` / `client_id` / `supplier_id`.

Tablas núcleo (detalle completo en `SCHEMA.sql`):

- **`suppliers`**, **`departments`** (Teléfonos/iPhone/Laptops/Otros), **`categories`** (Samsung/Motorola LATIN/Motorola EURO/…)
- **`models`** (id, **canonical_name**, category_id, department_id, spec, active) — un modelo real, una fila.
- **`model_aliases`** (id, model_id, alias_text, **alias_key** UNIQUE) — ★ **la tabla que resuelve el bug**: cada variante observada (mayúsc/espacios, "US/LATIN SPECS", "(20 pcs)", "(SM-S947)", "Galaxy …") queda mapeada a su modelo. El resolvedor busca acá primero → después de la 1ª vez, el match es determinístico y exacto.
- **`prices`** (model_id, supplier_id, price, UNIQUE(model_id, supplier_id)), **`price_tiers`** (model_id, supplier_id, min_qty, price — el ÚNICO lugar donde entra una cantidad), **`price_history`** (append-only), **`sale_prices`** (la "Lista"), **`snapshots`** (jsonb, archivos semanales inmutables).
- **`clients`**, **`shippings`**.
- **`invoices`**, **`invoice_items`** (por model_id), **`invoice_item_units`** (**una fila por unidad** — reemplaza los arrays paralelos `imeis[]`/`serials[]`).
- **`ledger`** (party por id), **`ops_tracking`**, **`knowledge`**, **`chat_log`**, **`drafts`** (jsonb, transitorio).

**Cuentas corrientes** pasan a derivarse por JOIN de `invoices`+`ledger` por `client_id`/`party_id` → **se elimina el hack de `aliases`**. **Dinero:** entero/`numeric`, nunca float binario. **Auth:** mantener el gate por contraseña compartida (RLS + edge function o el proxy actual); no sobre-ingenierizar.

---

## ★ El resolvedor de identidad (`domain/resolver.ts`) — el fix central — ver `resolver.golden.test.ts`

Una sola función determinística reemplaza las 5 capas de dedup. **La IA nunca crea un modelo; solo extrae texto+precio.**

```
resolveModel(rawName, { category?, department? }) →
  { modelId }                        // match determinístico
  | { candidateNew, alias_key }      // no existe → cola de confirmación
```
Pipeline:
1. `alias_key = normalize(rawName)` — normalización **centralizada** (una sola def, con tests golden): minúsculas → quita sufijos regionales (US/USA/LATIN SPECS) → quita TODO paréntesis (cantidades, códigos SM-/F-) → quita el prefijo verboso "Galaxy " → colapsa espacios/puntuación. Conserva tokens que distinguen producto (GB/DS/5G/color/capacidad).
2. Busca en **`model_aliases.alias_key`** → si existe, devuelve `model_id`. (Aprendido: cada variante confirmada queda persistida.)
3. Si no, busca por `alias_key` del `canonical_name` de `models`.
4. Si sigue sin match → `candidateNew` → **cola de confirmación** (UI). Al confirmar: se crea el `model` (si aplica) y **se escribe un `model_aliases`** para que sea determinístico para siempre.

**Clave del diseño:** `normalize` folda los casos mecánicos (paréntesis, regional, "Galaxy ", mayúsc/espacios). Los casos que `normalize` no puede foldar (ej. "Galaxy S26 Ultra 12GB/256GB" con GB y orden de tokens distinto al canónico) caen **una vez** en la cola de confirmación; al mapearlos a mano se escribe un alias → determinístico para siempre. No se intenta un `normalize` mágico que adivine todo (eso genera colisiones); la tabla de aliases es la fuente de verdad.

Reglas duras:
- El parser (Gemini) devuelve solo `{ rawName, supplier, price, tiers[] }`. **Nunca** decide identidad ni crea catálogo.
- Cantidades SIEMPRE a `price_tiers`. Como `normalize` borra `(N pcs)`, "X (20 pcs)" resuelve al mismo `model_id` que "X" → **imposible** que aparezca como fila separada.
- `add_model` y toda tool que cree modelos pasa por `resolveModel` primero.

Esto convierte "matching + dedup + nombre canónico" de 5 heurísticas dispersas en **1 función testeada + 1 tabla**.

---

## AI parser (propose-only)

- **Extracción** (Gemini 2.5-flash, temp 0, JSON): quote/screenshot → `[{ rawName, supplier, price, tiers[] }]`. Prompt endurecido: si hay escalera de cantidad devolvela en `tiers` (NUNCA líneas separadas); no inventes nombres canónicos.
- **Resolución**: cada `rawName` por `resolveModel`. Match → `prices`/`price_tiers` por `model_id`. `candidateNew` → cola de confirmación (nunca auto-crea).
- **Auto-aplicar** solo precios de modelos ya resueltos y delta dentro de umbral; lo nuevo/ambiguo siempre se confirma.
- El **agente de chat** (tools) se mantiene pero cada tool que muta catálogo usa `resolveModel`. Supervisor/knowledge-base: opcional y **con timeouts visibles** (hoy el Pro se cuelga a 90s y el error se silencia; que falle ruidoso).

---

## Sync / multi-dispositivo (arregla R4)

- Supabase JS + **TanStack Query**: mutaciones **por fila** (upsert de una `prices` row, no de todo el mapa) con optimistic update + invalidación por entidad.
- **Realtime**: suscribir las tablas mutables → los cambios de otra pestaña/dispositivo se propagan; se termina el last-writer-wins que borra datos.
- Errores de red **visibles** (toast), no `catch{}` vacío.

---

## Reuso (NO reescribir la matemática, ya está testeada)

Portar a TS (mismos algoritmos; cambian las firmas de "nombre" → "modelId"):
- `price-logic.js`: `rowAggregates` (min/mediana/cliente ×margen, dump-outlier→mediana), `median`, `classifyFreshness`, `mondayStart`. **Mantener la fidelidad a la planilla del trader** (`seed-validation.test.mjs` prueba que `SEED_PRICES`+`rowAggregates` reproducen `SHEET_REF` exacto — portar ese test golden).
- `lib/pricing.js`: `costForQty`, `hasTiers`, `bestSuppliers`, `upsertWeekly`, `negotiationReport`.
- `lib/trades.js` `tradeStatus`, `lib/accounts.js` `computeAccounts` (reescribir por ID), `lib/analytics.js`, `lib/inventory.js`, `lib/arbitrage.js`.
- `InvoiceDoc.jsx` (`InvoiceDoc`, `RemitosDoc`) y el export Excel IMEI+Serie.
- Prompts base de `lib/ai.js` / `lib/agent-tools.js` como punto de partida (adaptar a propose-only).

---

## Paridad de features (checklist — nada se pierde)

- **Mesa de precios**: grilla por depto, coloreo por frescura (reciente/actualizado/expirado/mejor), min/medio/cliente, edición inline, columna Lista, paste-&-parse, snapshots semanales, alertas de arbitraje, armador de cotización WhatsApp.
- **Órdenes → factura/remito**: drafts, cliente/envío, líneas (qty/color/proveedor/costo/precio, IMEI, split por color), remito por proveedor, PDF, timeline del trade (cotizado→facturado→IMEIs→Miami→Argentina→pago).
- **Clientes**: ABM clientes/envíos/proveedores.
- **Cuentas**: corrientes derivadas por ID (sin aliases), pagos/gastos manuales.
- **Historial**: facturas/remitos, re-descarga, editar, borrar, editor IMEI+**Nº de serie**, export Excel (`N° | PRODUCTO | MODELO | IMEI | NRO DE SERIE`, texto para no romper IMEIs).
- **PnL** y **Analítica** (hoy oculta tras `{false&&}`, decidir si se expone).
- **Agente de chat** (propose-only), **Papelero** (soft-delete), **tiers/escalas**.

---

## Migración única (kv blobs → relacional)

Script one-shot (`api/` o `supabase/`): lee los blobs de `kv` (prices, catalog, clients, invoices, ledger, …) y:
1. Crea `models` desde `CATALOG` + `extraCatalog`, **deduplicando con `resolveModel`**; siembra `model_aliases` con **todas** las variantes observadas (incluida la basura, para que resuelva y no reaparezca).
2. Puebla `prices`/`price_tiers`/`sale_prices`/`price_history` por `model_id`.
3. Migra `clients`/`suppliers`/`shippings` generando IDs; mapea `invoice.client` → `client_id`, `ledger.party` → `party_id`, `item.sku` → `model_id`, `imeis[]`/`serials[]` → `invoice_item_units`.
4. Emite un **reporte de no-resueltos/ambiguos** para revisión manual antes del cutover.

Correr contra una copia primero; validar totales (nº de facturas, saldos de cuentas, conteo de modelos con precio) contra la app vieja.

---

## Plan por fases para Fable (cada fase deployable/verificable)

1. **Andamiaje**: repo nuevo, Vite+React+TS strict, ESLint, Vitest, Supabase project, CI (typecheck+test). *AC: build + typecheck + un test verde en CI.*
2. **Schema + tipos**: aplicar `SCHEMA.sql`; generar tipos TS de Supabase. *AC: schema aplicado; tipos compilando.*
3. **Domain puro (TS) + tests**: portar pricing/planning/accounts/normalize + `resolveModel`. **Golden**: fidelidad a la planilla + `resolver.golden.test.ts` (batería anti-duplicados). *AC: golden verdes.*
4. **Capa de datos**: queries/mutations por entidad con TanStack Query + Realtime. *AC: CRUD de un modelo/precio desde dos pestañas sin pisarse.*
5. **Mesa** sobre el core nuevo. *AC: cargar un quote real, resolver a modelos existentes, cero duplicados; escalas van a tiers.*
6. **Órdenes + Historial + PDF/Excel + IMEI/Serie.** *AC: factura y remito por proveedor idénticos a los actuales; Excel IMEI+Serie correcto.*
7. **Clientes + Cuentas + PnL + Analítica.** *AC: saldos coinciden con la app vieja sobre los mismos datos.*
8. **Agente propose-only** (+ supervisor/knowledge opcional, errores visibles). *AC: el parser nunca crea catálogo; lo nuevo cae en cola de confirmación.*
9. **Migración + cutover**: correr el script, reporte de no-resueltos, validación de totales, deploy, cambiar Vercel al repo nuevo. *AC: paridad de datos verificada; app vieja archivada.*

---

## Testing

- **Vitest** para domain (golden de planilla + `resolver.golden.test.ts` = el test que faltaba).
- **React Testing Library** para vistas críticas (Mesa parse-flow, Órdenes→factura).
- **Test de sync**: dos clientes concurrentes no se pisan.
- CI corre typecheck + tests en cada push; Vercel deploya solo si pasa.

## Guardrails para Fable (los errores que sufrimos — diseñar en contra)
- Nunca keyear datos por el nombre visible; siempre por `model_id`/`client_id`/`supplier_id`.
- La IA no decide identidad ni crea catálogo; **todo** pasa por `resolveModel`.
- Cantidades → `price_tiers`, jamás filas separadas.
- Una sola definición de `normalize` (no re-implementar por lado).
- Mutaciones por fila, no reemplazo de colección entera; nada de `catch{}` que trague errores.
- Migraciones de datos versionadas y verificables, no `useEffect` con flags en localStorage.

## Verificación (end-to-end del entregable)
1. `npm run typecheck && npm test` verdes (batería anti-duplicados + golden de planilla).
2. Levantar la app, pegar un quote real con variantes conflictivas ("S26 12+512 5G DS (20 pcs)", "…US SPECS", "Galaxy …") → todas resuelven al modelo base, **cero filas nuevas**, escalas en tiers.
3. Editar el mismo precio desde dos pestañas → ambas convergen vía Realtime, sin pérdida.
4. Correr la migración sobre una copia → reporte de no-resueltos vacío o revisado; totales coinciden con la app vieja.
5. Generar factura + remito por proveedor + Excel IMEI/Serie → idénticos a los actuales.

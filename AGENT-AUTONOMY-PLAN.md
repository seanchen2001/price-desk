# Plan: Agente autónomo (escalera de confianza, QA primero)

> Decisiones del usuario (2026-07-25): escalera de confianza (sombra → auto-con-límites → pleno,
> promociones por métricas) · primera tarea = QA de precios · canal = el chat del desk (cero UI nueva).
> Objetivo: el agente opera solo (chequear precios cargados, recotizar proveedores, ofertar a clientes)
> equivocándose menos. Sin tocar la interfaz de momento.

## Diagnóstico verificado
- **La grieta central**: `checkQuoteEntry` (extraction.ts) se hace cumplir SOLO en la UI
  (PastePanel auto/review). En la capa de tools: `apply_lines` aplica líneas flaggeadas
  (advertencias advisory) y `set_price`/`set_tiers` NO corren ningún chequeo — el agente puede
  escribir un error de unidad 100× hoy.
- Seams limpios listos: ToolDeps inyectable (executor.ts), buildLiveDeps(db), generateTurn(fetchFn),
  forwardGemini importable en Node, data layer entera con Db inyectable (migrate.ts = referencia headless).
- Bloqueador Node: src/data/supabase.ts lee import.meta.env al cargar el módulo.
- Migración nueva = 0005 (0003 salteado a propósito).

## Fases (cada una shippeable)

### P0 — Fundaciones Node-safe
- `src/data/supabase.ts`: init perezosa del cliente default (import seguro en Node; env por
  import.meta.env o process.env; el throw pasa al primer USO). Call sites intactos.
- `scripts/lib/env.ts` (loader .env compartido — hoy duplicado en migrate/tests) y
  `scripts/lib/db.ts` (`makeServiceDb(): Db` con createClient<Database>).

### P1 — Endurecer la capa de tools (server-of-truth; el mayor recorte de errores)
- `extraction.ts`: `applyGate(flags, force)` — UNA definición de enforcement junto al detector único.
- `executor.ts`: `gatedPriceWrite` interno usado por `set_price`/`set_tiers`/`apply_lines`:
  flags sin `force` → `{bloqueado, flags, nota}` sin escribir; `force:true` exige `reason`
  (queda en el journal); `apply_lines` gatea POR LÍNEA (limpias aplican, flaggeadas vuelven
  como `bloqueadas`); `dry_run:true` en las 4 tools de precio = simulación sin escritura.
- **Verify-after-write** en las 4: releer tras mutar, `verificacion:{leido,coincide}`; mismatch = error.
- `tools.ts`: params nuevos en las declaraciones; descripciones con "cuándo NO usarla";
  system prompt con few-shots de secuencias correctas, contrato del gate ("si devuelve bloqueado,
  mostrá flags y preguntá — no fuerces solo") y regla de coherencia post-mutación.
- Tests: gating compliance, force sin reason = error, dry_run cero escrituras, verify mismatch.

### P2 — Journal `agent_runs` + política de autonomía
- `supabase/migrations/0005_agent_runs.sql`: id/ts/task/mode/status/findings/actions/report/metrics/review
  (+ índice task,ts; + realtime publication).
- `src/data/agentRuns.ts`: insert/list/review — Db inyectable.
- `src/features/agent/policy.ts` (puro): `AgentPolicy {task, mode: shadow|auto_limited|full,
  limits {maxDeltaPct, maxLines, maxTotalImpactUsd}}` + `wrapDepsWithPolicy(deps, policy, journal)`:
  sombra = deps mutantes → recorder (lecturas pasan; verify se registra como estado actual);
  auto_limited = límites antes de delegar, exceso → `denegado_por_politica` al journal;
  full = pasa. CONFIRM_TOOLS headless: sombra/limitado = solo registrar; full = ejecutar.
- Tools de chat: `get_agent_runs` (leer corridas/reportes desde el panel) y
  `review_agent_run` (verdict humano → métrica de promoción). Cero UI nueva.

### P3 — Runtime headless
- `src/features/agent/loop.ts`: extraer el turn-loop de AgentView a `runAgentLoop()` puro
  (confirm inyectable). NO tocar AgentView todavía.
- `src/features/agent/serverDeps.ts`: buildServerDeps(db) — staging in-memory por corrida,
  queueCandidates → journal, extractQuote vía fetch directo.
- `scripts/lib/gemini.ts`: `makeDirectGeminiFetch(apiKey)` usando forwardGemini (AGENT_MODEL env).
- `scripts/agent-run.ts` (tsx): env → serviceDb → serverDeps → policy wrap → system prompt
  (knowledge + orderNotesByMention) → runAgentLoop → agent_runs + chat_log `[agente autónomo]`.
- `package.json`: `agent:run`.

### P4 — Tarea 1: QA de precios (sombra primero)
- `src/domain/qa.ts` (PURO — detección determinística, LLM no detecta): stale (classifyFreshness),
  escalera invertida en tiers guardados, unit_outlier (banda 10×/100× compartida con checkQuoteEntry),
  supplier_off_median (>30% con competencia fresca), missing_lista / lista_below_cost, higiene
  (sin categoría, duplicados sospechosos por normalize, aliases huérfanos).
  Output `QaFinding[]` con severidad + `suggestedFix` como TOOL CALL (rutea por el executor gateado).
- Runner `--task=qa`: snapshot → runQa → UNA llamada LLM (Flash temp 0, responseSchema) para
  triage/priorización/reporte en español → fixes propuestos vía executor con política →
  agent_runs + chat_log. `npm run agent:qa` (sombra). Scheduling futuro: GitHub Actions cron
  (recomendado sobre Vercel cron por límites de duración) — decisión aparte.
- Tests golden: fixture con un defecto plantado por detector; triage live-gated con chequeo
  anti-alucinación (todo id reportado ∈ ids de input).

### P5 — Evals + métricas de promoción (el guardián de la escalera)
- `test/evals/scenarios.ts` (~12 escenarios golden), `agent.eval.test.ts` (offline, replay
  de turnos grabados + mockDeps, corre en CI), `agent.live.eval.test.ts` (GEMINI_LIVE, dry-run).
- `scripts/agent-metrics.ts`: dashboard de la escalera desde agent_runs.
- Criterios mecánicos de promoción:
  - M1 tool-selection ≥95% (evals live)
  - M2 aprobación humana en sombra ≥90% sobre ≥10 corridas / 2 semanas, cero misses críticos
  - M3 compliance de gate/política = 100% SIEMPRE (violación resetea la ventana)
  - shadow→auto_limited: M1+M2+M3; límites iniciales {15%, 20 líneas, $5000}.
  - auto_limited→full: ≥95% aprobación de lo auto-aplicado + cero rollbacks en segunda ventana.
  - Democión ante cualquier violación M3 o miss crítico.

## Fuera de alcance (Tareas 2/3 futuras)
- Recotización a proveedores (reusa staleness de qa.ts + counter_offer + memoria; necesita canal
  saliente WhatsApp + staging de negociación en DB) y ofertas a clientes (whatsapp_list +
  discount_plan + client_pulse + tracking). Cambios de UI (incl. migrar AgentView a loop.ts).

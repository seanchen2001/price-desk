-- 0005 — journal de corridas del agente autónomo (P2 del plan de autonomía).
-- Cada corrida (QA de precios, recotización, …) deja una fila: qué encontró, qué hizo
-- (o qué HABRÍA hecho en sombra), el reporte en español, métricas para la escalera de
-- confianza y el veredicto humano (review) que alimenta las promociones.
--
-- CÓMO APLICAR: pegar en el SQL editor del proyecto Supabase y correr (igual que 0002:
-- PostgREST no ejecuta DDL). IDEMPOTENTE. Tras aplicar, regenerar tipos:
-- node scripts/gen-types.mjs (mientras tanto database.types.ts ya trae la tabla a mano).

create table if not exists agent_runs (
  id       uuid primary key default gen_random_uuid(),
  ts       timestamptz not null default now(),
  task     text not null,               -- 'qa' | 'requote' | ... (tarea de la corrida)
  mode     text not null,               -- 'shadow' | 'auto_limited' | 'full'
  status   text not null default 'ok',  -- 'ok' | 'partial' | 'error'
  findings jsonb,                       -- hallazgos estructurados (QaFinding[])
  actions  jsonb,                       -- journal de la política: registrado/ejecutado/denegado_por_politica
  report   text,                        -- reporte en español (lo que se lee en el chat)
  metrics  jsonb,                       -- contadores para promoción (líneas, deltas, impacto)
  review   jsonb                        -- veredicto humano: {verdict:'aprobado'|'rechazado', notas, ts}
);

create index if not exists agent_runs_task_ts on agent_runs (task, ts desc);

-- realtime (idempotente, mismo patrón que 0002)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_runs'
  ) then
    alter publication supabase_realtime add table agent_runs;
  end if;
end $$;

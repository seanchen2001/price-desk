-- Fase 4 — habilitar Realtime (postgres_changes) para las tablas del Price Desk.
-- Supabase solo emite eventos para tablas incluidas en la publication `supabase_realtime`
-- (en proyectos nuevos la publication existe pero está VACÍA — verificado el 2026-07-24
-- con scripts/check-realtime.mjs: subscribe OK, cero eventos).
--
-- CÓMO APLICAR: pegar este archivo en el SQL editor del proyecto Supabase y correrlo
-- (no se pudo aplicar por API: PostgREST no ejecuta DDL y no hay access token de la
-- Management API en .env). Es IDEMPOTENTE: se puede correr más de una vez.
--
-- Se agregan TODAS las tablas (no solo las que la app observa hoy) para no necesitar
-- otra migración en fases futuras; el cliente decide a cuáles suscribirse
-- (src/data/keys.ts → realtimeInvalidation).

do $$
declare
  t text;
begin
  foreach t in array array[
    'departments', 'categories', 'suppliers', 'models', 'model_aliases',
    'prices', 'price_tiers', 'price_history', 'sale_prices', 'snapshots',
    'clients', 'shippings', 'invoices', 'invoice_items', 'invoice_item_units',
    'ledger', 'ops_tracking', 'knowledge', 'chat_log', 'drafts'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

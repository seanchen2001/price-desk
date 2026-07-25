-- 0004 — memoria del negociador: columna opcional `about` en knowledge
-- (party/modelo/categoría al que refiere la nota). Mientras esta migración no se
-- aplique, la app encodea el about DENTRO de rule_text como prefijo "[[about]] ..."
-- (domain/negotiation.ts encodeNote/noteAbout) — 100% compatible: al aplicar esto se
-- puede backfillear con el prefijo y limpiar el texto.
-- (No hay 0003: el seed de departments/categories es data y corre idempotente al boot.)

alter table knowledge
  add column if not exists about text;

comment on column knowledge.about is
  'Parte/modelo/categoría al que refiere la nota (ej. "planet", "ojus", "S26"). NULL = regla general.';

-- backfill opcional desde el encoding embebido "[[about]] texto":
update knowledge
   set about = lower(substring(rule_text from '^\[\[([^\]]+)\]\]')),
       rule_text = regexp_replace(rule_text, '^\[\[[^\]]+\]\]\s*', '')
 where rule_text ~ '^\[\[[^\]]+\]\]';

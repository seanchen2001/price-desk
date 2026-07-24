-- Price Desk v2 — esquema Postgres / Supabase (inicial, para Fable)
-- Principios: identidad estable por uuid (models.id, clients.id, suppliers.id); NADA keyeado
-- por el string del nombre; dinero como numeric(12,2); soft-delete con deleted_at donde aplique.
-- RLS: gate por contraseña compartida (o Supabase Auth) — definir policies aparte.

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ---------- catálogo / identidad ----------
create table departments (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique                       -- Teléfonos / iPhone / Laptops / Otros
);

create table categories (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique                       -- Samsung / Motorola LATIN / Motorola EURO / …
);

create table suppliers (
  id     uuid primary key default gen_random_uuid(),
  name   text not null unique,
  code   text,                                    -- código corto para nombre de remito (PL, Mir, …)
  active boolean not null default true
);

create table models (
  id             uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  category_id    uuid references categories(id),
  department_id  uuid references departments(id),
  spec           text,                            -- LATIN / EURO / '' (aplica a Motorola)
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index on models (department_id);

-- ★ La tabla que resuelve el bug de duplicados: cada variante observada → su modelo.
-- alias_key = normalize(alias_text) (ver domain/normalize.ts). UNIQUE global: una clave, un modelo.
create table model_aliases (
  id         uuid primary key default gen_random_uuid(),
  model_id   uuid not null references models(id) on delete cascade,
  alias_text text not null,                       -- el string tal cual lo vimos (auditoría)
  alias_key  text not null unique,                -- normalizado; el resolvedor busca por acá
  created_at timestamptz not null default now()
);
create index on model_aliases (model_id);

-- ---------- precios ----------
create table prices (
  id          uuid primary key default gen_random_uuid(),
  model_id    uuid not null references models(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  price       numeric(12,2) not null,
  updated_at  timestamptz not null default now(),
  unique (model_id, supplier_id)                  -- un precio actual por modelo/proveedor
);
create index on prices (model_id);

-- Escalas por cantidad: EL ÚNICO lugar donde entra una cantidad. Nunca filas "(20 pcs)".
create table price_tiers (
  id          uuid primary key default gen_random_uuid(),
  model_id    uuid not null references models(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  min_qty     integer not null,
  price       numeric(12,2) not null,
  unique (model_id, supplier_id, min_qty)
);

create table price_history (
  id          uuid primary key default gen_random_uuid(),
  model_id    uuid not null references models(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  price       numeric(12,2) not null,
  ts          timestamptz not null default now()
);
create index on price_history (model_id, ts);

create table sale_prices (                        -- la "Lista" (precio de venta)
  model_id uuid primary key references models(id) on delete cascade,
  price    numeric(12,2) not null,
  manual   boolean not null default true          -- false = auto (Mín + margen)
);

create table snapshots (                          -- fotos semanales inmutables → jsonb ok
  id       uuid primary key default gen_random_uuid(),
  week     date not null unique,                  -- lunes del ciclo
  taken_at timestamptz not null default now(),
  payload  jsonb not null                         -- { prices_by_model_supplier, lista_by_model }
);

-- ---------- clientes / envíos ----------
create table clients (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  address          text,
  ruc              text,
  phone            text,
  cuenta_corriente boolean not null default false,
  es_nuestra       boolean not null default false,
  deleted_at       timestamptz
);

create table shippings (
  id        uuid primary key default gen_random_uuid(),
  label     text not null,
  notify    text,
  direccion text,
  telefono  text,
  contacto  text,
  deleted_at timestamptz
);

-- ---------- facturas / órdenes ----------
create table invoices (
  id         uuid primary key default gen_random_uuid(),
  no         text not null,                        -- número visible (no es la PK)
  date       date not null,
  type       text not null default 'factura',      -- factura | remito
  client_id  uuid references clients(id),
  ship_id    uuid references shippings(id),
  piezas     integer,
  subtotal   numeric(12,2),
  shipping   numeric(12,2) default 0,
  total      numeric(12,2),
  cost       numeric(12,2),
  margin     numeric(12,2),
  stage      text not null default 'cotizando',    -- ORDER_STAGES
  client_pdf jsonb,                                 -- snapshot de datos de cliente al facturar
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on invoices (client_id);

create table invoice_items (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoices(id) on delete cascade,
  model_id    uuid references models(id),
  qty         integer not null default 1,
  color       text,
  spec        text,
  supplier_id uuid references suppliers(id),
  cost        numeric(12,2),
  price       numeric(12,2)
);
create index on invoice_items (invoice_id);

-- Una fila por unidad física → IMEI + Nº de serie (reemplaza los arrays paralelos imeis[]/serials[]).
create table invoice_item_units (
  id      uuid primary key default gen_random_uuid(),
  item_id uuid not null references invoice_items(id) on delete cascade,
  imei    text,
  serial  text
);
create index on invoice_item_units (item_id);

-- ---------- cuentas / ledger / ops ----------
-- Cuentas corrientes = derivadas por JOIN de invoices + ledger por client_id/party_id.
-- El ledger guarda solo los movimientos MANUALES (pagos, gastos); los cargos salen de invoices.
create table ledger (
  id              uuid primary key default gen_random_uuid(),
  ts              timestamptz not null default now(),
  side            text not null,                   -- client | supplier
  party_type      text not null,                   -- client | supplier
  party_id        uuid not null,                   -- FK lógica a clients.id / suppliers.id según party_type
  type            text not null,                   -- pago | gasto | cargo
  amount          numeric(12,2) not null,
  concept         text,
  date            date,
  ref_invoice_id  uuid references invoices(id)
);
create index on ledger (party_type, party_id);

create table ops_tracking (
  invoice_id        uuid primary key references invoices(id) on delete cascade,
  afuera            boolean not null default false, -- Miami
  local             boolean not null default false, -- Argentina
  pago              boolean not null default false,
  cargamos_nosotros boolean not null default false
);

-- ---------- agente ----------
create table knowledge (
  id         uuid primary key default gen_random_uuid(),
  rule_text  text not null,
  created_at timestamptz not null default now()
);

create table chat_log (
  id         uuid primary key default gen_random_uuid(),
  ts         timestamptz not null default now(),
  user_text  text,
  actions    jsonb,
  final_text text
);

create table drafts (                              -- órdenes pendientes (transitorio) → jsonb ok
  id         uuid primary key default gen_random_uuid(),
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

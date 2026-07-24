// `prices` + `price_tiers` + `sale_prices` + `price_history` — el corazón del fix R4:
// upsert de UNA fila (onConflict model_id,supplier_id), JAMÁS replace del mapa entero.
// Dos clientes tocando pares distintos no se pisan; el mismo par → last-writer por FILA.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Database } from "./database.types";
import { keys } from "./keys";
import { supabase, unwrap, unwrapVoid, type Db } from "./supabase";

export type PriceRow = Database["public"]["Tables"]["prices"]["Row"];
export type PriceTierRow = Database["public"]["Tables"]["price_tiers"]["Row"];
export type SalePriceRow = Database["public"]["Tables"]["sale_prices"]["Row"];
export type PriceHistoryRow = Database["public"]["Tables"]["price_history"]["Row"];

export type PricePair = { model_id: string; supplier_id: string };
export type PriceUpsert = PricePair & { price: number };
export type TierUpsert = PricePair & { min_qty: number; price: number };

// ---------- prices ----------

export async function listPrices(modelId?: string, db: Db = supabase): Promise<PriceRow[]> {
  const q = db.from("prices").select("*");
  return unwrap(await (modelId === undefined ? q : q.eq("model_id", modelId)));
}

/** Upsert de UNA fila (model_id, supplier_id). El único camino para escribir un precio. */
export async function upsertPrice(row: PriceUpsert, db: Db = supabase): Promise<PriceRow> {
  return unwrap(
    await db
      .from("prices")
      .upsert(
        { ...row, updated_at: new Date().toISOString() },
        { onConflict: "model_id,supplier_id" },
      )
      .select()
      .single(),
  );
}

export async function deletePrice(pair: PricePair, db: Db = supabase): Promise<void> {
  unwrapVoid(
    await db
      .from("prices")
      .delete()
      .eq("model_id", pair.model_id)
      .eq("supplier_id", pair.supplier_id),
  );
}

// ---------- price_tiers (el ÚNICO lugar donde entra una cantidad) ----------

export async function listTiers(modelId?: string, db: Db = supabase): Promise<PriceTierRow[]> {
  const q = db.from("price_tiers").select("*").order("min_qty");
  return unwrap(await (modelId === undefined ? q : q.eq("model_id", modelId)));
}

export async function upsertTier(row: TierUpsert, db: Db = supabase): Promise<PriceTierRow> {
  return unwrap(
    await db
      .from("price_tiers")
      .upsert(row, { onConflict: "model_id,supplier_id,min_qty" })
      .select()
      .single(),
  );
}

export async function deleteTier(id: string, db: Db = supabase): Promise<void> {
  unwrapVoid(await db.from("price_tiers").delete().eq("id", id));
}

/**
 * Reemplaza la escalera de UN par (model, supplier) — la unidad semántica que emite el
 * parser. Scoped por FKs: nunca toca escalas de otros pares (no viola R4).
 */
export async function setTiersForPair(
  pair: PricePair,
  tiers: ReadonlyArray<{ min_qty: number; price: number }>,
  db: Db = supabase,
): Promise<PriceTierRow[]> {
  unwrapVoid(
    await db
      .from("price_tiers")
      .delete()
      .eq("model_id", pair.model_id)
      .eq("supplier_id", pair.supplier_id),
  );
  if (tiers.length === 0) return [];
  return unwrap(
    await db
      .from("price_tiers")
      .insert(tiers.map((t) => ({ ...pair, ...t })))
      .select(),
  );
}

// ---------- sale_prices (la "Lista") ----------

export async function listSalePrices(db: Db = supabase): Promise<SalePriceRow[]> {
  return unwrap(await db.from("sale_prices").select("*"));
}

export async function upsertSalePrice(
  row: { model_id: string; price: number; manual?: boolean },
  db: Db = supabase,
): Promise<SalePriceRow> {
  return unwrap(
    await db.from("sale_prices").upsert(row, { onConflict: "model_id" }).select().single(),
  );
}

export async function deleteSalePrice(modelId: string, db: Db = supabase): Promise<void> {
  unwrapVoid(await db.from("sale_prices").delete().eq("model_id", modelId));
}

// ---------- price_history (append-only) ----------

export async function appendPriceHistory(
  row: PriceUpsert,
  db: Db = supabase,
): Promise<PriceHistoryRow> {
  return unwrap(await db.from("price_history").insert(row).select().single());
}

export async function listPriceHistory(
  modelId: string,
  limit = 500,
  db: Db = supabase,
): Promise<PriceHistoryRow[]> {
  return unwrap(
    await db
      .from("price_history")
      .select("*")
      .eq("model_id", modelId)
      .order("ts", { ascending: false })
      .limit(limit),
  );
}

// ---------- hooks ----------

export function usePrices(modelId?: string) {
  return useQuery({ queryKey: keys.prices(modelId), queryFn: () => listPrices(modelId) });
}

/** Aplica el upsert optimista sobre una lista cacheada (agrega o pisa SU fila). */
function patchPriceList(rows: PriceRow[] | undefined, vars: PriceUpsert): PriceRow[] | undefined {
  if (!rows) return rows;
  const now = new Date().toISOString();
  const i = rows.findIndex(
    (r) => r.model_id === vars.model_id && r.supplier_id === vars.supplier_id,
  );
  if (i === -1) {
    return [...rows, { id: `optimista:${vars.model_id}:${vars.supplier_id}`, ...vars, updated_at: now }];
  }
  return rows.map((r, j) => (j === i ? { ...r, price: vars.price, updated_at: now } : r));
}

export function useUpsertPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.prices(), "upsert"],
    mutationFn: (vars: PriceUpsert) => upsertPrice(vars),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: keys.prices() });
      const affected = [keys.prices(), keys.prices(vars.model_id)];
      const prev = affected.map((k) => [k, qc.getQueryData<PriceRow[]>(k)] as const);
      for (const [k] of prev) {
        qc.setQueryData<PriceRow[]>(k, (rows) => patchPriceList(rows, vars));
      }
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      for (const [k, data] of ctx?.prev ?? []) {
        if (data !== undefined) qc.setQueryData(k, data);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.prices() }),
  });
}

export function useDeletePrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.prices(), "delete"],
    mutationFn: (pair: PricePair) => deletePrice(pair),
    onMutate: async (pair) => {
      await qc.cancelQueries({ queryKey: keys.prices() });
      const affected = [keys.prices(), keys.prices(pair.model_id)];
      const prev = affected.map((k) => [k, qc.getQueryData<PriceRow[]>(k)] as const);
      for (const [k] of prev) {
        qc.setQueryData<PriceRow[]>(k, (rows) =>
          rows?.filter(
            (r) => !(r.model_id === pair.model_id && r.supplier_id === pair.supplier_id),
          ),
        );
      }
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      for (const [k, data] of ctx?.prev ?? []) {
        if (data !== undefined) qc.setQueryData(k, data);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.prices() }),
  });
}

export function useTiers(modelId?: string) {
  return useQuery({ queryKey: keys.priceTiers(modelId), queryFn: () => listTiers(modelId) });
}

export function useUpsertTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.priceTiers(), "upsert"],
    mutationFn: (vars: TierUpsert) => upsertTier(vars),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.priceTiers() }),
  });
}

export function useSetTiersForPair() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.priceTiers(), "set-pair"],
    mutationFn: (vars: { pair: PricePair; tiers: Array<{ min_qty: number; price: number }> }) =>
      setTiersForPair(vars.pair, vars.tiers),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.priceTiers() }),
  });
}

export function useSalePrices() {
  return useQuery({ queryKey: keys.salePrices, queryFn: () => listSalePrices() });
}

export function useUpsertSalePrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.salePrices, "upsert"],
    mutationFn: (vars: { model_id: string; price: number; manual?: boolean }) =>
      upsertSalePrice(vars),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: keys.salePrices });
      const prev = qc.getQueryData<SalePriceRow[]>(keys.salePrices);
      qc.setQueryData<SalePriceRow[]>(keys.salePrices, (rows) => {
        if (!rows) return rows;
        const next: SalePriceRow = {
          model_id: vars.model_id,
          price: vars.price,
          manual: vars.manual ?? true,
        };
        const i = rows.findIndex((r) => r.model_id === vars.model_id);
        return i === -1 ? [...rows, next] : rows.map((r, j) => (j === i ? next : r));
      });
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(keys.salePrices, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.salePrices }),
  });
}

export function usePriceHistory(modelId: string) {
  return useQuery({
    queryKey: keys.priceHistory(modelId),
    queryFn: () => listPriceHistory(modelId),
  });
}

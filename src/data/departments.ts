// `departments` + `categories` — catálogos chicos casi estáticos de la Mesa.
//
// SEED (decisión Fase 5): idempotente al boot vía upsert onConflict(name) +
// ignoreDuplicates, NO una migración 0003_seed.sql — en este entorno las migraciones se
// aplican a mano por el SQL editor y esto es DATA (no schema); el upsert al boot deja
// cualquier base (dev vacía, prod migrada) auto-consistente sin pasos manuales.
// Los nombres vienen del viejo lib/constants.js (DEPTS) + price-logic.js (CATALOG cats).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Database } from "./database.types";
import { reportDataError } from "./errors";
import { keys } from "./keys";
import { supabase, unwrap, unwrapVoid, type Db } from "./supabase";

export type DepartmentRow = Database["public"]["Tables"]["departments"]["Row"];
export type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];

/** Orden canónico de tabs (el viejo DEPTS). El seed y el sort de la UI usan ESTA lista. */
export const DEPARTMENT_NAMES = ["Teléfonos", "iPhone", "Laptops", "Otros"] as const;
export const DEFAULT_DEPARTMENT = "Teléfonos";

/**
 * Filas INICIALES de `categories` (del viejo CATALOG) — SOLO seed. Las categorías son
 * 100% dinámicas: la grilla se arma desde la tabla (el usuario crea/renombra al vuelo y
 * mueve modelos entre ellas); ninguna lista hardcodeada decide qué se muestra.
 */
export const CATEGORY_SEED = [
  "Samsung",
  "Motorola LATIN",
  "Motorola EURO",
  "iPhone",
  "Laptops",
  "Otros",
] as const;

export async function listDepartments(db: Db = supabase): Promise<DepartmentRow[]> {
  return unwrap(await db.from("departments").select("*"));
}

export async function listCategories(db: Db = supabase): Promise<CategoryRow[]> {
  return unwrap(await db.from("categories").select("*"));
}

/** Upsert idempotente de los 4 departamentos + categorías base (no pisa nada existente). */
export async function ensureCatalogSeed(db: Db = supabase): Promise<void> {
  unwrapVoid(
    await db
      .from("departments")
      .upsert(DEPARTMENT_NAMES.map((name) => ({ name })), {
        onConflict: "name",
        ignoreDuplicates: true,
      }),
  );
  unwrapVoid(
    await db
      .from("categories")
      .upsert(CATEGORY_SEED.map((name) => ({ name })), {
        onConflict: "name",
        ignoreDuplicates: true,
      }),
  );
}

export async function insertCategory(name: string, db: Db = supabase): Promise<CategoryRow> {
  return unwrap(await db.from("categories").insert({ name: name.trim() }).select().single());
}

export async function renameCategory(
  id: string,
  name: string,
  db: Db = supabase,
): Promise<CategoryRow> {
  return unwrap(
    await db.from("categories").update({ name: name.trim() }).eq("id", id).select().single(),
  );
}

const deptOrder = (name: string): number => {
  const i = DEPARTMENT_NAMES.indexOf(name as (typeof DEPARTMENT_NAMES)[number]);
  return i === -1 ? DEPARTMENT_NAMES.length : i;
};

export function sortDepartments(rows: DepartmentRow[]): DepartmentRow[] {
  return [...rows].sort(
    (a, b) => deptOrder(a.name) - deptOrder(b.name) || a.name.localeCompare(b.name),
  );
}

// Orden dinámico: alfabético, "Otros" siempre al final. (Un `sort_order` persistido
// necesita DDL — migración 0004 pendiente de acceso SQL; alfabético alcanza para v1 y
// no hardcodea ninguna categoría.)
export function sortCategories(rows: CategoryRow[]): CategoryRow[] {
  return [...rows].sort((a, b) => {
    const ao = a.name === "Otros" ? 1 : 0;
    const bo = b.name === "Otros" ? 1 : 0;
    return ao - bo || a.name.localeCompare(b.name, "es");
  });
}

// ---------- hooks ----------

export function useDepartments() {
  return useQuery({
    queryKey: keys.departments,
    queryFn: async () => sortDepartments(await listDepartments()),
  });
}

export function useCategories() {
  return useQuery({
    queryKey: keys.categories,
    queryFn: async () => sortCategories(await listCategories()),
  });
}

export function useInsertCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.categories, "insert"],
    mutationFn: (name: string) => insertCategory(name),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.categories }),
  });
}

export function useRenameCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...keys.categories, "rename"],
    mutationFn: (vars: { id: string; name: string }) => renameCategory(vars.id, vars.name),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.categories }),
  });
}

/** Corre el seed idempotente una vez al boot y refresca los catálogos. */
export function useEnsureCatalogSeed() {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    ensureCatalogSeed()
      .then(() => {
        if (cancelled) return;
        return Promise.all([
          qc.invalidateQueries({ queryKey: keys.departments }),
          qc.invalidateQueries({ queryKey: keys.categories }),
        ]);
      })
      .catch((error: unknown) => {
        // visible vía el hub central (guardrail: nada de catch{} vacío)
        reportDataError({ operation: "seed departments/categories", error });
      });
    return () => {
      cancelled = true;
    };
  }, [qc]);
}

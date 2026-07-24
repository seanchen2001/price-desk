// Ensambla los datos de la grilla de la Mesa: modelos del departamento agrupados por
// categoría + agregados (rowAggregates), frescura por celda (classifyFreshness) y
// columnas de proveedores del depto. Todo keyeado por IDs (guardrail R1).
import { useMemo } from "react";
import { useCategories, useDepartments, DEFAULT_DEPARTMENT } from "../../data/departments";
import { useModels, type ModelRow } from "../../data/models";
import {
  usePrices,
  useSalePrices,
  useTiers,
  type PriceRow,
  type PriceTierRow,
} from "../../data/prices";
import { useSuppliers, type SupplierRow } from "../../data/suppliers";
import { groupFamilies } from "../../domain/families";
import {
  classifyFreshness,
  rowAggregates,
  type Freshness,
  type RowAggregates,
} from "../../domain/pricing";

export type MesaRow = {
  model: ModelRow;
  categoryName: string;
  /** precio actual por supplierId (todas las celdas, expiradas incluidas) */
  priceBySupplier: Record<string, number>;
  /** updated_at (ms) por supplierId */
  freshBySupplier: Record<string, Freshness>;
  /** escalera por supplierId (solo pares con >1 escalón muestran indicador) */
  tiersBySupplier: Record<string, PriceTierRow[]>;
  /** agregados sobre precios NO expirados (los expirados no cuentan para Mín/Medio/Cliente) */
  agg: RowAggregates;
  /** Mín incluyendo expirados (fallback para Cliente cuando toda la fila venció) */
  minAny: number | null;
  clientStale: boolean;
  /** Lista manual (sale_prices) — null = automática (Mín + margen) */
  salePrice: number | null;
};

/**
 * Fila VISUAL de la grilla: normalmente 1 modelo; una familia (iPhone por color) con el
 * mismo precio comparable se pliega en una fila (representante + colapsados). El split
 * por divergencia es puro cálculo de UI (domain/families.ts) — jamás toca identidad.
 */
export type MesaVisualRow = {
  /** representante (el que se edita inline) */
  row: MesaRow;
  /** lo que se muestra en la columna SKU */
  label: string;
  /** hermanos plegados (0 = fila normal) */
  collapsed: MesaRow[];
  /** colores plegados (representante incluido) cuando collapsed.length > 0 */
  colors: string[];
};

export type MesaCategoryGroup = { category: string; rows: MesaVisualRow[] };

export type MesaData = {
  loading: boolean;
  departments: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  suppliers: SupplierRow[];
  /** columnas del departamento: proveedores con al menos un precio acá; sin precios aún → todos */
  deptSuppliers: SupplierRow[];
  groups: MesaCategoryGroup[];
  /** cantidad de filas del depto sin ningún precio (para el toggle "ocultar sin precio") */
  emptyCount: number;
};

export function useMesaData(selectedDeptId: string | null, marginPct: number, hideEmpty: boolean): MesaData {
  const departments = useDepartments();
  const categories = useCategories();
  const suppliers = useSuppliers();
  const models = useModels();
  const prices = usePrices();
  const tiers = useTiers();
  const salePrices = useSalePrices();

  const loading =
    departments.isLoading ||
    categories.isLoading ||
    suppliers.isLoading ||
    models.isLoading ||
    prices.isLoading ||
    tiers.isLoading ||
    salePrices.isLoading;

  return useMemo(() => {
    const deptRows = departments.data ?? [];
    const catRows = categories.data ?? [];
    const supplierRows = suppliers.data ?? [];
    const modelRows = models.data ?? [];
    const priceRows = prices.data ?? [];
    const tierRows = tiers.data ?? [];
    const saleRows = salePrices.data ?? [];

    const catNameById = new Map(catRows.map((c) => [c.id, c.name]));
    const supplierById = new Map(supplierRows.map((s) => [s.id, s]));
    const saleByModel = new Map(saleRows.map((r) => [r.model_id, r.price]));

    const pricesByModel = new Map<string, PriceRow[]>();
    for (const p of priceRows) {
      const arr = pricesByModel.get(p.model_id);
      if (arr) arr.push(p);
      else pricesByModel.set(p.model_id, [p]);
    }
    const tiersByModel = new Map<string, PriceTierRow[]>();
    for (const t of tierRows) {
      const arr = tiersByModel.get(t.model_id);
      if (arr) arr.push(t);
      else tiersByModel.set(t.model_id, [t]);
    }

    // depto default (Teléfonos) absorbe los modelos sin department_id — como el viejo
    const defaultDeptId = deptRows.find((d) => d.name === DEFAULT_DEPARTMENT)?.id ?? null;
    const deptModels = selectedDeptId
      ? modelRows.filter(
          (m) =>
            m.department_id === selectedDeptId ||
            (m.department_id === null && selectedDeptId === defaultDeptId),
        )
      : [];

    const now = Date.now();
    const rows: MesaRow[] = [];
    const deptSupplierIds = new Set<string>();
    let emptyCount = 0;

    for (const model of deptModels) {
      const rowPrices = pricesByModel.get(model.id) ?? [];
      if (rowPrices.length === 0) emptyCount += 1;
      if (hideEmpty && rowPrices.length === 0) continue;

      const priceBySupplier: Record<string, number> = {};
      const freshBySupplier: Record<string, Freshness> = {};
      const freshPrices: Record<string, number> = {};
      const allVals: number[] = [];
      for (const p of rowPrices) {
        deptSupplierIds.add(p.supplier_id);
        priceBySupplier[p.supplier_id] = p.price;
        allVals.push(p.price);
        const st = classifyFreshness(Date.parse(p.updated_at), now);
        freshBySupplier[p.supplier_id] = st;
        if (st !== "expired") freshPrices[p.supplier_id] = p.price;
      }

      const tiersBySupplier: Record<string, PriceTierRow[]> = {};
      for (const t of tiersByModel.get(model.id) ?? []) {
        (tiersBySupplier[t.supplier_id] ??= []).push(t);
      }
      for (const arr of Object.values(tiersBySupplier)) arr.sort((a, b) => a.min_qty - b.min_qty);

      const agg = rowAggregates(freshPrices, marginPct);
      const minAny = allVals.length ? Math.min(...allVals) : null;
      // toda la fila expirada → Cliente igual se muestra desde el último mínimo conocido
      let client = agg.client;
      let clientStale = false;
      if (client === null && minAny !== null) {
        client = Math.round(minAny * (1 + marginPct / 100));
        clientStale = true;
      }

      rows.push({
        model,
        categoryName: model.category_id
          ? (catNameById.get(model.category_id) ?? "Otros")
          : "Otros",
        priceBySupplier,
        freshBySupplier,
        tiersBySupplier,
        agg: { ...agg, client },
        minAny,
        clientStale,
        salePrice: saleByModel.get(model.id) ?? null,
      });
    }

    // agrupar por categoría — 100% dinámico desde la tabla `categories` (useCategories ya
    // ordena; "Otros" al final absorbe los modelos sin categoría)
    const groups: MesaCategoryGroup[] = [];
    const orderedCats = [...catRows.map((c) => c.name), "Otros"];
    for (const cat of orderedCats) {
      const catModels = rows.filter((r) => r.categoryName === cat);
      if (catModels.length === 0 || groups.some((g) => g.category === cat)) continue;
      // plegado por familia (colores iPhone): comparable = Mín fresco de la fila
      const visual = groupFamilies(
        catModels,
        (r) => r.model.canonical_name,
        (r) => String(r.agg.min ?? "np"),
      ).map((g) => {
        const rep = g.items[0];
        if (!rep) throw new Error("groupFamilies devolvió un grupo vacío"); // imposible
        return {
          row: rep,
          label: g.familyName,
          collapsed: g.items.slice(1),
          colors: g.colors,
        };
      });
      groups.push({ category: cat, rows: visual });
    }

    const deptSuppliers = supplierRows.length
      ? deptSupplierIds.size
        ? [...deptSupplierIds]
            .map((id) => supplierById.get(id))
            .filter((s): s is SupplierRow => s !== undefined)
            .sort((a, b) => a.name.localeCompare(b.name))
        : supplierRows // depto sin precios aún → todas las columnas (para poder arrancar)
      : [];

    return {
      loading,
      departments: deptRows,
      categories: catRows,
      suppliers: supplierRows,
      deptSuppliers,
      groups,
      emptyCount,
    };
  }, [
    loading,
    departments.data,
    categories.data,
    suppliers.data,
    models.data,
    prices.data,
    tiers.data,
    salePrices.data,
    selectedDeptId,
    marginPct,
    hideEmpty,
  ]);
}

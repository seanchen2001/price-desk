// Ensambla los datos que necesita el armador de órdenes: catálogo (para el buscador),
// matrices de precio/escala por ID (autocompletar costo con costForQty), Lista (precio de
// venta default), clientes/envíos/proveedores y el próximo número de factura.
import { useMemo } from "react";
import { useClients, useShippings, type ClientRow, type ShippingRow } from "../../data/clients";
import { useCategories } from "../../data/departments";
import { useInvoices } from "../../data/invoices";
import { useModels, type ModelRow } from "../../data/models";
import { usePrices, useSalePrices, useTiers } from "../../data/prices";
import { useSuppliers, type SupplierRow } from "../../data/suppliers";
import { nextInvoiceNo } from "../../domain/orders";
import { costForQty, hasTiers, type PriceMatrix, type Tier, type TierMatrix } from "../../domain/planning";
import { rowAggregates } from "../../domain/pricing";

export type OrdenesData = {
  loading: boolean;
  clients: ClientRow[];
  shippings: ShippingRow[];
  suppliers: SupplierRow[];
  supplierById: Map<string, SupplierRow>;
  models: ModelRow[];
  modelById: Map<string, ModelRow>;
  categoryNameById: Map<string, string>;
  /** nombre canónico → modelo (para el buscador con datalist, como el viejo) */
  modelByName: Map<string, ModelRow>;
  priceMatrix: PriceMatrix;
  tierMatrix: TierMatrix;
  /** costo del proveedor para una cantidad (escala si existe, si no precio base) */
  costFor: (modelId: string, supplierId: string | null, qty: number) => number;
  tiersFor: (modelId: string, supplierId: string | null) => Tier[];
  hasTiersFor: (modelId: string, supplierId: string | null) => boolean;
  /** proveedores con precio conocido para el modelo, más barato primero */
  suppliersFor: (modelId: string) => Array<{ supplier: SupplierRow; price: number }>;
  /** precio de venta default: Lista manual, si no Mín+3% (como el viejo) */
  defaultSalePrice: (modelId: string) => number;
  categoryNameOf: (model: ModelRow) => string;
  nextNo: number;
};

export function useOrdenesData(): OrdenesData {
  const clients = useClients();
  const shippings = useShippings();
  const suppliers = useSuppliers();
  const models = useModels();
  const categories = useCategories();
  const prices = usePrices();
  const tiers = useTiers();
  const salePrices = useSalePrices();
  const invoices = useInvoices();

  const loading =
    clients.isLoading ||
    shippings.isLoading ||
    suppliers.isLoading ||
    models.isLoading ||
    categories.isLoading ||
    prices.isLoading ||
    tiers.isLoading ||
    salePrices.isLoading ||
    invoices.isLoading;

  return useMemo(() => {
    const clientRows = clients.data ?? [];
    const shipRows = shippings.data ?? [];
    const supplierRows = suppliers.data ?? [];
    const modelRows = models.data ?? [];
    const catRows = categories.data ?? [];
    const priceRows = prices.data ?? [];
    const tierRows = tiers.data ?? [];
    const saleRows = salePrices.data ?? [];
    const invoiceRows = invoices.data ?? [];

    const supplierById = new Map(supplierRows.map((s) => [s.id, s]));
    const modelById = new Map(modelRows.map((m) => [m.id, m]));
    const categoryNameById = new Map(catRows.map((c) => [c.id, c.name]));
    const modelByName = new Map(modelRows.map((m) => [m.canonical_name, m]));
    const saleByModel = new Map(saleRows.map((r) => [r.model_id, r.price]));

    const priceMatrix: PriceMatrix = {};
    for (const p of priceRows) {
      (priceMatrix[p.model_id] ??= {})[p.supplier_id] = p.price;
    }
    const tierMatrix: TierMatrix = {};
    for (const t of tierRows) {
      ((tierMatrix[t.model_id] ??= {})[t.supplier_id] ??= []).push({ min: t.min_qty, price: t.price });
    }

    const costFor = (modelId: string, supplierId: string | null, qty: number): number =>
      supplierId ? costForQty(priceMatrix, tierMatrix, modelId, supplierId, qty) : 0;
    const tiersFor = (modelId: string, supplierId: string | null): Tier[] =>
      (supplierId ? tierMatrix[modelId]?.[supplierId] : undefined) ?? [];
    const hasTiersFor = (modelId: string, supplierId: string | null): boolean =>
      supplierId ? hasTiers(tierMatrix, modelId, supplierId) : false;

    const suppliersFor = (modelId: string): Array<{ supplier: SupplierRow; price: number }> =>
      Object.entries(priceMatrix[modelId] ?? {})
        .map(([supplierId, price]) => {
          const supplier = supplierById.get(supplierId);
          return supplier ? { supplier, price } : null;
        })
        .filter((x): x is { supplier: SupplierRow; price: number } => x !== null)
        .sort((a, b) => a.price - b.price);

    const defaultSalePrice = (modelId: string): number => {
      const lista = saleByModel.get(modelId);
      if (typeof lista === "number") return lista;
      return rowAggregates(priceMatrix[modelId] ?? {}, 3).client ?? 0;
    };

    const categoryNameOf = (model: ModelRow): string =>
      model.category_id ? (categoryNameById.get(model.category_id) ?? "") : "";

    return {
      loading,
      clients: clientRows,
      shippings: shipRows,
      suppliers: supplierRows,
      supplierById,
      models: modelRows,
      modelById,
      categoryNameById,
      modelByName,
      priceMatrix,
      tierMatrix,
      costFor,
      tiersFor,
      hasTiersFor,
      suppliersFor,
      defaultSalePrice,
      categoryNameOf,
      nextNo: nextInvoiceNo(invoiceRows),
    };
  }, [
    loading,
    clients.data,
    shippings.data,
    suppliers.data,
    models.data,
    categories.data,
    prices.data,
    tiers.data,
    salePrices.data,
    invoices.data,
  ]);
}

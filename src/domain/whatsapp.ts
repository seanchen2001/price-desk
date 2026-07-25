// Armador de cotización WhatsApp — puerto del whatsappQuoteText viejo (lib/ai.js +
// quoteText de electronics-price-tool.jsx): grupos por categoría separados por línea en
// blanco, una línea por modelo "NOMBRE<TAB>$precio" (redondeado; "—" si no hay precio).
// La categoría va en *negritas* de WhatsApp. Precio = Lista (sale_prices manual) y si no
// hay, Mín + margen% (mismo fallback listaFor del viejo). PURO: la UI y la tool del
// agente le pasan los grupos ya armados.

export type WhatsappItem = { name: string; price: number | null };
export type WhatsappGroup = { category: string; items: WhatsappItem[] };

export function whatsappQuoteText(groups: readonly WhatsappGroup[]): string {
  return groups
    .filter((g) => g.items.length > 0)
    .map(
      (g) =>
        `*${g.category}*\n` +
        g.items
          .map((i) => `${i.name}\t${i.price === null ? "—" : "$" + Math.round(i.price)}`)
          .join("\n"),
    )
    .join("\n\n");
}

/** listaFor del viejo: Lista manual ?? round((min ?? minAny) × (1+margen%)) ?? null. */
export function listaPrice(
  salePrice: number | null,
  min: number | null,
  minAny: number | null,
  marginPct: number,
): number | null {
  if (salePrice !== null) return salePrice;
  const base = min ?? minAny;
  return base !== null ? Math.round(base * (1 + marginPct / 100)) : null;
}

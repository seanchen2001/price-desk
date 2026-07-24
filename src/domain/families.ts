// Agrupación visual por FAMILIA (caso iPhone por color) — PURO, solo presentación.
// Cada color con precio propio ES su propio model_id (eso no se toca); acá solo se decide
// qué filas se PLIEGAN en la Mesa: los colores de una familia con el mismo precio
// comparable se muestran colapsados en una fila, y el color que diverge (ej. Naranja más
// barato) se separa en su propia fila — el resto sigue plegado.
import { extractColor } from "./colors";
import { normalize } from "./normalize";

export type VisualGroup<T> = {
  /** nombre base de la familia (sin color); para singles, el nombre tal cual */
  familyName: string;
  /** modelos plegados en esta fila visual (1..n) */
  items: T[];
  /** colores de los items plegados (solo cuando items.length > 1) */
  colors: string[];
};

/**
 * items → filas visuales. familyKey = normalize(nombre sin token de color); dentro de una
 * familia, los items se bucketizan por `getComparable` (ej. String(min)): bucket con todos
 * = fila colapsada; cada valor divergente = su propia fila. El orden de entrada se respeta.
 */
export function groupFamilies<T>(
  items: readonly T[],
  getName: (item: T) => string,
  getComparable: (item: T) => string,
): VisualGroup<T>[] {
  type Tagged = { item: T; name: string; color: string | null; base: string };
  const tagged: Tagged[] = items.map((item) => {
    const name = getName(item);
    const { color, base } = extractColor(name);
    return { item, name, color, base };
  });

  // familias por clave normalizada del nombre base (un item sin color puede unirse
  // a la familia de sus hermanos con color: misma base)
  const families = new Map<string, Tagged[]>();
  const order: string[] = [];
  for (const t of tagged) {
    const key = normalize(t.base);
    const fam = families.get(key);
    if (fam) fam.push(t);
    else {
      families.set(key, [t]);
      order.push(key);
    }
  }

  const out: VisualGroup<T>[] = [];
  for (const key of order) {
    const fam = families.get(key);
    if (!fam || fam.length === 0) continue;
    const first = fam[0];
    if (!first) continue;
    if (fam.length === 1) {
      // single: pasa directo con su nombre completo (color incluido si lo tiene)
      out.push({ familyName: first.name, items: [first.item], colors: [] });
      continue;
    }
    // familia real: bucket por precio comparable, respetando orden de aparición
    const buckets = new Map<string, Tagged[]>();
    const bucketOrder: string[] = [];
    for (const t of fam) {
      const c = getComparable(t.item);
      const b = buckets.get(c);
      if (b) b.push(t);
      else {
        buckets.set(c, [t]);
        bucketOrder.push(c);
      }
    }
    for (const c of bucketOrder) {
      const bucket = buckets.get(c);
      if (!bucket || bucket.length === 0) continue;
      const bFirst = bucket[0];
      if (!bFirst) continue;
      if (bucket.length === 1) {
        // divergente (o único con ese precio): fila propia con nombre completo
        out.push({ familyName: bFirst.name, items: [bFirst.item], colors: [] });
      } else {
        out.push({
          familyName: bFirst.base,
          items: bucket.map((t) => t.item),
          colors: bucket.map((t) => t.color ?? "—"),
        });
      }
    }
  }
  return out;
}

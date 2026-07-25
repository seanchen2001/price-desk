// Preferencias de UI de la grilla (zustand + persist en localStorage):
//  - anchos de columna (drag en el borde del header; key por columna)
//  - categorías colapsadas (click en el header de categoría pliega/despliega)
import { create } from "zustand";
import { persist } from "zustand/middleware";

export const MIN_COL_PX = 60;
export const MAX_COL_PX = 620;

type MesaUiState = {
  colWidths: Record<string, number>;
  setColWidth: (key: string, px: number) => void;
  collapsedCats: Record<string, boolean>;
  toggleCat: (name: string) => void;
};

export const useMesaUi = create<MesaUiState>()(
  persist(
    (set) => ({
      colWidths: {},
      setColWidth: (key, px) =>
        set((st) => ({
          colWidths: {
            ...st.colWidths,
            [key]: Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, Math.round(px))),
          },
        })),
      collapsedCats: {},
      toggleCat: (name) =>
        set((st) => ({
          collapsedCats: { ...st.collapsedCats, [name]: !st.collapsedCats[name] },
        })),
    }),
    { name: "price-desk-mesa-ui" },
  ),
);

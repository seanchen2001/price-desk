// Estado del panel lateral del agente (abierto/cerrado) — zustand + persist en
// localStorage: el trader lo deja como le gusta y sobrevive al reload (paridad con el
// ChatBox del viejo, que vivía colapsable a la derecha).
import { create } from "zustand";
import { persist } from "zustand/middleware";

type AgentPanelState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

export const useAgentPanel = create<AgentPanelState>()(
  persist(
    (set) => ({
      open: true,
      setOpen: (open) => set({ open }),
      toggle: () => set((s) => ({ open: !s.open })),
    }),
    { name: "price-desk-agent-panel" },
  ),
);

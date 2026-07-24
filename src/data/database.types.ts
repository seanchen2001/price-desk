// PLACEHOLDER Fase 2: tipos mínimos hasta generar los reales contra el schema aplicado.
// No usar en features: la capa de datos (Fase 4) llega junto con los tipos generados.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: Record<string, { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> }>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

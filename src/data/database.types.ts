// GENERADO por scripts/gen-types.mjs contra el schema real — NO editar a mano.
// Regenerar tras cada migración: node scripts/gen-types.mjs
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      categories: {
        Row: {
          id: string;
          name: string;
        };
        Insert: {
          id?: string;
          name: string;
        };
        Update: {
          id?: string;
          name?: string;
        };
        Relationships: [];
      };
      chat_log: {
        Row: {
          id: string;
          ts: string;
          user_text: string | null;
          actions: Json | null;
          final_text: string | null;
        };
        Insert: {
          id?: string;
          ts?: string;
          user_text?: string | null;
          actions?: Json | null;
          final_text?: string | null;
        };
        Update: {
          id?: string;
          ts?: string;
          user_text?: string | null;
          actions?: Json | null;
          final_text?: string | null;
        };
        Relationships: [];
      };
      clients: {
        Row: {
          id: string;
          name: string;
          address: string | null;
          ruc: string | null;
          phone: string | null;
          cuenta_corriente: boolean;
          es_nuestra: boolean;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          address?: string | null;
          ruc?: string | null;
          phone?: string | null;
          cuenta_corriente?: boolean;
          es_nuestra?: boolean;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          address?: string | null;
          ruc?: string | null;
          phone?: string | null;
          cuenta_corriente?: boolean;
          es_nuestra?: boolean;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      departments: {
        Row: {
          id: string;
          name: string;
        };
        Insert: {
          id?: string;
          name: string;
        };
        Update: {
          id?: string;
          name?: string;
        };
        Relationships: [];
      };
      drafts: {
        Row: {
          id: string;
          payload: Json;
          updated_at: string;
        };
        Insert: {
          id?: string;
          payload: Json;
          updated_at?: string;
        };
        Update: {
          id?: string;
          payload?: Json;
          updated_at?: string;
        };
        Relationships: [];
      };
      invoice_item_units: {
        Row: {
          id: string;
          item_id: string;
          imei: string | null;
          serial: string | null;
        };
        Insert: {
          id?: string;
          item_id: string;
          imei?: string | null;
          serial?: string | null;
        };
        Update: {
          id?: string;
          item_id?: string;
          imei?: string | null;
          serial?: string | null;
        };
        Relationships: [];
      };
      invoice_items: {
        Row: {
          id: string;
          invoice_id: string;
          model_id: string | null;
          qty: number;
          color: string | null;
          spec: string | null;
          supplier_id: string | null;
          cost: number | null;
          price: number | null;
        };
        Insert: {
          id?: string;
          invoice_id: string;
          model_id?: string | null;
          qty?: number;
          color?: string | null;
          spec?: string | null;
          supplier_id?: string | null;
          cost?: number | null;
          price?: number | null;
        };
        Update: {
          id?: string;
          invoice_id?: string;
          model_id?: string | null;
          qty?: number;
          color?: string | null;
          spec?: string | null;
          supplier_id?: string | null;
          cost?: number | null;
          price?: number | null;
        };
        Relationships: [];
      };
      invoices: {
        Row: {
          id: string;
          no: string;
          date: string;
          type: string;
          client_id: string | null;
          ship_id: string | null;
          piezas: number | null;
          subtotal: number | null;
          shipping: number | null;
          total: number | null;
          cost: number | null;
          margin: number | null;
          stage: string;
          client_pdf: Json | null;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          no: string;
          date: string;
          type?: string;
          client_id?: string | null;
          ship_id?: string | null;
          piezas?: number | null;
          subtotal?: number | null;
          shipping?: number | null;
          total?: number | null;
          cost?: number | null;
          margin?: number | null;
          stage?: string;
          client_pdf?: Json | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          no?: string;
          date?: string;
          type?: string;
          client_id?: string | null;
          ship_id?: string | null;
          piezas?: number | null;
          subtotal?: number | null;
          shipping?: number | null;
          total?: number | null;
          cost?: number | null;
          margin?: number | null;
          stage?: string;
          client_pdf?: Json | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      knowledge: {
        Row: {
          id: string;
          rule_text: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          rule_text: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          rule_text?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      ledger: {
        Row: {
          id: string;
          ts: string;
          side: string;
          party_type: string;
          party_id: string;
          type: string;
          amount: number;
          concept: string | null;
          date: string | null;
          ref_invoice_id: string | null;
        };
        Insert: {
          id?: string;
          ts?: string;
          side: string;
          party_type: string;
          party_id: string;
          type: string;
          amount: number;
          concept?: string | null;
          date?: string | null;
          ref_invoice_id?: string | null;
        };
        Update: {
          id?: string;
          ts?: string;
          side?: string;
          party_type?: string;
          party_id?: string;
          type?: string;
          amount?: number;
          concept?: string | null;
          date?: string | null;
          ref_invoice_id?: string | null;
        };
        Relationships: [];
      };
      model_aliases: {
        Row: {
          id: string;
          model_id: string;
          alias_text: string;
          alias_key: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          model_id: string;
          alias_text: string;
          alias_key: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          model_id?: string;
          alias_text?: string;
          alias_key?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      models: {
        Row: {
          id: string;
          canonical_name: string;
          category_id: string | null;
          department_id: string | null;
          spec: string | null;
          active: boolean;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          canonical_name: string;
          category_id?: string | null;
          department_id?: string | null;
          spec?: string | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          canonical_name?: string;
          category_id?: string | null;
          department_id?: string | null;
          spec?: string | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      ops_tracking: {
        Row: {
          invoice_id: string;
          afuera: boolean;
          local: boolean;
          pago: boolean;
          cargamos_nosotros: boolean;
        };
        Insert: {
          invoice_id?: string;
          afuera?: boolean;
          local?: boolean;
          pago?: boolean;
          cargamos_nosotros?: boolean;
        };
        Update: {
          invoice_id?: string;
          afuera?: boolean;
          local?: boolean;
          pago?: boolean;
          cargamos_nosotros?: boolean;
        };
        Relationships: [];
      };
      price_history: {
        Row: {
          id: string;
          model_id: string;
          supplier_id: string;
          price: number;
          ts: string;
        };
        Insert: {
          id?: string;
          model_id: string;
          supplier_id: string;
          price: number;
          ts?: string;
        };
        Update: {
          id?: string;
          model_id?: string;
          supplier_id?: string;
          price?: number;
          ts?: string;
        };
        Relationships: [];
      };
      price_tiers: {
        Row: {
          id: string;
          model_id: string;
          supplier_id: string;
          min_qty: number;
          price: number;
        };
        Insert: {
          id?: string;
          model_id: string;
          supplier_id: string;
          min_qty: number;
          price: number;
        };
        Update: {
          id?: string;
          model_id?: string;
          supplier_id?: string;
          min_qty?: number;
          price?: number;
        };
        Relationships: [];
      };
      prices: {
        Row: {
          id: string;
          model_id: string;
          supplier_id: string;
          price: number;
          updated_at: string;
        };
        Insert: {
          id?: string;
          model_id: string;
          supplier_id: string;
          price: number;
          updated_at?: string;
        };
        Update: {
          id?: string;
          model_id?: string;
          supplier_id?: string;
          price?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      sale_prices: {
        Row: {
          model_id: string;
          price: number;
          manual: boolean;
        };
        Insert: {
          model_id?: string;
          price: number;
          manual?: boolean;
        };
        Update: {
          model_id?: string;
          price?: number;
          manual?: boolean;
        };
        Relationships: [];
      };
      shippings: {
        Row: {
          id: string;
          label: string;
          notify: string | null;
          direccion: string | null;
          telefono: string | null;
          contacto: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          label: string;
          notify?: string | null;
          direccion?: string | null;
          telefono?: string | null;
          contacto?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          label?: string;
          notify?: string | null;
          direccion?: string | null;
          telefono?: string | null;
          contacto?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      snapshots: {
        Row: {
          id: string;
          week: string;
          taken_at: string;
          payload: Json;
        };
        Insert: {
          id?: string;
          week: string;
          taken_at?: string;
          payload: Json;
        };
        Update: {
          id?: string;
          week?: string;
          taken_at?: string;
          payload?: Json;
        };
        Relationships: [];
      };
      suppliers: {
        Row: {
          id: string;
          name: string;
          code: string | null;
          active: boolean;
        };
        Insert: {
          id?: string;
          name: string;
          code?: string | null;
          active?: boolean;
        };
        Update: {
          id?: string;
          name?: string;
          code?: string | null;
          active?: boolean;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

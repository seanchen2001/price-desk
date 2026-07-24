// Errores de la capa de datos: SIEMPRE visibles (guardrail R4: nada de catch{} que
// trague errores). Las mutaciones/queries propagan el error a React Query y ADEMÁS
// pasan por este hub central, listo para colgarle un toast global desde la UI.
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

export type DataError = {
  /** qué operación falló, p.ej. "query models" o "mutation prices/upsert" */
  operation: string;
  error: unknown;
};

export type DataErrorHandler = (e: DataError) => void;

const defaultHandler: DataErrorHandler = ({ operation, error }) => {
  console.error(`[data] ${operation} falló:`, error);
};

let handler: DataErrorHandler = defaultHandler;

/** La UI registra acá su toast global (App.tsx). El default loguea a consola. */
export function setDataErrorHandler(h: DataErrorHandler | null): void {
  handler = h ?? defaultHandler;
}

export function reportDataError(e: DataError): void {
  handler(e);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** QueryClient con el reporte central de errores cableado (queries y mutaciones). */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        reportDataError({ operation: `query ${query.queryKey.join("/")}`, error });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const name = mutation.options.mutationKey?.join("/") ?? "mutación";
        reportDataError({ operation: `mutation ${name}`, error });
      },
    }),
  });
}

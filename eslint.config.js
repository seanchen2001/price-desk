import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "resolver.golden.test.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // guardrail R4: nada de catch{} que trague errores
      "no-empty": ["error", { "allowEmptyCatch": false }],
    },
  }
);

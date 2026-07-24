import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // guardrail R4: nada de catch{} que trague errores
      "no-empty": ["error", { "allowEmptyCatch": false }],
    },
  },
  {
    // scripts Node sueltos (.mjs): globals de Node para no-undef
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        WebSocket: "readonly",
      },
    },
  }
);

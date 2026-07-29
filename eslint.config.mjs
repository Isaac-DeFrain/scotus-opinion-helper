import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(["dist/**", "data/**"]),
  {
    rules: {
      // ThemeToggle reads document theme after mount to avoid SSR/client mismatch.
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;

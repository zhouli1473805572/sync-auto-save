import { fileURLToPath } from "node:url";
import obsidianmd from "eslint-plugin-obsidianmd";
import noUnsanitized from "eslint-plugin-no-unsanitized";
import tseslint from "typescript-eslint";

// Run the API, DOM safety, and UI rules reported by community review.
export default [
  {
    files: ["src/**/*.ts", "pro/src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
      },
    },
    plugins: { obsidianmd, "no-unsanitized": noUnsanitized },
    rules: {
      "obsidianmd/no-unsupported-api": "error",
      "obsidianmd/no-forbidden-elements": "error",
      "obsidianmd/no-static-styles-assignment": "error",
      "obsidianmd/platform": "error",
      "obsidianmd/settings-tab/no-manual-html-headings": "error",
      "no-unsanitized/property": "error",
      "no-unsanitized/method": "error",
    },
  },
];

import js from "@eslint/js";
import {
    defineConfig,
    globalIgnores,
} from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
    globalIgnores([
        "dist",
        "node_modules",
        ".wrangler",
        "**/coverage",
        "**/worker-configuration.d.ts",
    ]),
    {
        files: ["src/**/*.ts", "test/**/*.ts"],
        extends: [
            js.configs.recommended,
            tseslint.configs.strictTypeChecked,
        ],
        languageOptions: {
            ecmaVersion: 2022,
            // Type-aware linting. Costs a TS program build on every lint run, but
            // it is what strictTypeChecked's rules need to see through to declaration
            // files — no-deprecated among them, which tsc only ever reports as an
            // editor-level suggestion (ts6385) and would otherwise never fail CI.
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.node,
                ...globals.worker,
            },
        },
        rules: {
            // Interpolating a numeric constant into a message is not the hazard this
            // rule guards against — that is objects rendering as "[object Object]".
            "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
            "@typescript-eslint/no-unused-vars": ["error", {
                argsIgnorePattern: "^_",
                varsIgnorePattern: "^_",
                destructuredArrayIgnorePattern: "^_",
            }],
        },
    },
]);

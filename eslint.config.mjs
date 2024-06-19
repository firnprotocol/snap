import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat();

export default [
  pluginJs.configs.recommended,
  ...compat.extends("airbnb-base"),
  eslintConfigPrettier,
  {
    ignores: [
      "node_modules",
      "dist",
      "build",
      ".env",
      ".env.local",
      ".env.development.local",
      ".env.test.local",
      ".env.production.local",
      "*.log",
      ".idea",
      ".vscode",
      "*.sublime-project",
      "*.sublime-workspace",
      ".DS_Store",
      "Thumbs.db",
      "public",
      "coverage",
      "*.min.js",
      "*.min.css",
      "*.png",
      "*.jpg",
      "*.jpeg",
      "*.gif",
      "*.svg",
      "*.ico",
      "*.webp",
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.json",
      ".eslintrc.yml",
      ".eslintignore",
      ".prettierrc",
      ".prettierrc.js",
      ".prettierrc.json",
      ".prettierrc.yml",
      ".prettierignore",
      "eslint.config.mjs",
      "eslint.config.js",
    ],
  },
];

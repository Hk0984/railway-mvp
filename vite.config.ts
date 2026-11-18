import { defineConfig } from "vite";
export default defineConfig(({ command, mode }) => ({
  base: command === "build" && mode === "pages" ? "/railway-mvp/" : "/",
  server: {
    watch: {
      ignored: [
        "**/artifacts/**",
        "**/.npm-cache/**",
        "**/tests/fixtures/real/**",
      ],
    },
  },
}));

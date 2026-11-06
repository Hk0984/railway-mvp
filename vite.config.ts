import { defineConfig } from "vite";
export default defineConfig({
  server: {
    watch: {
      ignored: [
        "**/artifacts/**",
        "**/.npm-cache/**",
        "**/tests/fixtures/real/**",
      ],
    },
  },
});

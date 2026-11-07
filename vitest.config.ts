import { defineConfig } from "vitest/config";
// CPU-heavy synchronous real-file profiles must not contend with each other or distort benchmarks.
export default defineConfig({ test: { fileParallelism: false } });

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "e2e/**/*.test.ts"],
    // The receiver module opens its default store at import time; point that
    // throwaway singleton at a private in-memory database so parallel workers
    // never contend on the `kintsugi.db` file lock. Tests pass explicit
    // stores, so production wiring (env-driven, file-backed when unset) is untouched.
    env: { KINTSUGI_DB_PATH: ":memory:" },
  },
});

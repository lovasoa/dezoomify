// Test-time TSX loader: the root suite runs on bare `node --test`, which
// strips types from `.ts` but cannot parse JSX. This synchronous module hook
// transpiles `.tsx` with the already-vendored esbuild, so React components
// stay source-first and importable from node:test without a bundler.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const { code } = transformSync(source, {
        loader: "tsx",
        format: "esm",
        target: "es2022",
        jsx: "automatic",
        sourcemap: "inline",
        sourcefile: url,
      });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

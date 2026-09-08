import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

export function transpileTypeScript(source, sourcefile) {
  const { code } = transformSync(source, { loader: "ts", format: "esm", target: "es2022", sourcefile, sourcemap: "inline" });
  if (!code) throw new Error(`esbuild produced no JavaScript for ${sourcefile}`);
  return code;
}

export function importTypeScript(url, cacheKey = "") {
  const code = transpileTypeScript(readFileSync(url, "utf8"), url.pathname);
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}#${cacheKey}`);
}

import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = (...parts) => resolve(root, ...parts);

await mkdir(fromRoot("dist/web"), { recursive: true });
await build({
  entryPoints: [fromRoot("web/src/app.ts")],
  absWorkingDir: root,
  bundle: true,
  format: "iife",
  minify: true,
  sourcemap: true,
  outfile: fromRoot("dist/web/app.js"),
  target: "es2020",
});
const gridStyles = fromRoot("node_modules/ag-grid-community/styles");
await Promise.all([
  cp(fromRoot("web/index.html"), fromRoot("dist/web/index.html")),
  cp(fromRoot("web/styles.css"), fromRoot("dist/web/styles.css")),
  cp(resolve(gridStyles, "ag-grid.css"), fromRoot("dist/web/ag-grid.css")),
  cp(resolve(gridStyles, "ag-theme-quartz.css"), fromRoot("dist/web/ag-theme-quartz.css")),
]);
console.log("web built");

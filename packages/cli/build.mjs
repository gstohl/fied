import { build } from "esbuild";

await build({
  entryPoints: ["src/bin.ts"],
  bundle: true,
  outfile: "dist/bin.js",
  format: "esm",
  platform: "node",
  target: "node18",
  banner: { js: "#!/usr/bin/env node" },
  external: ["node-pty"],
});

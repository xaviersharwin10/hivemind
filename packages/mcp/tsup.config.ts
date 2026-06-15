import { defineConfig } from "tsup";

// Bundle our own glue (the MCP server + @hivemind/core source) into a single
// self-contained CLI; leave the heavy SDKs as runtime deps that npm installs.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node18",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
  noExternal: ["@hivemind/core"],
  clean: true,
  sourcemap: false,
  minify: false,
});

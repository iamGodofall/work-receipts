// Loader: enable the V8 compile cache (Node 22.1+) before loading the bundle.
// Hooks run on every tool call, so startup time matters.
require("node:module").enableCompileCache?.();
require("../dist/hook.js");

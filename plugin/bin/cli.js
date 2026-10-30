// Loader: enable the V8 compile cache (Node 22.1+) before loading the bundle.
require("node:module").enableCompileCache?.();
require("../dist/cli.js");

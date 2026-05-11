// Entry-point shim. Some PaaS runtimes (e.g. Railway when no explicit start
// command is detected) fall back to `node` / `node .` from /app, which Node
// resolves to `./index.js`. This file forwards to the compiled watcher so the
// fallback path works without extra configuration.
require("./dist/auxidien-index.js");

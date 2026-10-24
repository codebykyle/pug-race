#!/usr/bin/env node
// Runs every suite in order and prints a summary.   node tests/run.js [suite…]
"use strict";
const cp = require("child_process"), path = require("path");
const ALL = ["unit", "names", "hardening", "crowd", "crowd-operator"];
const pick = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
let failed = [];
for (const name of pick) {
  console.log("\n=== " + name + " ===");
  const r = cp.spawnSync("node", [path.join(__dirname, name + ".js")], { stdio: "inherit" });
  if (r.status !== 0) failed.push(name);
}
console.log("\n" + (failed.length ? "FAILED: " + failed.join(", ") : "All " + pick.length + " suites passed."));
process.exit(failed.length ? 1 : 0);

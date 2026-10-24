#!/usr/bin/env node
/*
 * Regenerates the embedded race algorithm in verify.js from index.html.
 *
 *   node make-verify.js
 *
 * Copies every region of index.html between "// @@verify:begin" and
 * "// @@verify:end" verbatim into verify.js. Run it after changing the race
 * code; verify.js then reports the same build fingerprint as the page.
 */
"use strict";
var fs = require("fs"), path = require("path");
var here = __dirname;
var page = fs.readFileSync(path.join(here, "index.html"), "utf8").split("\n");
var regions = [], cur = null;
page.forEach(function (line) {
  if (line.indexOf("// @@verify:begin") === 0) { cur = []; return; }
  if (line.indexOf("// @@verify:end") === 0) { regions.push(cur.join("\n")); cur = null; return; }
  if (cur) cur.push(line);
});
if (cur || regions.length === 0) { console.error("unbalanced or missing @@verify markers in index.html"); process.exit(1); }

var vpath = path.join(here, "verify.js");
var v = fs.readFileSync(vpath, "utf8");
var B = "// @@core:begin\n", E = "// @@core:end\n";
var i = v.indexOf(B), j = v.indexOf(E);
if (i < 0 || j < i) { console.error("verify.js is missing its @@core markers"); process.exit(1); }
v = v.slice(0, i + B.length) + regions.join("\n\n") + "\n" + v.slice(j);
fs.writeFileSync(vpath, v);
console.log("verify.js: embedded " + regions.length + " regions from index.html");

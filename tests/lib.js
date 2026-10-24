/*
 * Shared helpers for the test suites.
 *
 * loadPage() runs index.html's real script in a Node vm with a do-nothing DOM,
 * so the suites exercise the exact code browsers run. startServer() runs a
 * private copy of server.js on a test port with a throwaway host password and
 * --fresh, so the suites never touch a real server or its record.
 */
"use strict";
const fs = require("fs"), vm = require("vm"), crypto = require("crypto"), http = require("http"),
      cp = require("child_process"), os = require("os"), path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGE_CODE = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
const PORT = parseInt(process.env.PUG_TEST_PORT, 10) || 8799;
const PASSWORD = "test-" + crypto.randomBytes(8).toString("hex");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pug-race-test-"));

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await wait(250); }
  return null;
}

// ---- results ----
let pass = 0, failed = 0;
function ok(label, cond, extra) {
  cond ? pass++ : failed++;
  console.log((cond ? "  ✓ " : "  ✗ ") + label + (!cond && extra ? "  — " + extra : ""));
}
function section(title) { console.log(title); }
function done() {
  console.log("\n" + pass + " passed, " + failed + " failed");
  try { fs.rmSync ? fs.rmSync(TMP, { recursive: true, force: true }) : fs.rmdirSync(TMP, { recursive: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}

// ---- HTTP against the test server ----
function httpReq(method, p, body) {
  return new Promise(res => {
    const d = body === undefined ? "" : JSON.stringify(body);
    const r = http.request({ host: "localhost", port: PORT, path: p, method,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) } }, x => {
      let b = ""; x.on("data", c => b += c);
      x.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ status: x.statusCode, j }); });
    });
    r.on("error", () => res({ status: 0, j: null }));
    r.end(d);
  });
}
const getState = () => httpReq("GET", "/api/state").then(r => r.j);
let KEY = "";
async function unlock() { KEY = (await httpReq("POST", "/api/unlock", { password: PASSWORD })).j.key; return KEY; }
/* Operator call: resolves to the JSON body with .status added. */
function post(p, body) {
  return httpReq("POST", p, Object.assign({ key: KEY }, body || {})).then(r => Object.assign({ status: r.status }, r.j || {}));
}

// ---- the test server ----
const stateFile = () => path.join(ROOT, ".server-state-" + PORT + ".json");
function startServer(extra) {
  const s = cp.spawn("node", [path.join(ROOT, "server.js"), String(PORT)].concat(extra || ["--fresh"]),
    { env: Object.assign({}, process.env, { PUG_HOST_PASSWORD: PASSWORD }), stdio: ["ignore", "pipe", "pipe"] });
  s.log = ""; s.stdout.on("data", d => s.log += d); s.stderr.on("data", d => s.log += d);
  return until(() => httpReq("GET", "/api/time").then(r => r.status === 200), 5000).then(() => s);
}
function stopServer(s, { keepState } = {}) {
  return new Promise(r => {
    const fin = () => { if (!keepState) { try { fs.unlinkSync(stateFile()); } catch (e) {} } r(); };
    if (s.exitCode !== null) return fin();
    s.on("exit", fin); s.kill("SIGTERM");
  });
}

// ---- the page ----
/* An EventSource that reconnects, like a browser's. */
class FakeEventSource {
  constructor(p) { this.path = p; this.closed = false; FakeEventSource.all.push(this); this.open(); }
  open() {
    if (this.closed) return;
    const again = () => { if (!this.closed) setTimeout(() => this.open(), 400); };
    this.req = http.get({ host: "localhost", port: PORT, path: this.path }, res => {
      let buf = "";
      res.on("data", c => {
        buf += c; let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const m = buf.slice(0, i); buf = buf.slice(i + 2);
          if (m.startsWith("data: ") && this.onmessage) this.onmessage({ data: m.slice(6) });
        }
      });
      res.on("end", again); res.on("error", again);
    });
    this.req.on("error", again);
  }
  close() { this.closed = true; if (this.req) this.req.destroy(); }
}
FakeEventSource.all = [];
function closeStreams() { FakeEventSource.all.forEach(e => e.close()); }

/*
 * loadPage("/") is the operator page, loadPage("/watch") a viewer.
 * opts.session    preset sessionStorage (e.g. { pugOpKey: KEY } to start signed in)
 * opts.protocol   "file:" to load it as a local file with no server
 * opts.search     location.search (e.g. "?key=…")
 * opts.code       a modified copy of the page script
 * opts.expose     true to make `state` reachable as a global
 */
function loadPage(pathname, opts) {
  opts = opts || {};
  const absorb = () => new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : (k in t ? t[k] : absorb()),
    apply: () => absorb(), set: () => true });
  const els = {};
  function el(id) {
    if (els[id]) return els[id];
    const c = new Set(), L = {};
    const e = { id, value: "", textContent: "", innerHTML: "", style: {}, dataset: {}, checked: false, disabled: false, children: [],
      classList: { add: x => c.add(x), remove: x => c.delete(x), toggle: (x, f) => { (f === undefined ? !c.has(x) : f) ? c.add(x) : c.delete(x); },
                   contains: x => c.has(x) },
      listeners: L, addEventListener: (ev, fn) => { (L[ev] = L[ev] || []).push(fn); },
      fire: ev => { if (ev === "click" && e.onclick) e.onclick({ target: e }); (L[ev] || []).forEach(f => f({ target: e })); },
      getContext: () => absorb(), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
      appendChild: () => {}, remove: () => {}, querySelector: () => absorb(), querySelectorAll: () => [], setAttribute: () => {},
      click: () => { if (e.onclick) e.onclick({ target: e }); }, width: 800, height: 600, clientWidth: 800, clientHeight: 600,
      focus: () => {}, select: () => {} };
    return els[id] = e;
  }
  let skew = 0;
  class FakeDate extends Date { static now() { return Date.now() + skew; } }   // a viewer clock the test can fast-forward
  const store = Object.assign({}, opts.session || {});
  const fetchFn = (p, o) => httpReq((o && o.method) || "GET", p, o && o.body ? JSON.parse(o.body) : undefined)
    .then(r => { if (!r.status) throw new Error("network"); return { status: r.status, ok: r.status < 300, json: () => Promise.resolve(r.j) }; });
  const history = { replaceState: (a, b, u) => { history.last = u; } };
  const ctx = {
    document: { getElementById: el, querySelector: () => el("_q"), querySelectorAll: () => [], createElement: () => el("_c" + Math.random()),
                body: el("_b"), documentElement: el("_r"), addEventListener: () => {}, title: "", fonts: { ready: Promise.resolve() } },
    console, Math, Date: FakeDate, JSON, Promise,
    setTimeout: (f, ms) => ms > 60000 ? 0 : setTimeout(f, ms), clearTimeout: x => clearTimeout(x), setInterval: () => 0,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, performance: { now: () => Date.now() },
    location: { hash: "", search: opts.search || "", protocol: opts.protocol || "http:", pathname, href: "" },
    navigator: {}, history, addEventListener: () => {},
    crypto: { getRandomValues: a => { crypto.randomFillSync(a); return a; } },
    sessionStorage: { getItem: k => store[k] === undefined ? null : store[k], setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    localStorage: { getItem: () => null, setItem: () => {} }, matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    fetch: fetchFn, EventSource: FakeEventSource,
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 800, Image: function () { return absorb(); }, Event: function (t) { this.type = t; },
    TextEncoder, Uint8Array, Uint32Array, Float64Array, Int32Array, Map, Set, Symbol, Array, Object, String, Number, Error };
  ctx.self = ctx.window = ctx.globalThis = ctx;
  vm.createContext(ctx);
  let code = opts.code || PAGE_CODE;
  if (opts.expose) code = code.replace(/^const state =/m, "var state =");
  vm.runInContext(code, ctx);
  const P = s => vm.runInContext(s, ctx);
  /* Runs the Verify tab. rec: a receipt to paste (or undefined to use what the
     page filled in). Returns { v: "ok"|"warn"|"fail", lines: [[level, label]…] }. */
  function verify(rec, saw) {
    if (rec !== undefined) el("receiptIn").value = typeof rec === "string" ? rec : JSON.stringify(rec);
    if (saw !== undefined) el("sawCommit").value = saw;
    P('$("verifyBtn").onclick()');
    const h = el("vChecks").innerHTML;
    const v = h.includes("VERIFICATION FAILED") || h.startsWith('<div class="err">') ? "fail" : h.includes("⚠ RESULTS") ? "warn" : h.includes("✓ VERIFIED") ? "ok" : "?";
    const lines = [...h.matchAll(/<span class="(ok|err|warn)">[✓✗⚠]<\/span> ([^<]*)/g)].map(m => [m[1] === "err" ? "fail" : m[1], m[2]]);
    return { v, lines, why: lines.filter(l => l[0] !== "ok").map(l => (l[0] === "fail" ? "✗ " : "⚠ ") + l[1]).join("; ") };
  }
  return { P, el, history, verify, fire: (id, ev) => el(id).fire(ev), advance: ms => { skew += ms; }, feed: st => P("onLiveState")(st) };
}

// ---- the race maths, from the page itself ----
const T = loadPage("/", { protocol: "file:" });
const M = {};
["sha256", "cleanName", "cleanAudience", "parseNames", "canonRoster", "rosterHash", "commitmentFor", "simulate", "resultsHash",
 "lookalikeGroups", "mixedScript", "crowdSource", "submissionHash", "crowdAudience", "BASE_V", "REFERENCE_BUILD"].forEach(n => { M[n] = T.P(n); });
const rnd = (n = 32) => crypto.randomBytes(n).toString("hex");

/* A self-consistent receipt, so only the check under test can object. */
function makeReceipt({ secret = rnd(), roster, audience, source, len = 45, crowd, commitment }) {
  const canon = M.canonRoster(roster), rh = M.rosterHash(canon);
  const c = commitment || M.commitmentFor(secret, rh, len, source);
  const seed = M.sha256(secret + "|" + audience), order = M.simulate(seed, canon, len * M.BASE_V);
  const r = { format: "pug-race/2", commitment: c, secret, entropySource: source, audienceSeed: audience, finalSeed: seed,
    raceLengthSeconds: len, rosterHash: rh, roster: canon.map(x => x.name), resultsHash: M.resultsHash(order),
    top10: order.slice(0, 10).map(x => ({ place: x.place, name: x.name, time: +x.time.toFixed(4), skin: x.skin })) };
  if (crowd) r.crowd = crowd;
  return r;
}

/* Runs verify.js (or another copy of it) on a receipt. */
function verifyJs(rec, saw, script) {
  const f = path.join(TMP, "receipt-" + rnd(4) + ".json");
  fs.writeFileSync(f, typeof rec === "string" ? rec : JSON.stringify(rec));
  const r = cp.spawnSync("node", [script || path.join(ROOT, "verify.js"), f].concat(saw ? ["--saw", saw] : []), { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

module.exports = { ROOT, PAGE_CODE, PORT, PASSWORD, TMP, wait, until, ok, section, done, httpReq, getState, unlock, post,
  startServer, stopServer, loadPage, closeStreams, M, rnd, makeReceipt, verifyJs, get KEY() { return KEY; } };

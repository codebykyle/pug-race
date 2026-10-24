#!/usr/bin/env node
/* ---------------------------------------------------------------------
 * Pug Race watch server
 *
 * Participants open /watch and see the race in lockstep with the operator.
 *
 * This does NOT stream the race. The race is a pure function of its seed,
 * so every viewer recomputes it locally from ~200 bytes of parameters and
 * a shared start time. Bandwidth is the same for 5 viewers or 5,000, and
 * the server never simulates anything.
 *
 * The server is also not trusted. If it altered the seed or the roster,
 * the published receipt would fail verification on any clean machine.
 * It distributes parameters; it does not decide outcomes.
 *
 *   node server.js [port] [--fresh]     (--fresh: ignore the saved state file)
 * --------------------------------------------------------------------- */
"use strict";

var http = require("http");
var fs   = require("fs");
var path = require("path");
var crypto = require("crypto");

var PORT = parseInt(process.argv[2], 10) || 8731;
var ROOT = __dirname;
var COUNTDOWN_MS = 30000;         // lead time so late joiners can get on the watch link
// A real race may only start once its commitment has been public this long.
// An operator who re-commits after hearing the audience value has to leave the
// replacement on every viewer's screen (with a "commitment replaced" alert)
// for at least this long first.
var MIN_LEAD_MS = 20000;

// Only a holder of this key may push a race. Without it, anyone who can
// reach the page — which on a public tunnel is anyone at all — could
// hijack the display.
var OPERATOR_KEY = crypto.randomBytes(16).toString("hex");

// Key file is per-port, so two instances in the same directory never clobber
// each other's key. (.operator-key stays the name for the default port so the
// helper scripts keep working unchanged.)
var KEY_FILE = path.join(ROOT, PORT === 8731 ? ".operator-key" : ".operator-key-" + PORT);
try {
  fs.writeFileSync(KEY_FILE, OPERATOR_KEY + "\n", { mode: 0o600 });
  fs.chmodSync(KEY_FILE, 0o600);
} catch (e) {
  console.error("  (could not write " + path.basename(KEY_FILE) + ": " + e.message + ")");
}
function cleanupKey() {
  // Only remove the file if it still holds OUR key — never delete a file that
  // another instance may have (re)written.
  try {
    if (fs.readFileSync(KEY_FILE, "utf8").trim() === OPERATOR_KEY) fs.unlinkSync(KEY_FILE);
  } catch (e) {}
}
process.on("exit", cleanupKey);
["SIGINT", "SIGTERM", "SIGHUP"].forEach(function (sig) {
  process.on(sig, function () { cleanupKey(); process.exit(0); });
});

// ---- host password ---------------------------------------------------
// The operator key above is a long random token, awkward to type and unsafe
// to leave in a screen-shared URL. The host password is the human-facing
// gate: whoever can prove it (POST /api/unlock) is handed the key and may
// run races. Everyone else can only watch.
//
// Set your own memorable password with the PUG_HOST_PASSWORD env var or a
// .host-password file (per-port: .host-password-<port>). If neither exists we
// generate one, persist it, and print it — so the gate is ON by default and
// stays stable across restarts. Unlike the key, this file is NOT deleted on
// exit; it is a credential you chose to keep.
var HOST_PW_FILE = path.join(ROOT, PORT === 8731 ? ".host-password" : ".host-password-" + PORT);
var HOST_PW_SOURCE = "env PUG_HOST_PASSWORD";
var HOST_PASSWORD = process.env.PUG_HOST_PASSWORD || "";
if (!HOST_PASSWORD) {
  try { HOST_PASSWORD = fs.readFileSync(HOST_PW_FILE, "utf8").trim(); HOST_PW_SOURCE = path.basename(HOST_PW_FILE); } catch (e) {}
}
var HOST_PW_GENERATED = false;
if (!HOST_PASSWORD) {
  HOST_PASSWORD = crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
  HOST_PW_GENERATED = true;
  HOST_PW_SOURCE = path.basename(HOST_PW_FILE) + " (generated)";
  try {
    fs.writeFileSync(HOST_PW_FILE, HOST_PASSWORD + "\n", { mode: 0o600 });
    fs.chmodSync(HOST_PW_FILE, 0o600);
  } catch (e) {
    console.error("  (could not write " + path.basename(HOST_PW_FILE) + ": " + e.message + ")");
  }
}

// Constant-time password comparison — never leak length or content by timing.
function pwEquals(given) {
  var a = Buffer.from(String(given), "utf8");
  var b = Buffer.from(HOST_PASSWORD, "utf8");
  if (a.length !== b.length) { crypto.timingSafeEqual(a, a); return false; }
  return crypto.timingSafeEqual(a, b);
}

// Per-IP brute-force backoff for the unlock endpoint.
var unlockFails = {};   // ip -> { n, until }

var lobby = { commitment: null, publishedAt: null, rosterHash: null, entropySource: null, racerCount: 0, lenSec: 45, note: null };
// Every commitment ever published, including withdrawn ones, so a quietly
// replaced or re-run race is visible to anyone (snapshot + /api/commitments).
var commitLog = [];               // { commitment, publishedAt, withdrawnAt, raceId, rosterHash, entropySource, racerCount, lenSec }
var COMMIT_LOG_MAX = 500;
function logEntry(c) {
  for (var i = commitLog.length - 1; i >= 0; i--) if (commitLog[i].commitment === c) return commitLog[i];
  return null;
}
/* Commitments withdrawn without being raced since the previous real race. */
/* Real races replaced or cleared before they could have finished, since the
   last real race was announced. Cutting a race short and running another is
   how an operator would discard a result they didn't like, so the next race
   carries this list to every viewer and into its receipt. */
var pendingAbandoned = [];
function retireRace(now) {
  if (!race || race.practice || race.retired) return;
  race.retired = true;
  if (now < race.startAt + race.lenSec * 1000) {
    pendingAbandoned.push({ raceId: race.id, commitment: race.commitment, announcedAt: race.announcedAt,
                            startAt: race.startAt, cutAt: now });
    var e = race.commitment && logEntry(race.commitment);
    if (e) e.abandonedAt = now;
    console.log("  race " + race.id + " was cut short before it finished — logged as abandoned");
  }
}

/* The same hashing as the page's rosterHash/commitmentFor (sorted by UTF-16
   code unit, repeats keyed "#1", "#2"…), so the server can refuse a race that
   doesn't match its own commitment before broadcasting it. */
function sha256hex(s) { return crypto.createHash("sha256").update(s, "utf8").digest("hex"); }
function rosterHashOf(names) {
  var sorted = names.slice().sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
  var seen = {}, keys = [];
  sorted.forEach(function (n) {
    var k = seen[n] || 0; seen[n] = k + 1;
    keys.push(k === 0 ? n : n + "#" + k);
  });
  return sha256hex(keys.join("\n"));
}
var HEX64 = /^[0-9a-f]{64}$/;

/* The viewer-submission rules (cleaning, hashing, combining) are the page's own
   functions, loaded from the @@verify regions of index.html, so the server can
   never disagree with what viewers' pages and verify.js check. */
var CORE = (function () {
  var lines = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").split("\n"), regions = [], cur = null;
  lines.forEach(function (l) {
    if (l.indexOf("// @@verify:begin") === 0) { cur = []; return; }
    if (l.indexOf("// @@verify:end") === 0) { regions.push(cur.join("\n")); cur = null; return; }
    if (cur) cur.push(l);
  });
  var C = require("vm").createContext({});
  require("vm").runInContext('"use strict";\n' + regions.join("\n") +
    "\nthis.CORE={cleanAudience:cleanAudience,crowdSource:crowdSource,submissionHash:submissionHash,crowdAudience:crowdAudience};", C);
  return C.CORE;
})();
var CROWD_SOURCE = CORE.crowdSource();

// ---- viewer submissions -----------------------------------------------
// Phases: "open" (viewers send sealed hashes) -> "reveal" (the hash list is
// frozen; pages send their text) -> "closed" (audience value fixed). The
// operator only opens and seals. The reveal ends by itself, when every sealed
// hash is revealed or REVEAL_MS passes, so nobody can stop it at a moment
// that suits them. One collection per commitment.
var CROWD_MAX = 1000, REVEAL_MS = 15000;
var crowd = null;                 // { commitment, phase, sealed:{hash:at}, frozen:[], revealed:{hash:{salt,text}}, openedAt, sealedAt, closedAt, audience }
var crowdUsed = {};               // commitments that have had a collection
var crowdTimer = null, crowdBcastTimer = null;
// Per-address token bucket. Generous, because a whole venue on one Wi-Fi
// usually shares an address; it only has to stop one machine flooding the
// list. (It does nothing for fairness: whoever runs the server can submit
// whatever it likes, which is why reveals are counted and checked.)
var SUBMIT_BURST = 60, SUBMIT_PER_SEC = 10;
var submitBucket = {};            // ip -> { tokens, at }
function takeSubmitToken(ip, now) {
  var b = submitBucket[ip] || { tokens: SUBMIT_BURST, at: now };
  b.tokens = Math.min(SUBMIT_BURST, b.tokens + (now - b.at) / 1000 * SUBMIT_PER_SEC); b.at = now;
  submitBucket[ip] = b;
  if (b.tokens < 1) return false;
  b.tokens -= 1; return true;
}
function crowdRecord() {          // the canonical record that goes into the race and receipt
  var rev = Object.keys(crowd.revealed).sort().map(function (h) {
    return { hash: h, salt: crowd.revealed[h].salt, text: crowd.revealed[h].text };
  });
  return { sealed: crowd.frozen, revealed: rev, openedAt: crowd.openedAt, sealedAt: crowd.sealedAt, closedAt: crowd.closedAt };
}
function crowdPublic() {          // small: the full lists only once they're frozen / final
  if (!crowd) return null;
  var o = { commitment: crowd.commitment, phase: crowd.phase, count: Object.keys(crowd.sealed).length,
            revealedCount: Object.keys(crowd.revealed).length, openedAt: crowd.openedAt, sealedAt: crowd.sealedAt,
            closedAt: crowd.closedAt, revealMs: REVEAL_MS };
  if (crowd.phase !== "open") o.sealed = crowd.frozen;
  if (crowd.phase === "closed") { o.record = crowdRecord(); o.audience = crowd.audience; o.problems = crowd.problems; }
  return o;
}
function crowdBroadcast(now) {
  if (now) { clearTimeout(crowdBcastTimer); crowdBcastTimer = null; broadcast({ type: "crowd", crowd: crowdPublic() }); return; }
  if (crowdBcastTimer) return;    // counts while open: at most twice a second
  crowdBcastTimer = setTimeout(function () { crowdBcastTimer = null; broadcast({ type: "crowd", crowd: crowdPublic() }); }, 500);
}
function crowdClose() {
  if (!crowd || crowd.phase !== "reveal") return;
  clearTimeout(crowdTimer); crowdTimer = null;
  crowd.phase = "closed"; crowd.closedAt = Date.now();
  var r = CORE.crowdAudience(crowd.commitment, crowdRecord());
  crowd.audience = r.audience; crowd.problems = r.problems;
  console.log("  submissions closed: " + Object.keys(crowd.revealed).length + " revealed of " + crowd.frozen.length);
  crowdBroadcast(true);
}
function clientIp(req) { return (req.socket && req.socket.remoteAddress) || "?"; }

function withdrawnSinceLastRace(beforeIdx) {
  var out = [];
  for (var i = (beforeIdx == null ? commitLog.length : beforeIdx) - 1; i >= 0; i--) {
    if (commitLog[i].raceId) break;
    if (commitLog[i].withdrawnAt) out.unshift(commitLog[i]);
  }
  return out;
}
var race  = null;                 // the announced race, once started
var receipt = null;               // published after the reveal
var clients = [];                 // live SSE connections

// ---- saved state -----------------------------------------------------
// The commitment log, the lobby, the current race and receipt, and any
// submission collection are written to a file, so a crash or restart mid-event
// doesn't wipe the record viewers rely on (withdrawn and cut-short races, one
// collection per commitment). Start with --fresh to ignore it.
var STATE_FILE = path.join(ROOT, PORT === 8731 ? ".server-state.json" : ".server-state-" + PORT + ".json");
var saveTimer = null;
function stateJson() {
  return JSON.stringify({ version: 1, savedAt: Date.now(), lobby: lobby, commitLog: commitLog,
    pendingAbandoned: pendingAbandoned, race: race, receipt: receipt, crowd: crowd, crowdUsed: crowdUsed });
}
function flushState() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    fs.writeFileSync(STATE_FILE + ".tmp", stateJson(), { mode: 0o600 });
    fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
  } catch (e) { console.error("  (could not save " + path.basename(STATE_FILE) + ": " + e.message + ")"); }
}
function saveState() { if (!saveTimer) saveTimer = setTimeout(flushState, 250); }
process.on("exit", function () { if (saveTimer) flushState(); });
(function loadState() {
  if (process.argv.indexOf("--fresh") >= 0) return;
  var s;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return; }
  if (!s || s.version !== 1) return;
  lobby = s.lobby || lobby; commitLog = s.commitLog || []; pendingAbandoned = s.pendingAbandoned || [];
  race = s.race || null; receipt = s.receipt || null; crowd = s.crowd || null; crowdUsed = s.crowdUsed || {};
  // a reveal that was running when the server stopped still ends on schedule
  if (crowd && crowd.phase === "reveal") {
    crowdTimer = setTimeout(crowdClose, Math.max(0, crowd.sealedAt + REVEAL_MS - Date.now()));
  }
  console.log("  restored " + commitLog.length + " logged commitment(s) from " + path.basename(STATE_FILE) +
              (crowd ? ", submissions " + crowd.phase : "") + "  (start with --fresh to ignore it)");
})();

function send(res, code, type, body, extra) {
  var h = { "Content-Type": type, "Cache-Control": "no-store" };
  if (extra) for (var k in extra) h[k] = extra[k];
  res.writeHead(code, h);
  res.end(body);
}
function json(res, code, obj) {
  send(res, code, "application/json", JSON.stringify(obj));
}
function broadcast(obj) {
  saveState();                    // every change to the record is broadcast, so save alongside
  var payload = "data: " + JSON.stringify(obj) + "\n\n";
  for (var i = clients.length - 1; i >= 0; i--) {
    try { clients[i].write(payload); }
    catch (e) { clients.splice(i, 1); }
  }
}
function snapshot() {
  return { type: "state", now: Date.now(), minLeadMs: MIN_LEAD_MS, lobby: lobby, race: race, receipt: receipt,
           commitLog: commitLog.slice(-50), crowd: crowdPublic() };
}
function readBody(req, cb) {
  var chunks = [], total = 0;
  req.on("data", function (c) {
    total += c.length;
    if (total > 12 * 1024 * 1024) { req.destroy(); return; }   // 10k names fits easily
    chunks.push(c);
  });
  req.on("end", function () {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch (e) { cb(e); }
  });
  req.on("error", function (e) { cb(e); });
}
function authed(req, body) {
  var key = (body && body.key) || "";
  return key === OPERATOR_KEY;
}

var server = http.createServer(function (req, res) {
  var u = req.url.split("?")[0];

  // ---- static ----
  if (req.method === "GET" && (u === "/" || u === "/index.html" || u === "/watch")) {
    fs.readFile(path.join(ROOT, "index.html"), function (err, buf) {
      if (err) return send(res, 500, "text/plain", "index.html not found");
      send(res, 200, "text/html; charset=utf-8", buf);
    });
    return;
  }
  if (req.method === "GET" && u === "/verify.js") {
    fs.readFile(path.join(ROOT, "verify.js"), function (err, buf) {
      if (err) return send(res, 404, "text/plain", "not found");
      send(res, 200, "text/plain; charset=utf-8", buf, { "Content-Disposition": "inline; filename=\"verify.js\"" });
    });
    return;
  }
  if (req.method === "GET" && u === "/README.md") {
    fs.readFile(path.join(ROOT, "README.md"), function (err, buf) {
      if (err) return send(res, 404, "text/plain", "not found");
      send(res, 200, "text/plain; charset=utf-8", buf);
    });
    return;
  }

  // ---- clock sync: viewers align to the server's clock, not their own ----
  if (req.method === "GET" && u === "/api/time") {
    return json(res, 200, { now: Date.now() });
  }
  if (req.method === "GET" && u === "/api/state") {
    return json(res, 200, snapshot());
  }
  if (req.method === "GET" && u === "/api/commitments") {
    return json(res, 200, { now: Date.now(), minLeadMs: MIN_LEAD_MS, commitments: commitLog });
  }

  // ---- live channel ----
  if (req.method === "GET" && u === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 2000\n\n");
    res.write("data: " + JSON.stringify(snapshot()) + "\n\n");
    clients.push(res);
    var ping = setInterval(function () {
      try { res.write(": ping\n\n"); } catch (e) {}
    }, 20000);
    req.on("close", function () {
      clearInterval(ping);
      var i = clients.indexOf(res);
      if (i >= 0) clients.splice(i, 1);
    });
    return;
  }

  // ---- unlock: trade the host password for the operator key ----
  if (req.method === "POST" && u === "/api/unlock") {
    return readBody(req, function (err, body) {
      if (err) return json(res, 400, { error: "bad json" });
      var ip = (req.socket && req.socket.remoteAddress) || "?";
      var rec = unlockFails[ip] || { n: 0, until: 0 };
      var now = Date.now();
      if (now < rec.until) {
        return json(res, 429, { error: "too many attempts, wait a moment" });
      }
      if (pwEquals(body && body.password)) {
        delete unlockFails[ip];
        return json(res, 200, { ok: true, key: OPERATOR_KEY });
      }
      // Wrong: count it, back off after a few, and delay the reply a little so
      // the endpoint can't be hammered quickly.
      rec.n += 1;
      if (rec.n >= 5) rec.until = now + Math.min(30000, 1000 * Math.pow(2, rec.n - 5));
      unlockFails[ip] = rec;
      return setTimeout(function () {
        json(res, 401, { ok: false, error: "wrong password" });
      }, 350);
    });
  }

  // ---- operator pushes lobby info (commitment shown before the race) ----
  if (req.method === "POST" && u === "/api/lobby") {
    return readBody(req, function (err, body) {
      if (err) return json(res, 400, { error: "bad json" });
      if (!authed(req, body)) return json(res, 403, { error: "bad key" });
      var now = Date.now(), c = body.commitment || null;
      var publishedAt = lobby.publishedAt;
      if (c !== lobby.commitment) {
        // the commitment on screen changed: withdraw the old one unless it was raced
        var prev = lobby.commitment && logEntry(lobby.commitment);
        if (prev && !prev.raceId && !prev.withdrawnAt) prev.withdrawnAt = now;
        publishedAt = c ? now : null;
        if (c) {
          commitLog.push({ commitment: c, publishedAt: now, withdrawnAt: null, raceId: null,
                           rosterHash: body.rosterHash || null, entropySource: body.entropySource || null,
                           racerCount: body.racerCount || 0, lenSec: body.lenSec || 45 });
          if (commitLog.length > COMMIT_LOG_MAX) commitLog.splice(0, commitLog.length - COMMIT_LOG_MAX);
          console.log("  commitment published " + c.slice(0, 16) + "…");
        }
      }
      lobby = {
        commitment: c,
        publishedAt: publishedAt,
        rosterHash: body.rosterHash || null,
        entropySource: body.entropySource || null,
        roster: Array.isArray(body.roster) && body.roster.length <= 10000 &&
                body.roster.every(function (n) { return typeof n === "string"; }) ? body.roster : null,
        racerCount: body.racerCount || 0,
        lenSec: body.lenSec || 45,
        note: body.note || null
      };
      if (body.reset) { retireRace(now); race = null; receipt = null; }
      // A collection belongs to one commitment; replacing it ends the collection.
      if (crowd && crowd.commitment !== c) { clearTimeout(crowdTimer); crowdTimer = null; crowd = null; }
      broadcast(snapshot());
      json(res, 200, { ok: true });
    });
  }

  // ---- operator starts the race ----
  if (req.method === "POST" && u === "/api/race") {
    return readBody(req, function (err, body) {
      if (err) return json(res, 400, { error: "bad json" });
      if (!authed(req, body)) return json(res, 403, { error: "bad key" });
      if (!body.seed || !Array.isArray(body.roster) || !body.lenSec) {
        return json(res, 400, { error: "need seed, roster, lenSec" });
      }
      // A real race may only run under the commitment viewers were already
      // shown in the lobby — never one first revealed at the start line.
      var entry = null, now = Date.now();
      if (!body.practice) {
        if (!body.commitment || body.commitment !== lobby.commitment) {
          return json(res, 409, { error: "commitment was not published in the lobby before the race" });
        }
        entry = logEntry(body.commitment);
        if (entry && entry.raceId) {
          return json(res, 409, { error: "this commitment has already been raced — one commitment, one race" });
        }
        var lead = now - lobby.publishedAt;
        if (lead < MIN_LEAD_MS) {
          return json(res, 409, { error: "commitment has only been public for " + Math.floor(lead / 1000) +
            "s; it must be visible for " + (MIN_LEAD_MS / 1000) + "s before a race",
            retryInMs: MIN_LEAD_MS - lead });
        }
        // The announcement must prove itself: the revealed secret, this roster,
        // length and entropy source must reproduce the published commitment,
        // and the seed must come from that secret and the audience value.
        if (typeof body.secret !== "string" || !HEX64.test(body.secret) || typeof body.entropySource !== "string" ||
            typeof body.audienceSeed !== "string" || !body.roster.every(function (n) { return typeof n === "string"; })) {
          return json(res, 400, { error: "a real race needs its secret, entropy source and audience value" });
        }
        var rh = rosterHashOf(body.roster);
        if (rh !== lobby.rosterHash ||
            sha256hex("pug-race/2|" + body.secret + "|" + rh + "|" + body.lenSec + "|" + body.entropySource) !== body.commitment ||
            sha256hex(body.secret + "|" + body.audienceSeed) !== body.seed) {
          return json(res, 409, { error: "race does not match its published commitment (secret, roster, length, source or seed)" });
        }
        // Sealed for viewer submissions: the audience value must be exactly the
        // finished collection for this commitment, never one the operator typed.
        if (body.entropySource === CROWD_SOURCE) {
          if (!crowd || crowd.commitment !== body.commitment || crowd.phase !== "closed") {
            return json(res, 409, { error: "viewer submissions for this commitment haven't finished yet" });
          }
          if (crowd.problems.length) return json(res, 409, { error: "viewer submissions can't be used: " + crowd.problems.join("; ") });
          if (body.audienceSeed !== crowd.audience) {
            return json(res, 409, { error: "audience value is not the combined viewer submissions" });
          }
        }
      }
      retireRace(now);
      receipt = null;
      race = {
        id: crypto.randomBytes(6).toString("hex"),
        seed: body.seed,
        roster: body.roster,
        lenSec: body.lenSec,
        commitment: body.commitment || null,
        audienceSeed: body.audienceSeed || null,
        secret: typeof body.secret === "string" ? body.secret : null,
        entropySource: typeof body.entropySource === "string" ? body.entropySource : null,
        practice: !!body.practice,
        commitPublishedAt: body.practice ? null : lobby.publishedAt,
        announcedAt: now,
        startAt: now + COUNTDOWN_MS   // server clock is the authority
      };
      if (!race.practice && race.entropySource === CROWD_SOURCE) race.crowd = crowdRecord();
      if (entry) {
        race.withdrawnBefore = withdrawnSinceLastRace(commitLog.indexOf(entry)).map(function (e) {
          return { commitment: e.commitment, publishedAt: e.publishedAt, withdrawnAt: e.withdrawnAt };
        });
        entry.raceId = race.id;
        race.abandonedBefore = pendingAbandoned;
        pendingAbandoned = [];
      }
      lobby.racerCount = body.roster.length;
      lobby.lenSec = body.lenSec;
      broadcast(snapshot());
      console.log("  race " + race.id + " announced: " + body.roster.length +
                  " racers, " + body.lenSec + "s, starts in " + (COUNTDOWN_MS / 1000) + "s");
      json(res, 200, { ok: true, startAt: race.startAt, now: Date.now(), id: race.id });
    });
  }

  // ---- viewer submissions: operator opens and seals ----
  if (req.method === "POST" && (u === "/api/crowd/open" || u === "/api/crowd/seal")) {
    return readBody(req, function (err, body) {
      if (err) return json(res, 400, { error: "bad json" });
      if (!authed(req, body)) return json(res, 403, { error: "bad key" });
      var now = Date.now();
      if (u === "/api/crowd/open") {
        if (!lobby.commitment || lobby.entropySource !== CROWD_SOURCE) {
          return json(res, 409, { error: "the commitment in the lobby isn't sealed for viewer submissions" });
        }
        if (crowdUsed[lobby.commitment]) {
          return json(res, 409, { error: "submissions were already collected for this commitment — one collection per commitment" });
        }
        var le = logEntry(lobby.commitment);
        if (le && le.raceId) return json(res, 409, { error: "this commitment has already been raced" });
        crowdUsed[lobby.commitment] = true;
        submitBucket = {};
        crowd = { commitment: lobby.commitment, phase: "open", sealed: {}, frozen: [], revealed: {},
                  openedAt: now, sealedAt: null, closedAt: null, audience: null, problems: [] };
        console.log("  submissions open for " + lobby.commitment.slice(0, 16) + "…");
      } else {
        if (!crowd || crowd.phase !== "open") return json(res, 409, { error: "submissions aren't open" });
        if (!Object.keys(crowd.sealed).length) return json(res, 409, { error: "no submissions yet — wait for at least one" });
        crowd.phase = "reveal"; crowd.sealedAt = now;
        crowd.frozen = Object.keys(crowd.sealed).sort();
        crowdTimer = setTimeout(crowdClose, REVEAL_MS);
        console.log("  submissions sealed: " + crowd.frozen.length + "; revealing");
      }
      crowdBroadcast(true);
      json(res, 200, { ok: true, crowd: crowdPublic() });
    });
  }

  // ---- viewer submissions: anyone on the watch page ----
  if (req.method === "POST" && (u === "/api/crowd/submit" || u === "/api/crowd/reveal")) {
    return readBody(req, function (err, body) {
      if (err || !body) return json(res, 400, { error: "bad json" });
      if (!crowd || body.commitment !== crowd.commitment) return json(res, 409, { error: "not collecting for that commitment" });
      var h = body.hash;
      if (typeof h !== "string" || !HEX64.test(h)) return json(res, 400, { error: "bad hash" });
      if (u === "/api/crowd/submit") {
        if (crowd.phase !== "open") return json(res, 409, { error: "submissions are closed" });
        var ip = clientIp(req), now = Date.now();
        if (!takeSubmitToken(ip, now)) return json(res, 429, { error: "busy — try again in a moment" });
        if (crowd.sealed[h]) return json(res, 200, { ok: true });
        if (Object.keys(crowd.sealed).length >= CROWD_MAX) return json(res, 409, { error: "submissions are full" });
        crowd.sealed[h] = now;
        crowdBroadcast(false);
        return json(res, 200, { ok: true });
      }
      if (crowd.revealed[h]) return json(res, 200, { ok: true });
      if (crowd.phase !== "reveal") return json(res, 409, { error: "not revealing now" });
      if (crowd.frozen.indexOf(h) < 0) return json(res, 409, { error: "that hash wasn't sealed in time" });
      // Same rules as every verifier: a bad reveal is refused here, so it can
      // only ever count as "not revealed", never break the race.
      if (typeof body.salt !== "string" || !/^[0-9a-f]{32}$/.test(body.salt) || typeof body.text !== "string" ||
          !body.text || body.text.length > 80 || CORE.cleanAudience(body.text) !== body.text ||
          CORE.submissionHash(crowd.commitment, body.salt, body.text) !== h) {
        return json(res, 400, { error: "reveal doesn't match its sealed hash" });
      }
      crowd.revealed[h] = { salt: body.salt, text: body.text };
      if (Object.keys(crowd.revealed).length === crowd.frozen.length) crowdClose();
      else crowdBroadcast(false);
      json(res, 200, { ok: true });
    });
  }

  // ---- operator publishes the receipt after the reveal ----
  if (req.method === "POST" && u === "/api/receipt") {
    return readBody(req, function (err, body) {
      if (err) return json(res, 400, { error: "bad json" });
      if (!authed(req, body)) return json(res, 403, { error: "bad key" });
      var rc = body.receipt;
      // The receipt must describe the race viewers were actually shown.
      if (!rc || !race || race.practice || rc.commitment !== race.commitment || rc.finalSeed !== race.seed ||
          rc.raceLengthSeconds !== race.lenSec || JSON.stringify(rc.roster) !== JSON.stringify(race.roster) ||
          JSON.stringify(rc.crowd || null) !== JSON.stringify(race.crowd || null)) {
        return json(res, 409, { error: "receipt does not match the race that was announced to viewers" });
      }
      // Attach the server's own timeline so later verifiers see it too.
      // (The operator runs this server, so this is supporting evidence; each
      // viewer's own device record is the stronger check.)
      rc.server = { raceId: race.id, commitmentPublishedAt: race.commitPublishedAt,
                    raceAnnouncedAt: race.announcedAt, minLeadMs: MIN_LEAD_MS,
                    withdrawnBefore: race.withdrawnBefore || [], abandonedBefore: race.abandonedBefore || [] };
      receipt = rc;
      broadcast(snapshot());
      console.log("  receipt published");
      json(res, 200, { ok: true });
    });
  }

  send(res, 404, "text/plain", "not found");
});

server.listen(PORT, "0.0.0.0", function () {
  var nets = require("os").networkInterfaces();
  var lan = null;
  for (var name in nets) {
    (nets[name] || []).forEach(function (n) {
      if (n.family === "IPv4" && !n.internal && !lan) lan = n.address;
    });
  }
  var base = "http://" + (lan || "localhost") + ":" + PORT;
  console.log("");
  console.log("  PUG RACE watch server");
  console.log("  " + new Array(46).join("-"));
  console.log("  WATCH LINK (give this to participants):");
  console.log("      " + base + "/watch");
  console.log("");
  console.log("  HOST PAGE (open this yourself, then enter the host password");
  console.log("  to run races — nothing secret in the URL, safe to screen-share):");
  console.log("      http://localhost:" + PORT + "/");
  if (HOST_PW_GENERATED) {
    console.log("      Host password: " + HOST_PASSWORD + "   (auto-generated, saved to " + path.basename(HOST_PW_FILE) + ")");
    console.log("      Set your own: put it in " + path.basename(HOST_PW_FILE) + " or PUG_HOST_PASSWORD, then restart.");
  } else {
    console.log("      Host password: set (from " + HOST_PW_SOURCE + ")");
  }
  console.log("");
  console.log("  Operator key for scripts/API only (never put it in a URL):");
  console.log("      " + path.basename(KEY_FILE));
  console.log("");
  console.log("  Viewers sync to this machine's clock, so every screen starts");
  console.log("  together. Late joiners snap to the correct moment.");
  console.log("");
  console.log("  Extension-free operator window:  ./launch-clean.sh --live");
  console.log("  Public link:                     ./share-public.sh");
  console.log("  " + new Array(46).join("-"));
  console.log("");
});

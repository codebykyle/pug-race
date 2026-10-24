#!/usr/bin/env node
/*
 * verify.js — check a pug race receipt without trusting the operator's page.
 *
 *   node verify.js receipt.json [--saw <commitment>] [--standings N]
 *
 *   --saw         the commitment you saw before the race (photo, chat, stream).
 *                 Without it a receipt can only prove it agrees with itself.
 *   --standings   print the top N of the recomputed standings (default 10).
 *
 * Exit code: 0 verified, 2 results reproduce but with warnings, 1 failed.
 *
 * Needs only Node (12+), no packages, no network. The race algorithm below is
 * copied verbatim from index.html, and the build fingerprint printed at the end
 * is computed exactly as the page computes its own — if they match, this
 * script runs the same code. It also cross-checks the embedded SHA-256 against
 * Node's built-in one, so you aren't trusting that either.
 *
 * Read it: everything that decides the result is in the block marked
 * "@@core" below. Nothing else feeds the race.
 */
"use strict";
var fs = require("fs"), vm = require("vm"), crypto = require("crypto");

// ---- arguments ----
var args = process.argv.slice(2), file = null, saw = "", topN = 10;
for (var a = 0; a < args.length; a++) {
  if (args[a] === "--saw") saw = String(args[++a] || "").trim().toLowerCase();
  else if (args[a] === "--standings") topN = Math.max(0, parseInt(args[++a], 10) || 0);
  else if (args[a] === "-h" || args[a] === "--help") file = null, a = args.length;
  else file = args[a];
}
if (!file) {
  console.log("usage: node verify.js receipt.json [--saw <commitment>] [--standings N]");
  process.exit(1);
}

// ---- load the race algorithm (the @@core block of this very file) ----
// It runs in its own context, as a plain script, exactly as in the browser:
// top-level functions become globals, so the fingerprint resolves them by name.
var self = fs.readFileSync(__filename, "utf8");
var core = self.slice(self.indexOf("// @@core:begin\n") + 16, self.indexOf("// @@core:end\n"));
var C = vm.createContext({ globalThis: null });
C.globalThis = C;
vm.runInContext('"use strict";\n' + core, C, { filename: "verify.js (core)" });
var X = function (name) { return vm.runInContext(name, C); };
var sha256 = X("sha256"), cleanName = X("cleanName"), cleanAudience = X("cleanAudience"), canonRoster = X("canonRoster"), rosterHash = X("rosterHash"),
    commitmentFor = X("commitmentFor"), simulate = X("simulate"), resultsHash = X("resultsHash"),
    lookalikeGroups = X("lookalikeGroups"), mixedScript = X("mixedScript"), codeFingerprint = X("codeFingerprint"),
    BASE_V = X("BASE_V"), crowdSource = X("crowdSource"), crowdAudience = X("crowdAudience");
var MIN_LEAD_MS = 20000;

// ---- report ----
var checks = [];
function check(label, level, detail) { checks.push([label, level, detail]); }
function die(msg) { console.log("✗ " + msg); console.log("\n✗ VERIFICATION FAILED — do not trust this race"); process.exit(1); }
function shown(n) { return JSON.stringify(n).replace(/[^\x20-\x7e]/g, function (c) { return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"); }); }
function secs(ms) { return (ms / 1000).toFixed(1) + "s"; }

// 0. is the embedded SHA-256 honest?
var probes = ["", "abc", "pug-race/2|ü|🐶", self.slice(0, 5000)];
var shaOk = probes.every(function (p) { return sha256(p) === crypto.createHash("sha256").update(p, "utf8").digest("hex"); });
if (!shaOk) die("the embedded SHA-256 disagrees with Node's crypto module — this copy of verify.js has been altered");

// 1. the receipt, strictly
var R;
try { R = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { die("could not read " + file + " as JSON: " + e.message); }
if (!R || typeof R !== "object" || Array.isArray(R)) die("a receipt is a JSON object");
var legacy = R.format !== "pug-race/2";
var need = ["commitment", "secret", "audienceSeed", "finalSeed", "raceLengthSeconds", "roster", "rosterHash", "resultsHash", "top10"]
  .concat(legacy ? [] : ["entropySource"]);
var missing = need.filter(function (k) { return !(k in R) || R[k] === null || R[k] === ""; });
if (missing.length) die("receipt is missing: " + missing.join(", ") + " — every field is required");
var HEX64 = /^[0-9a-f]{64}$/, bad = [];
["commitment", "secret", "finalSeed", "rosterHash", "resultsHash"].forEach(function (k) {
  if (typeof R[k] !== "string" || !HEX64.test(R[k])) bad.push(k + " (64 lowercase hex)");
});
if (typeof R.audienceSeed !== "string") bad.push("audienceSeed (text)");
if (!legacy && typeof R.entropySource !== "string") bad.push("entropySource (text)");
if (!Number.isInteger(R.raceLengthSeconds) || R.raceLengthSeconds < 10 || R.raceLengthSeconds > 600) bad.push("raceLengthSeconds (10–600)");
if (!Array.isArray(R.roster) || R.roster.length < 2 || R.roster.length > 10000 ||
    !R.roster.every(function (n) { return typeof n === "string"; })) bad.push("roster (2–10,000 names)");
if (!Array.isArray(R.top10) || !R.top10.length) bad.push("top10 (non-empty list)");
if (bad.length) die("malformed fields: " + bad.join("; "));

var canon = canonRoster(R.roster), rh = rosterHash(canon);

// 2. commitment
if (legacy) {
  var c1 = sha256(R.secret);
  check("Published fingerprint is a commitment to the revealed secret", c1 === R.commitment, "SHA-256(secret) = " + c1);
  check("Roster and race length were sealed into the commitment", "warn",
    "legacy receipt (format " + (R.format || "unknown") + "): only the secret was committed, so the roster or length " +
    "could have been changed after the audience spoke — not provably fair");
} else {
  var c2 = commitmentFor(R.secret, rh, R.raceLengthSeconds, R.entropySource);
  check("Fingerprint seals the secret, this exact roster, the " + R.raceLengthSeconds + "s length and the entropy source",
    c2 === R.commitment, "SHA-256(pug-race/2 | secret | roster hash | length | source) = " + c2);
  check("Entropy source sealed before the race", true, R.entropySource + "  —  audience value used: “" + R.audienceSeed + "”");
}
if (!saw) check("Matches the commitment you saw before the race", "warn", "not checked — pass --saw <the fingerprint you saw before the audience spoke>");
else check("Matches the commitment you saw before the race", saw === R.commitment, saw === R.commitment ? saw : "you saw " + saw + " / receipt " + R.commitment);

// 3. seed and roster
var seed = sha256(R.secret + "|" + R.audienceSeed);
check("Final seed = SHA-256(secret | audience seed)", seed === R.finalSeed, seed);
check("Roster hash matches (" + canon.length + " racers)", rh === R.rosterHash, rh);
var bad2 = legacy ? "warn" : false;
var unclean = R.roster.filter(function (n) { return cleanName(n) !== n; });
check("Names contain no invisible or formatting characters", unclean.length ? bad2 : true,
  unclean.length ? unclean.length + " name(s) do: " + unclean.slice(0, 6).map(shown).join(", ") : "all " + R.roster.length + " clean");
var groups = lookalikeGroups(R.roster);
check("No two different names look the same", groups.length ? bad2 : true,
  groups.length ? groups.slice(0, 6).map(function (g) { return g.map(shown).join(" vs "); }).join("; ") : "no look-alikes");
var mixed = R.roster.filter(mixedScript).filter(function (n, i, a) { return a.indexOf(n) === i; });
if (mixed.length) check("Names mixing letters from different alphabets", "warn", mixed.slice(0, 6).map(shown).join(", "));
if (!legacy && R.entropySource === crowdSource()) {
  // viewer submissions: the audience value must be exactly the revealed texts
  var ca = crowdAudience(R.commitment, R.crowd), cr = R.crowd || {};
  var nRev = Array.isArray(cr.revealed) ? cr.revealed.length : 0, nSeal = Array.isArray(cr.sealed) ? cr.sealed.length : 0;
  check("Viewer submissions are complete and each matches its sealed fingerprint", ca.problems.length ? false : true,
    ca.problems.length ? ca.problems.slice(0, 6).join("; ") : nRev + " revealed of " + nSeal + " sealed");
  check("Audience value is the combined viewer submissions", ca.audience === R.audienceSeed,
    ca.audience === R.audienceSeed ? nRev + " text(s), in fingerprint order, joined with \u201c | \u201d"
      : "the submissions combine to \u201c" + ca.audience.slice(0, 200) + "\u201d, not the receipt's audience value");
  if (ca.unrevealed > 0) check("Every sealed submission was revealed", "warn",
    ca.unrevealed + " sealed submission(s) were never revealed — usually a closed page, but leaving one out is a choice " +
    "someone could make after seeing the others");
  if (nRev === 1) check("More than one viewer contributed", "warn",
    "only one submission went into the seed; fair only if that viewer had nothing to do with the operator");
  if (cr.sealedAt && cr.closedAt) check("Server log: submissions timeline (reported by the operator's server)", true,
    "opened " + new Date(cr.openedAt).toISOString() + ", closed " + new Date(cr.sealedAt).toISOString() +
    ", revealed by " + new Date(cr.closedAt).toISOString());
} else {
var audOk = cleanAudience(R.audienceSeed) === R.audienceSeed;
check("Audience value is in its cleaned, as-displayed form", audOk ? true : bad2,
  audOk ? "\u201c" + R.audienceSeed + "\u201d" : shown(R.audienceSeed) + " — the page hashes " + shown(cleanAudience(R.audienceSeed)) +
  "; hidden characters, capitals or punctuation would let look-alike values give different seeds");
}
var cnt = {};
R.roster.forEach(function (n) { cnt[n] = (cnt[n] || 0) + 1; });
var reps = Object.keys(cnt).filter(function (n) { return cnt[n] > 1; }).sort(function (a, b) { return cnt[b] - cnt[a]; });
if (reps.length) check("Entries per name", true, reps.length + " name(s) entered more than once, each copy racing separately: " +
  reps.slice(0, 8).map(function (n) { return n + " \u00d7" + cnt[n]; }).join(", "));

// 4. re-run the race from the seed derived here, never the receipt's claim
var order = simulate(seed, canon, R.raceLengthSeconds * BASE_V);
var resH = resultsHash(order);
check("Recomputed race reproduces the published results", resH === R.resultsHash, resH);
var expectN = Math.min(10, order.length), topOk = R.top10.length === expectN;
R.top10.forEach(function (t, i) {
  var r = order[i];
  if (!t || t.place !== i + 1 || !r || r.name !== t.name || typeof t.time !== "number" ||
      Math.abs(r.time - t.time) > 1e-4 || r.skin !== t.skin) topOk = false;
});
var w = order[0], cw = R.top10[0] || {};
check("Announced winner is the real winner", cw.place === 1 && cw.name === w.name,
  "recomputed winner: " + w.name + " (" + w.time.toFixed(3) + "s)" + (cw.name !== w.name ? " / receipt claims: " + cw.name : ""));
check("Published top-" + expectN + " matches the recomputation", topOk,
  order.slice(0, 3).map(function (r) { return r.place + ". " + r.name + " (" + r.time.toFixed(3) + "s)"; }).join("   "));

// 5. operator's server timeline (supporting evidence — the operator runs that server)
if (R.server && typeof R.server === "object") {
  var sv = R.server, lead = sv.raceAnnouncedAt - sv.commitmentPublishedAt;
  check("Server log: commitment public before the race (reported by the operator's server)",
    isFinite(lead) && lead >= MIN_LEAD_MS,
    isFinite(lead) ? "published " + new Date(sv.commitmentPublishedAt).toISOString() + ", race announced " + secs(lead) + " later" : "timeline missing");
  var ab = Array.isArray(sv.abandonedBefore) ? sv.abandonedBefore : [];
  if (ab.length) check("Server log: no race cut short just before this one", "warn",
    ab.length + " race(s) stopped before finishing since the previous race: " + ab.map(function (x) {
      return String(x.commitment).slice(0, 12) + "… cut " + new Date(x.cutAt).toISOString();
    }).join("; "));
  var wd = Array.isArray(sv.withdrawnBefore) ? sv.withdrawnBefore : [];
  if (wd.length) check("Server log: no commitments withdrawn just before this race", "warn",
    wd.length + " withdrawn since the previous race: " + wd.map(function (x) {
      return String(x.commitment).slice(0, 12) + "… " + new Date(x.publishedAt).toISOString() + " – " + new Date(x.withdrawnAt).toISOString();
    }).join("; "));
}

// 6. same code as the operator?
var mine = codeFingerprint();
if (R.buildFingerprint) check("Operator's build matches this script's", R.buildFingerprint === mine ? true : "warn",
  R.buildFingerprint === mine ? mine : "operator " + R.buildFingerprint + " / this script " + mine +
  " — different code, but the recomputed results above are what matter");

// ---- print ----
var anyFail = checks.some(function (c) { return c[1] === false; }), anyWarn = checks.some(function (c) { return c[1] === "warn"; });
checks.forEach(function (c) {
  console.log((c[1] === true ? "✓ " : c[1] === "warn" ? "⚠ " : "✗ ") + c[0]);
  console.log("    " + c[2]);
});
if (topN) {
  console.log("\nRecomputed standings (top " + Math.min(topN, order.length) + " of " + order.length + "):");
  order.slice(0, topN).forEach(function (r) { console.log("  " + String(r.place).padStart(5) + ".  " + r.time.toFixed(3) + "s  " + r.name); });
}
console.log("\nbuild fingerprint of this script: " + mine);
console.log(anyFail ? "\n✗ VERIFICATION FAILED — do not trust this race"
  : anyWarn ? "\n⚠ RESULTS REPRODUCE — but read the warnings before calling it fair"
  : "\n✓ VERIFIED — this race was fair and these are the real results");
process.exit(anyFail ? 1 : anyWarn ? 2 : 0);

// The race algorithm, copied verbatim from index.html by make-verify.js.
// Never executed here directly; it is read back as text and run above.
/* eslint-disable */
if (false) {
// @@core:begin
/* ------------------------------------------------------------------ *
 * 1. SHA-256 (plain JS — works on file://, auditable, standard)        *
 * ------------------------------------------------------------------ */
const K256 = new Uint32Array([
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);

function utf8Bytes(str){
  const out=[];
  for(let i=0;i<str.length;i++){
    let c=str.charCodeAt(i);
    if(c<0x80) out.push(c);
    else if(c<0x800){ out.push(0xc0|c>>6, 0x80|c&63); }
    else if(c>=0xd800&&c<=0xdbff&&i+1<str.length){
      const c2=str.charCodeAt(i+1);
      const cp=0x10000+((c-0xd800)<<10)+(c2-0xdc00); i++;
      out.push(0xf0|cp>>18, 0x80|(cp>>12)&63, 0x80|(cp>>6)&63, 0x80|cp&63);
    } else { out.push(0xe0|c>>12, 0x80|(c>>6)&63, 0x80|c&63); }
  }
  return new Uint8Array(out);
}

function sha256(input){
  const msg = typeof input==="string" ? utf8Bytes(input) : input;
  const len = msg.length, bitLen = len*8;
  const withPad = (((len+9)+63)>>6)<<6;
  const buf = new Uint8Array(withPad);
  buf.set(msg); buf[len]=0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(withPad-8, Math.floor(bitLen/4294967296));
  dv.setUint32(withPad-4, bitLen>>>0);

  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
      h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const w = new Uint32Array(64);

  for(let off=0;off<withPad;off+=64){
    for(let i=0;i<16;i++) w[i]=dv.getUint32(off+i*4);
    for(let i=16;i<64;i++){
      const a=w[i-15], b=w[i-2];
      const s0=((a>>>7)|(a<<25))^((a>>>18)|(a<<14))^(a>>>3);
      const s1=((b>>>17)|(b<<15))^((b>>>19)|(b<<13))^(b>>>10);
      w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for(let i=0;i<64;i++){
      const S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
      const ch=(e&f)^(~e&g);
      const t1=(h+S1+ch+K256[i]+w[i])>>>0;
      const S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
      const maj=(a&b)^(a&c)^(b&c);
      const t2=(S0+maj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;
    h4=(h4+e)>>>0;h5=(h5+f)>>>0;h6=(h6+g)>>>0;h7=(h7+h)>>>0;
  }
  const hs=[h0,h1,h2,h3,h4,h5,h6,h7];
  let out="";
  for(const v of hs) out += v.toString(16).padStart(8,"0");
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. Deterministic PRNG — xoshiro128** seeded from a hash             *
 * ------------------------------------------------------------------ */
function rngFromHex(hex){
  // 4 x uint32 from the first 32 hex chars
  const s = new Uint32Array(4);
  for(let i=0;i<4;i++) s[i]=parseInt(hex.substr(i*8,8),16)>>>0;
  if((s[0]|s[1]|s[2]|s[3])===0) s[0]=1;
  return s;
}
function rot(x,k){ return ((x<<k)|(x>>>(32-k)))>>>0; }
/* returns a float in [0,1) and advances state in place */
function nextU(s){
  const r = (Math.imul(rot(Math.imul(s[1],5)>>>0,7),9))>>>0;
  const t = (s[1]<<9)>>>0;
  s[2]^=s[0]; s[3]^=s[1]; s[1]^=s[2]; s[0]^=s[3]; s[2]^=t;
  s[3]=rot(s[3],11);
  return r / 4294967296;
}
/* Approximately-normal deviate from 4 uniforms (Irwin-Hall).
   Uses only + - * — no transcendentals, so it is bit-identical
   across every JS engine. sd of (u1+u2+u3+u4-2) is sqrt(1/3). */
const IH_SCALE = Math.sqrt(3); // exactly representable operation
function nextG(s){
  return (nextU(s)+nextU(s)+nextU(s)+nextU(s)-2) * IH_SCALE;
}

/* ------------------------------------------------------------------ *
 * 3. Roster canonicalisation (order-independent)                       *
 * ------------------------------------------------------------------ */
/* Two names that look the same must BE the same. NFKC folds compatibility
   forms (fullwidth letters, ligatures, styled maths letters), then anything
   that renders as nothing is removed: Unicode's default-ignorable set
   (zero-width spaces/joiners, bidi controls, fillers, variation selectors,
   tags) plus format, control, unassigned, private-use and lone-surrogate code
   points, and a few blank-rendering symbols the standard doesn't class as
   ignorable. An emoji keeps its own VS16. A trailing "#<digits>" gets a space
   ("Table #3" -> "Table # 3") because "#1", "#2"... is how repeated names are
   keyed, and a real name spelled like a key would make two different rosters
   hash the same. */
function cleanName(s){
  return s.normalize("NFKC")
    // invisibles first: JS's \s counts U+FEFF as a space, so normalising
    // whitespace first would turn "Be<BOM>an" into "Be an"
    .replace(/(?!️)\p{Default_Ignorable_Code_Point}|\p{Cf}|\p{Cn}|\p{Co}|\p{Cs}|[⠀\u{1D159}\u{16FE4}]|(?<!\p{Extended_Pictographic})️/gu, "")
    .replace(/\s+/g," ")                  // tabs, NBSP, ideographic space… -> one space
    .replace(/\p{Cc}/gu, "")              // then any control characters left
    .replace(/\s+/g," ").trim()
    .replace(/#(\d+)$/, "# $1");
}
/* The audience value is typed by the operator, so text that merely LOOKS the
   same must hash the same. On top of cleanName: lower-case, and keep only
   letters, digits, marks, symbols (emoji) and single spaces. "Banana!",
   "banana." and "BANANA" all become "banana". The page shows the cleaned form
   as "hashed as", so everyone sees exactly what went into the seed. */
function cleanAudience(s){
  return cleanName(s).toLowerCase().replace(/[^\p{L}\p{N}\p{M}\p{So} ]/gu, "").replace(/ +/g," ").trim();
}
function parseNames(text){
  const parts = text.split(/[\n,;\t]+/);
  const out=[];
  for(let p of parts){
    p = cleanName(p);
    if(p) out.push(p);
  }
  return out;
}
/* Lookalike detection (display-only; never feeds the race). Folds letters
   from other scripts that are pixel-identical to Latin ones, plus I/l/1, O/0
   and the rn/m, vv/w, cl/d pairs, so "Bean" and "Веаn" (Cyrillic В, е, а)
   collide. */
const CONFUSABLE = {
  // Cyrillic
  "а":"a","в":"b","е":"e","к":"k","м":"m","н":"h","о":"o","р":"p","с":"c",
  "т":"t","у":"y","х":"x","і":"i","ј":"j","ѕ":"s","ԁ":"d","ԛ":"q","ԝ":"w",
  "ӏ":"l","А":"A","В":"B","Е":"E","К":"K","М":"M","Н":"H","О":"O","Р":"P",
  "С":"C","Т":"T","Х":"X","Ү":"Y","Ѕ":"S","І":"I","Ј":"J","Ӏ":"I",
  // Greek
  "α":"a","ε":"e","ι":"i","κ":"k","ν":"v","ο":"o","ρ":"p","τ":"t","υ":"u",
  "χ":"x","Α":"A","Β":"B","Ε":"E","Ζ":"Z","Η":"H","Ι":"I","Κ":"K","Μ":"M",
  "Ν":"N","Ο":"O","Ρ":"P","Τ":"T","Υ":"Y","Χ":"X",
  // Armenian
  "ո":"n","ս":"u","օ":"o","հ":"h","ց":"g","զ":"q","յ":"j","Տ":"S","Օ":"O",
  // Cherokee
  "Ꭺ":"A","Ᏼ":"B","Ꮯ":"C","Ꭼ":"E","Ꮋ":"H","Ꭻ":"J","Ꮶ":"K","Ꮮ":"L","Ꮇ":"M",
  "Ꮲ":"P","Ꮪ":"S","Ꭲ":"T","Ꮃ":"W","Ꮓ":"Z","Ꭰ":"D","Ꮐ":"G","Ꭵ":"i",
  // Latin variants (IPA, small capitals, dotless)
  "ɑ":"a","ɡ":"g","ı":"i","ȷ":"j","ʙ":"B","ʜ":"H","ɴ":"N","ʀ":"R","ᴏ":"o",
  "ᴜ":"u","ᴠ":"v","ᴡ":"w","ᴢ":"z","ɪ":"I",
  // Latin/digit lookalikes in most UI fonts
  "I":"l","1":"l","|":"l","0":"O"};
function nameSkeleton(n){
  return Array.from(n, ch=>{ const m=CONFUSABLE[ch]||ch; return CONFUSABLE[m]||m; }).join("")
    .replace(/rn/g,"m").replace(/vv/g,"w").replace(/cl/g,"d");
}
const LOOKALIKE_SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u,
                           /\p{Script=Armenian}/u, /\p{Script=Cherokee}/u];
function mixedScript(n){
  let k=0;
  for(const re of LOOKALIKE_SCRIPTS) if(re.test(n)) k++;
  return k>1;
}
/* Groups of DIFFERENT names that look alike. Exact repeats are fine — each
   copy races separately — but "Bill" vs "BiII" would let one entrant pass as
   another. */
function lookalikeGroups(names){
  const by=new Map();
  for(const n of names){ const k=nameSkeleton(n); if(!by.has(k)) by.set(k,new Set()); by.get(k).add(n); }
  return Array.from(by.values()).filter(s=>s.size>1).map(s=>Array.from(s));
}
/* Sorted by UTF-16 code unit (explicit, not locale-dependent) and each
   duplicate given an occurrence index. Input order is irrelevant. */
function canonRoster(names){
  const s = names.slice().sort((a,b)=> a<b?-1:a>b?1:0);
  const seen = new Map(), out=[];
  for(const n of s){
    const k=(seen.get(n)||0); seen.set(n,k+1);
    out.push({name:n, occ:k, key: k===0 ? n : n+"#"+k});
  }
  return out;
}
function rosterHash(canon){
  return sha256(canon.map(r=>r.key).join("\n"));
}
/* The public commitment seals EVERY input the operator controls, not just the
   secret: with only SHA-256(secret) published, an operator who has heard the
   audience value could re-run the race against roster tweaks (e.g. invisible
   characters in one name) or a different length until a chosen pug won. The
   fields are unambiguous: the secret and roster hash are fixed-length hex, the
   length is an integer, and the entropy source is the trailing remainder.
   The tag is inline (not a const) so the build fingerprint covers it. */
function commitmentFor(secret, rosterHashHex, lenSec, entropySource){
  return sha256("pug-race/2|"+secret+"|"+rosterHashHex+"|"+lenSec+"|"+entropySource);
}
/* Viewer submissions as the audience value. The operator knows the secret, so
   if submissions were open text, the operator (or a friend) could send the
   last one after trying candidates until the right pug won. Instead each
   viewer's page first sends only SHA-256 of its text, bound to this race's
   commitment and a random salt. Once the list of sealed hashes is frozen,
   pages reveal their text; nobody could see any text while it still mattered
   who sent what. The audience value is the revealed texts, ordered by their
   hash, joined with " | " (a "|" can't occur inside a cleaned text).
   Sealing this exact source string into the commitment is what turns the
   mode on, so it can't be switched after the fact. */
function crowdSource(){ return "viewer submissions on the watch page, sealed then revealed (pug-race/crowd-1)"; }
function submissionHash(commitment, salt, text){
  return sha256("pug-race/sub|"+commitment+"|"+salt+"|"+text);
}
/* crowd = { sealed:[hash…] ascending, revealed:[{hash,salt,text}…] ascending
   by hash }. Returns the audience value and anything that makes the record
   invalid. Sealed hashes that were never revealed are allowed (a viewer can
   close the tab) but reported, since withholding one is a choice. */
function crowdAudience(commitment, crowd){
  const problems=[], hex64=/^[0-9a-f]{64}$/, hex32=/^[0-9a-f]{32}$/;
  if(!crowd || typeof crowd!=="object" || !Array.isArray(crowd.sealed) || !Array.isArray(crowd.revealed))
    return { audience:"", problems:["no viewer-submission record"], unrevealed:0 };
  const sealed=crowd.sealed, revealed=crowd.revealed, inSealed=new Set();
  for(let i=0;i<sealed.length;i++){
    const h=sealed[i];
    if(typeof h!=="string" || !hex64.test(h)){ problems.push("sealed entry "+(i+1)+" is not a hash"); continue; }
    if(i>0 && !(sealed[i-1]<h)) problems.push("sealed hashes are not in ascending order without repeats");
    inSealed.add(h);
  }
  const texts=[];
  for(let i=0;i<revealed.length;i++){
    const r=revealed[i]||{}, n="revealed entry "+(i+1);
    if(typeof r.hash!=="string" || !inSealed.has(r.hash)){ problems.push(n+" was never sealed"); continue; }
    if(i>0 && !(String((revealed[i-1]||{}).hash)<r.hash)) problems.push("revealed entries are not in ascending hash order without repeats");
    if(typeof r.salt!=="string" || !hex32.test(r.salt)){ problems.push(n+" has a malformed salt"); continue; }
    if(typeof r.text!=="string" || !r.text || r.text.length>80 || cleanAudience(r.text)!==r.text){
      problems.push(n+" is empty, too long or not in cleaned form"); continue; }
    if(submissionHash(commitment, r.salt, r.text)!==r.hash){ problems.push(n+" does not match its sealed hash"); continue; }
    texts.push(r.text);
  }
  if(!texts.length) problems.push("no submissions were revealed");
  return { audience:texts.join(" | "), problems, unrevealed:sealed.length-revealed.length };
}

/* ------------------------------------------------------------------ *
 * 4. The race simulation — a pure function of the seed                 *
 * ------------------------------------------------------------------ */
const DT        = 0.1;     // fixed physics step, seconds
const BASE_V    = 0.5;     // normalised units per second (half-length tracks: racers
                           //   cover half the ground in the same lenSec, so they read
                           //   slower and the start is less frantic)
const BASE_SD   = 0.05;    // spread of innate pace between pugs
const SURGE_DECAY = 0.92;  // per-step AR(1) coefficient  (tau ~= 1.2s)
const SURGE_SD  = 0.16;    // stationary sd of the surge term
const SURGE_KICK= SURGE_SD*Math.sqrt(1-SURGE_DECAY*SURGE_DECAY);
const MIN_V     = 0.10;    // a pug never stalls completely (20% of BASE_V)
const SKIN_COUNT= 100;

/* ---- drama knobs -------------------------------------------------
   Both mechanics below are IDENTITY-BLIND: a pug is never singled out
   by who it is, only by where it is. Every racer runs the exact same
   rules with the exact same odds, so the field stays exchangeable and
   the race stays provably fair.                                      */
const HAZARDS = [
  {id:"puddle",   label:"belly-flopped into a mud puddle", factor:0.45, dur:1.4},
  {id:"squirrel", label:"stopped to bark at a squirrel",   factor:0.28, dur:1.9},
  {id:"snack",    label:"found a dropped snack",           factor:0.35, dur:1.7},
  {id:"butterfly",label:"got distracted by a butterfly",   factor:0.55, dur:1.2},
  {id:"nap",      label:"took a very quick nap",           factor:0.22, dur:2.2}
];
const HAZ_P     = 0.26;    // chance a given pug trips on a given obstacle
const ZOOM_MULT = 1.55;    // speed multiplier while the zoomies last
const ZOOM_DUR  = 1.8;
const ZOOM_COOL = 3.0;     // no back-to-back zoomies
const ZOOM_GAIN = 4.0;     // how strongly falling behind earns a comeback
const ZOOM_PMAX = 0.75;    // cap on zoomies per second
const ZOOM_MIN  = 0.03;    // must be this far back (fraction of track) to trigger

/* Obstacle positions come from the seed, so they are part of the
   committed race and identical for every verifier. */
function buildZones(seedHex, dist){
  const s = rngFromHex(sha256(seedHex+"|obstacles"));
  const n = Math.max(3, Math.min(14, Math.round(dist/6)));
  const zs=[];
  for(let i=0;i<n;i++){
    const frac = 0.12 + 0.78*((i+0.5)/n) + (nextU(s)-0.5)*(0.62/n);
    zs.push({ x: frac*dist, type: HAZARDS[Math.floor(nextU(s)*HAZARDS.length)] });
  }
  zs.sort((a,b)=> a.x-b.x);
  return zs;
}

function buildRacers(seedHex, canon){
  const n = canon.length;
  const racers = new Array(n);
  for(let i=0;i<n;i++){
    const r = canon[i];
    const s = rngFromHex(sha256(seedHex+"|"+r.key));
    const skin = Math.floor(nextU(s)*SKIN_COUNT);
    const base = BASE_V*(1 + BASE_SD*nextG(s));
    racers[i] = {
      i, name:r.name, key:r.key, skin,
      base: base<0.4?0.4:base,
      s, surge:0, pos:0, prevPos:0, dx:0, done:false, time:0, place:0,
      zi:0, stun:0, stunF:1, stunId:null, zoom:0, cool:0, wob:0,
      dy:0, dyInit:false
    };
  }
  return racers;
}

/* Standing start: every racer eases off the line together over the first
   START_RAMP seconds instead of leaping to full speed on frame one. It is a
   pure function of race time, applied identically to everyone, so it is fully
   deterministic and identity-blind — the field stays exchangeable and the race
   stays provably fair. */
const START_RAMP = 2.5;    // seconds from the gun to full speed
function launch(t){
  if(t>=START_RAMP) return 1;
  const u=t/START_RAMP, s=u*u*(3-2*u);   // smoothstep ease
  return 0.16 + 0.84*s;                  // creep off the line, then wind up
}

/* Advance every unfinished racer one step. t = time at START of step.
   Returns drama events (for live commentary) when collect is true. */
function stepAll(racers, t, dist, zones, collect){
  // Leader position: a max, so it does not depend on racer ordering.
  let lead=0;
  for(let i=0;i<racers.length;i++){ const p=racers[i].pos; if(p>lead) lead=p; }
  const evts = collect ? [] : null;

  for(let i=0;i<racers.length;i++){
    const r = racers[i];
    if(r.done) continue;
    r.prevPos = r.pos;                 // last settled position, for render interpolation

    if(r.stun>0) r.stun-=DT;
    if(r.zoom>0) r.zoom-=DT;
    if(r.cool>0) r.cool-=DT;

    r.surge = r.surge*SURGE_DECAY + nextG(r.s)*SURGE_KICK;
    let v = r.base*(1+r.surge);
    if(v<MIN_V) v=MIN_V;

    // ---- comeback: the further back you are, the likelier the zoomies ----
    if(r.zoom<=0 && r.cool<=0 && r.stun<=0){
      const deficit = lead - r.pos;
      if(deficit > dist*ZOOM_MIN){
        let p = (deficit/dist)*ZOOM_GAIN;
        if(p>ZOOM_PMAX) p=ZOOM_PMAX;
        if(nextU(r.s) < p*DT){
          r.zoom=ZOOM_DUR; r.cool=ZOOM_COOL;
          if(collect) evts.push({r, kind:"zoom"});
        }
      }
    }
    if(r.zoom>0) v*=ZOOM_MULT;
    if(r.stun>0) v*=r.stunF;
    v *= launch(t);                    // ease off the line for the first moments

    const np = r.pos + v*DT;

    // ---- obstacles: same odds for whoever crosses ----
    while(r.zi<zones.length && zones[r.zi].x<=np){
      const z=zones[r.zi]; r.zi++;
      const u=nextU(r.s);                    // always drawn, keeps streams aligned
      if(u<HAZ_P && r.stun<=0){
        r.stun=z.type.dur; r.stunF=z.type.factor; r.stunId=z.type.id; r.zoom=0;
        if(collect) evts.push({r, kind:"haz", haz:z.type});
      }
    }

    if(np>=dist){
      r.time = t + (dist-r.pos)/v;   // exact sub-step crossing → photo finish
      r.pos = dist; r.done = true;
      if(collect) evts.push({r, kind:"fin"});
    } else r.pos = np;
  }
  return evts;
}
/* Runs the whole race to completion and returns final standings. */
function simulate(seedHex, canon, dist){
  const racers = buildRacers(seedHex, canon);
  const zones  = buildZones(seedHex, dist);
  let t=0, left=racers.length;
  const maxT = dist*40 + 1200;     // hard bound; MIN_V guarantees arrival
  while(left>0 && t<maxT){
    stepAll(racers,t,dist,zones,false);
    t+=DT;
    left=0; for(let i=0;i<racers.length;i++) if(!racers[i].done) left++;
  }
  const order = racers.slice().sort((a,b)=>{
    if(a.time!==b.time) return a.time-b.time;
    return a.key<b.key?-1:a.key>b.key?1:0;   // deterministic tie-break
  });
  for(let i=0;i<order.length;i++) order[i].place=i+1;
  return order;
}
function resultsHash(order){
  return sha256(order.map(r=>r.place+"|"+r.key+"|"+r.time.toFixed(4)).join("\n"));
}


const CORE_FN_NAMES = ["sha256","utf8Bytes","rngFromHex","rot","nextU","nextG",
  "cleanName","cleanAudience","parseNames","canonRoster","rosterHash","commitmentFor","crowdSource","submissionHash","crowdAudience","buildZones","buildRacers","stepAll",
  "launch","simulate","resultsHash","skinDef","coreConstants"];
/* Resolved by NAME at check time, never captured at load time: the race calls
   these through their global bindings, so an extension that reassigns a binding
   after load swaps what actually runs. Hashing references captured at startup
   would still report the pristine source while rigged code ran — a false all-
   clear, which is worse than no check. Function.prototype.toString.call()
   ignores any own .toString the attacker may have planted on the replacement. */
/* The tuning constants the race reads, by value. Function source alone
   misses them: editing HAZ_P or BASE_SD changes every result while every
   function's text stays byte-identical. verify.js hashes the same list. */
function coreConstants(){
  return JSON.stringify([Array.from(K256), IH_SCALE, DT, BASE_V, BASE_SD, SURGE_DECAY, SURGE_SD, SURGE_KICK,
    MIN_V, SKIN_COUNT, HAZARDS, HAZ_P, ZOOM_MULT, ZOOM_DUR, ZOOM_COOL, ZOOM_GAIN, ZOOM_PMAX, ZOOM_MIN, START_RAMP]);
}
function codeFingerprint(){
  let src="";
  for(let i=0;i<CORE_FN_NAMES.length;i++){
    const n=CORE_FN_NAMES[i];
    const f=globalThis[n];
    src += n+":"+(typeof f==="function" ? Function.prototype.toString.call(f) : "MISSING")+"\n";
  }
  return sha256(src+"constants:"+coreConstants()+"\n");
}

const COATS = ["#D8A76A","#E8B183","#B9BCC0","#43434A","#8C6A45","#F0DEC0",
               "#6B4A32","#8892A0","#DCD6C8","#C8763C","#A2825C","#EFEDE7"];
const MASKS = [null,"#2B2B30","#4E4A46","#F3F0E8"];
const PATCH = ["none","chest","eye","saddle","socks"];
const EARS  = ["floppy","rose","perky"];
const EYES  = ["round","derp","sleepy","starry"];
const COLLARS=["#E4572E","#2F80ED","#27AE60","#9B51E0","#F2C94C",
               "#EB5757","#56CCF2","#BB6BD9","#6FCF97","#F2994A"];
const ACCS  = ["none","goggles","bandana","cap","bowtie","crown","headband"];

function fnv(n){ let h=0x811c9dc5; h=Math.imul(h^(n+1),0x01000193); h=Math.imul(h^(h>>>13),0x01000193); return h>>>0; }
/* Mixed-radix over coat×mask×patch (12*4*5 = 240 > 100) guarantees all
   100 skins differ. The remaining features add variety on top. */
function skinDef(i){
  const h = fnv(i);
  return {
    id:i,
    coat : COATS[i%12],
    mask : MASKS[((i/12)|0)%4],
    patch: PATCH[((i/48)|0)%5],
    ear  : EARS[h%3],
    eye  : EYES[(h>>>3)%4],
    collar:COLLARS[(h>>>6)%10],
    acc  : ACCS[(h>>>10)%7]
  };
}
// @@core:end
}

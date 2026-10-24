// The hardening rules: each must reject what it's meant to reject and still
// accept honest input. Cleaning, the roster key rule, look-alikes, the
// audience value, viewer-page checks on crafted event streams, and the
// server's own checks (on a private test server).
"use strict";
const { ok, done, wait, loadPage, M, rnd, makeReceipt, verifyJs, startServer, stopServer, unlock, post, getState, httpReq } = require("./lib");
const { sha256, cleanName, cleanAudience, parseNames, canonRoster, rosterHash, commitmentFor, lookalikeGroups } = M;
const SRC = "the first word shouted after I say go", LEN = 45;
const tools = loadPage("/", { protocol: "file:" }), P = tools.P, el = tools.el;

// a self-consistent receipt for any roster/audience, so only the check under test can object
const consistent = (roster, audience) => makeReceipt({ roster, audience, source: SRC, len: LEN });
const receipt = (secret, commitment, audience, roster) => makeReceipt({ secret, commitment, roster, audience, source: SRC, len: LEN });
const pageVerdict = (rec, saw) => ({ ok: "✓", warn: "⚠", fail: "✗" })[tools.verify(rec, saw).v];
const vjs = (rec, saw) => verifyJs(rec, saw).code;

(async () => {
  const srv = await startServer(); await unlock();
  try {
  // ---- 7. cleaning coverage ----
  const invisible = [0x00AD, 0x034F, 0x061C, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x180B, 0x180E, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
    0x202A, 0x202E, 0x2060, 0x2061, 0x2064, 0x206A, 0x206F, 0x2800, 0x3164, 0xFE00, 0xFE0F, 0xFEFF, 0xFFA0, 0x1BCA0, 0x1D159,
    0x1D173, 0x1D17A, 0x16FE4, 0xE0001, 0xE0041, 0xE0100, 0xE01EF, 0xE000, 0x0378, 0x0007];
  const survivors = invisible.filter(cpt => cleanName("Be" + String.fromCodePoint(cpt) + "an") !== "Bean");
  ok("all " + invisible.length + " invisible/format/unassigned code points are removed", !survivors.length,
    survivors.map(c => "U+" + c.toString(16).toUpperCase()).join(" "));
  ok("emoji VS16 kept", cleanName("❤️") === "❤️");
  ok("accented and non-Latin names untouched", ["Zoë", "José", "Иван", "李雷", "Ahmed"].every(n => cleanName(n) === n));
  ok("cleanName is idempotent", ["Bean​", "Ｂｅａｎ", "Table #3", " a  b ", "ﬁsh"].every(n => cleanName(cleanName(n)) === cleanName(n)));
  // ---- 6. roster hash can't be ambiguous ----
  ok("a name spelled like a repeat key is rewritten", cleanName("Bean#1") === "Bean# 1" && cleanName("Table #12") === "Table # 12");
  ok("[Bean, Bean] and [Bean, Bean#1] no longer hash the same",
    rosterHash(canonRoster(parseNames("Bean\nBean"))) !== rosterHash(canonRoster(parseNames("Bean\nBean#1"))));
  const amb = consistent(["Bean", "Bean#1", "Winston"], "walrus");
  ok("page verifier rejects a roster containing a key-like name", pageVerdict(amb, amb.commitment) === "✗");
  ok("verify.js rejects it too", vjs(amb, amb.commitment) === 1);
  // ---- look-alikes ----
  const pairs = [["Bean", "Веаn"], ["Noah", "Νοαh"], ["Bean", "Beaո"], ["HAM", "ᎻAᎷ"],
                 ["Beam", "Bearn"], ["Will", "WiII"], ["BOB", "B0B"], ["dad", "clad"], ["Bob", "ʙob"]];
  const missed = pairs.filter(p => lookalikeGroups(p).length !== 1);
  ok("look-alike pairs caught (Cyrillic, Greek, Armenian, Cherokee, rn/m, I/l, 0/O, cl/d, small caps)", !missed.length, JSON.stringify(missed));
  ok("distinct names not flagged", lookalikeGroups(["Bill", "Bili", "bean", "Bean", "Clara", "Dara", "Ann", "Anne"]).length === 0);

  // ---- 1. audience value ----
  const variants = ["banana", "Banana", "BANANA", "banana!", " banana. ", "ba​nana", "banana﻿", "Ｂａｎａｎａ", "bananaㅤ"];
  ok("look-alike audience values all hash as one", new Set(variants.map(cleanAudience)).size === 1, [...new Set(variants.map(cleanAudience))].join("|"));
  ok("audience keeps visible content", cleanAudience("Purple Walrus 7 4 2") === "purple walrus 7 4 2" && cleanAudience("🐶🐶") === "🐶🐶");
  el("names").value = "Bean\nWinston\nNugget"; el("entropySrc").value = SRC; P("updateCount()"); P('$("genSecret").onclick()');
  el("audience").value = "Ba​nana!"; P('$("audience").dispatchEvent && 0');
  P('$("startRace").onclick()');
  ok("operator page hashes the cleaned audience value", P("state.audience") === "banana" && P("state.seed") === sha256(P("state.secret") + "|banana"));
  const dirty = consistent(["Bean", "Winston", "Nugget"], "ba​nana");
  ok("page verifier rejects a receipt with an uncleaned audience value", pageVerdict(dirty, dirty.commitment) === "✗");
  ok("verify.js rejects it too", vjs(dirty, dirty.commitment) === 1);
  const clean = consistent(["Bean", "Winston", "Nugget"], "banana");
  ok("clean receipt still verifies (page and verify.js)", pageVerdict(clean, clean.commitment) === "✓" && vjs(clean, clean.commitment) === 0);

  // ---- 2/3/5. viewer page with crafted streams ----
  const st = o => Object.assign({ type: "state", now: Date.now(), minLeadMs: 20000, lobby: null, race: null, receipt: null, commitLog: [] }, o);
  const NAMES2 = ["Bean", "Bean", "Bean", "Winston", "Nugget", "Mochi"];
  const mk = (roster, audience) => { const secret = rnd(), canon = canonRoster(roster), rh = rosterHash(canon);
    return { secret, canon, rh, c: commitmentFor(secret, rh, LEN, SRC), audience, seed: sha256(secret + "|" + audience) }; };
  const lobbyOf = (m, rosterOverride) => ({ commitment: m.c, rosterHash: m.rh, entropySource: SRC, roster: rosterOverride || m.canon.map(r => r.name), racerCount: m.canon.length, lenSec: LEN });
  const raceOf = (m, id, o) => Object.assign({ id, seed: m.seed, roster: m.canon.map(r => r.name), lenSec: LEN, commitment: m.c, audienceSeed: m.audience,
    secret: m.secret, entropySource: SRC, practice: false, startAt: Date.now() + 1000 }, o || {});
  {
    const v = loadPage("/watch"), m = mk(NAMES2, "walrus");
    v.feed(st({ lobby: lobbyOf(m) }));
    ok("lobby shows the sealed roster and confirms its hash", !v.el("lobbyRoster").classList.contains("hidden") && /reproduce the sealed roster hash/.test(v.el("lobbyRosterInfo").innerHTML));
    ok("lobby highlights repeated entries", /Bean ×3/.test(v.el("lobbyRosterInfo").innerHTML));
    const v2 = loadPage("/watch"); v2.feed(st({ lobby: lobbyOf(m, ["Bean", "Winston", "Nugget", "Mochi", "Extra", "Other"]) }));
    ok("lobby flags a displayed roster that doesn't match the sealed hash", /do NOT reproduce/.test(v2.el("lobbyRosterInfo").innerHTML));
    v.advance(60000); v.feed(st({ lobby: lobbyOf(m), race: raceOf(m, "ok1") }));
    ok("valid announcement plays with “checked before the start”", v.el("liveCheck").textContent === "✓ checked before the start" && v.el("lobbyOverlay").classList.contains("hidden"));
    const vv = v.verify(); ok("viewer can verify immediately without any reveal", vv.v === "ok", vv.why);
  }
  for (const [label, o] of [["a wrong secret", { secret: rnd() }], ["a seed not derived from the secret", { seed: rnd() }],
                            ["no secret", { secret: undefined }], ["an uncleaned audience value", { audienceSeed: "Walrus!" }]]) {
    const v = loadPage("/watch"), m = mk(NAMES2, "walrus"); v.feed(st({ lobby: lobbyOf(m) })); v.advance(60000);
    v.feed(st({ lobby: lobbyOf(m), race: raceOf(m, "bad", o) }));
    ok("viewer refuses to play an announcement with " + label, v.el("liveCheck").textContent === "✗ race refused" && !v.el("lobbyOverlay").classList.contains("hidden"));
    ok("…and its verifier fails that race", v.verify(consistent(NAMES2, "walrus"), m.c).v === "fail" ||
      v.verify(receipt(m.secret, m.c, "walrus", NAMES2), m.c).v === "fail");
  }
  {
    const v = loadPage("/watch"), m = mk(NAMES2, "walrus"); v.feed(st({ lobby: lobbyOf(m) }));
    v.feed(st({ lobby: lobbyOf(m), race: raceOf(m, "pr", { practice: true, secret: undefined }) }));
    ok("practice races carry a PRACTICE banner", /^PRACTICE/.test(v.el("liveCheck").textContent));
  }
  // ---- 4. cut-short races (viewer's own record) ----
  {
    const v = loadPage("/watch"), m1 = mk(NAMES2, "walrus"), m2 = mk(NAMES2, "otter");
    v.feed(st({ lobby: lobbyOf(m1) })); v.advance(60000);
    v.feed(st({ lobby: lobbyOf(m1), race: raceOf(m1, "r1", { startAt: Date.now() + 60000 + 30000 }) }));   // countdown running
    v.feed(st({ lobby: lobbyOf(m1), race: null }));                                                     // cleared mid-countdown
    v.feed(st({ lobby: lobbyOf(m2) })); v.advance(60000);
    v.feed(st({ lobby: lobbyOf(m2), race: raceOf(m2, "r2", { startAt: Date.now() + 120000 }) }));
    const out = v.verify(undefined, m2.c);
    ok("a race cleared before it finished is flagged on the next race", out.v === "warn" && /cut short/.test(out.why), out.why);
    ok("…and the banner says to check", /⚠ see Verify/.test(v.el("liveCheck").textContent));
    const v3 = loadPage("/watch"), m3 = mk(NAMES2, "walrus"), m4 = mk(NAMES2, "otter");
    v3.feed(st({ lobby: lobbyOf(m3) })); v3.advance(60000);
    v3.feed(st({ lobby: lobbyOf(m3), race: raceOf(m3, "f1", { startAt: Date.now() - 200000 }) }));    // long finished
    v3.feed(st({ lobby: lobbyOf(m4) })); v3.advance(60000);
    v3.feed(st({ lobby: lobbyOf(m4), race: raceOf(m4, "f2") }));
    ok("races run back to back after finishing are NOT flagged", v3.verify(undefined, m4.c).v === "ok");
  }

  // ---- 3/4. live server ----
  const roster = canonRoster(["Bean", "Winston", "Nugget", "Mochi"]).map(r => r.name), rh = rosterHash(canonRoster(roster));
  const pub = async () => { const secret = rnd(), c = commitmentFor(secret, rh, LEN, SRC);
    await post("/api/lobby", { commitment: c, rosterHash: rh, entropySource: SRC, roster, racerCount: roster.length, lenSec: LEN }); return { secret, c }; };
  const raceBody = (k, audience, o) => Object.assign({ seed: sha256(k.secret + "|" + audience), roster, lenSec: LEN, commitment: k.c,
    audienceSeed: audience, secret: k.secret, entropySource: SRC }, o || {});
  const k1 = await pub(); await wait(20500);
  let r = await post("/api/race", raceBody(k1, "walrus", { secret: rnd() }));
  ok("server rejects an announcement whose secret doesn't match the commitment", !r.ok && /does not match/.test(r.error || ""), r.error);
  r = await post("/api/race", raceBody(k1, "walrus", { seed: rnd() }));
  ok("server rejects a seed not derived from secret | audience", !r.ok && /does not match/.test(r.error || ""), r.error);
  r = await post("/api/race", raceBody(k1, "walrus", { roster: roster.concat(["Extra"]) }));
  ok("server rejects a roster other than the sealed one", !r.ok, r.error);
  r = await post("/api/race", raceBody(k1, "walrus", { secret: undefined }));
  ok("server rejects a real race without its secret", !r.ok, r.error);
  r = await post("/api/race", raceBody(k1, "walrus"));
  ok("server accepts the honest announcement", r.ok === true, r.error);
  await post("/api/lobby", { commitment: null, racerCount: 0, lenSec: 45, reset: true });   // cut it short mid-countdown
  const k2 = await pub(); await wait(20500);
  r = await post("/api/race", raceBody(k2, "otter"));
  const rec2 = consistent(roster, "otter"); Object.assign(rec2, receipt(k2.secret, k2.c, "otter", roster));
  const rr = await post("/api/receipt", { receipt: rec2 });
  const state = await getState();
  const ab = state.receipt && state.receipt.server && state.receipt.server.abandonedBefore || [];
  ok("server records the cut-short race in the next receipt", r.ok && rr.ok && ab.length === 1 && ab[0].commitment === k1.c, JSON.stringify(ab).slice(0, 80));
  ok("verify.js warns on that receipt", vjs(state.receipt, k2.c) === 2);
  const log = (await httpReq("GET", "/api/commitments")).j;
  ok("commitment log marks it abandoned", log.commitments.some(e => e.commitment === k1.c && e.abandonedAt));
  } catch (e) { ok("suite ran to the end", false, e && e.stack || e); }
  await stopServer(srv);
  done();
})();

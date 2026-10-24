// Name and audience cleaning, look-alike detection, the setup page's name
// warnings, and verify.js: it must agree with the page and reject the same receipts.
"use strict";
const fs = require("fs"), path = require("path");
const { ROOT, PAGE_CODE, TMP, loadPage, ok, done, verifyJs } = require("./lib");
const pg = loadPage("/", { protocol: "file:" }), P = pg.P, el = pg.el;
const parse = P("parseNames"), lookalikeGroups = P("lookalikeGroups"), mixedScript = P("mixedScript");

// cleaning
const tricks={"zero-width space":"Bean​","ZWJ":"Be‍an","word joiner":"Bean⁠","BOM":"﻿Bean","RTL override":"Bean‮",
  "soft hyphen":"Be­an","Hangul filler":"Beanㅤ","braille blank":"Bean⠀","variation selector":"Bean️","CGJ":"Be͏an",
  "fullwidth":"Ｂｅａｎ","NBSP":"Bean ","ideographic space":"Bean　","tag char":"Bean\u{E0041}"};
for(const [k,v] of Object.entries(tricks)) ok("cleaned: "+k, parse(v)[0]==="Bean", JSON.stringify(parse(v)[0]));
ok("emoji VS16 kept", parse("❤️ Bean")[0]==="❤️ Bean");
ok("accents kept", parse("Zoë, José")[1]==="José" && parse("Zoë")[0]==="Zoë");
// look-alikes
ok("Cyrillic look-alike caught", lookalikeGroups(["Bean","Веаn"]).length===1);
ok("Greek look-alike caught", lookalikeGroups(["NOAH","ΝΟΑΗ"]).length===1);
ok("I/l look-alike caught", lookalikeGroups(["Bill","BiII"]).length===1);
ok("0/O look-alike caught", lookalikeGroups(["BOB","B0B"]).length===1);
ok("exact repeats are not look-alikes", lookalikeGroups(["Bean","Bean"]).length===0);
ok("Bill vs Bili not flagged", lookalikeGroups(["Bill","Bili"]).length===0);
ok("bean vs Bean not flagged", lookalikeGroups(["bean","Bean"]).length===0);
ok("mixed script detected", mixedScript("Веаn") && mixedScript("Bеan") && !mixedScript("Bean") && !mixedScript("Иван"));
// setup UI
el("names").value="Bean\nВеаn\nWinston"; el("entropySrc").value="first shout"; el("secretState").innerHTML="";
P("updateCount()"); P('$("genSecret").onclick()');
ok("commit blocked on look-alikes", P("state.commitment")===null && /look identical/.test(el("secretState").innerHTML));
ok("look-alike warning shown", /Look-alike/.test(el("nameWarn").innerHTML));
el("names").value="Bean​\nWinston\nWinston"; P("updateCount()");
ok("cleaning + repeat notes shown", /invisible/.test(el("nameWarn").innerHTML) && /more than once/.test(el("nameWarn").innerHTML));
// receipt pipeline
el("names").value="Bean\nWinston\nNugget\nMochi"; P("updateCount()"); P('$("genSecret").onclick()');
el("audience").value="walrus"; P('$("startRace").onclick()'); P('$("revealBtn").onclick()');
const rec=JSON.parse(el("receiptOut").value);
ok("honest receipt verifies in page", pg.verify(rec, rec.commitment).v==="ok");
// a receipt whose roster bypassed cleaning (commitment recomputed so only the name check can catch it)
const forge=(roster)=>{ const r=JSON.parse(JSON.stringify(rec)); const canon=P("canonRoster")(roster); r.roster=canon.map(x=>x.name); r.rosterHash=P("rosterHash")(canon);
  r.commitment=P("commitmentFor")(r.secret,r.rosterHash,r.raceLengthSeconds,r.entropySource); const o=P("simulate")(r.finalSeed,canon,r.raceLengthSeconds*0.5);
  r.resultsHash=P("resultsHash")(o); r.top10=o.slice(0,10).map(x=>({place:x.place,name:x.name,time:+x.time.toFixed(4),skin:x.skin})); return r; };
const zw=forge(["Bean","Bean​","Winston","Nugget"]), la=forge(["Bean","Веаn","Winston","Nugget"]);
ok("page: invisible-char roster fails", pg.verify(zw, zw.commitment).v==="fail");
ok("page: look-alike roster fails", pg.verify(la, la.commitment).v==="fail");
// verify.js
let r=verifyJs(rec,rec.commitment); ok("verify.js: honest + --saw → exit 0", r.code===0, r.out.trim().split("\n").pop());
ok("verify.js: fingerprint equals the page's", r.out.includes(P("REFERENCE_BUILD")) && rec.buildFingerprint===P("REFERENCE_BUILD"));
ok("verify.js: honest without --saw → exit 2", verifyJs(rec).code===2);
ok("verify.js: wrong --saw → exit 1", verifyJs(rec,"0".repeat(64)).code===1);
ok("verify.js: invisible-char roster → exit 1", verifyJs(zw,zw.commitment).code===1);
ok("verify.js: look-alike roster → exit 1", verifyJs(la,la.commitment).code===1);
for(const k of ["finalSeed","top10","rosterHash","resultsHash","entropySource"]){ const t=Object.assign({},rec); delete t[k];
  ok("verify.js: missing "+k+" → exit 1", verifyJs(t,rec.commitment).code===1); }
const sw=JSON.parse(JSON.stringify(rec)); [sw.top10[0].name,sw.top10[1].name]=[sw.top10[1].name,sw.top10[0].name];
ok("verify.js: swapped winner → exit 1", verifyJs(sw,rec.commitment).code===1);
const ln=Object.assign({},rec,{raceLengthSeconds:rec.raceLengthSeconds+1});
ok("verify.js: changed length → exit 1", verifyJs(ln,rec.commitment).code===1);
// tampered verify.js copies
const vsrc=fs.readFileSync(ROOT+"/verify.js","utf8");
const hazp=path.join(TMP,"verify-hazp.js"); fs.writeFileSync(hazp, vsrc.replace("const HAZ_P     = 0.26;","const HAZ_P     = 0.27;"));
let t=verifyJs(rec,rec.commitment,hazp);
ok("a constant tweak changes verify.js's fingerprint (flagged)", t.code!==0 && !t.out.includes("build fingerprint of this script: "+P("REFERENCE_BUILD")) && /⚠ Operator's build/.test(t.out));
// page fingerprint catches constant tweaks too
const pg2=loadPage("/",{protocol:"file:",code:PAGE_CODE.replace("const HAZ_P     = 0.26;","const HAZ_P     = 0.27;")});
ok("page self-check flags a constant tweak", pg2.P("integrityChecks().checks[0][1]")===false);
ok("page self-check passes on the real build", P("integrityChecks().checks[0][1]")===true);
// ?key= scrub
const kp=loadPage("/",{search:"?key=deadbeef&x=1"});
ok("?key= in URL is ignored", kp.P("OP_KEY")==="");
ok("?key= is scrubbed from the address bar", kp.history.last==="/?x=1", String(kp.history.last));
done();

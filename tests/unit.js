// The page on its own (opened as a local file): setup → commit → race → receipt → Verify tab,
// plus the setup guardrails and the receipt checks a tampered receipt must fail.
"use strict";
const { loadPage, ok, done } = require("./lib");
const pg = loadPage("/", { protocol: "file:", expose: true });
const $ = pg.el, run = pg.P;
const verify = (rec, saw) => pg.verify(rec, saw || "").v;

ok("integrity: build matches reference", run("integrityChecks().checks[0][1]"), "this build is "+run("codeFingerprint()")+" — if you changed the race code on purpose, set REFERENCE_BUILD to it");

// ---- honest race ----
const names=["Bartholomew","Winston","Nugget","Dumpling","Meatball","Peanut","Mochi","Bean"];
$("names").value=names.join("\n"); $("entropySrc").value="the first word shouted after I say go";
$("genSecret").onclick();
const commit=run("state.commitment");
ok("generate produces a commitment", /^[0-9a-f]{64}$/.test(commit||""));
$("audience").value="purple walrus";
$("startRace").onclick();
ok("race starts", !$("startErr").textContent, $("startErr").textContent);
$("revealBtn").onclick();
const rec=JSON.parse($("receiptOut").value);
ok("receipt is format 2 with entropySource", rec.format==="pug-race/2" && rec.entropySource==="the first word shouted after I say go");
ok("honest receipt + correct saw-commit verifies", verify(rec,commit)==="ok");
ok("honest receipt without saw-commit warns", verify(rec,"")==="warn");
ok("wrong saw-commit fails", verify(rec,"0".repeat(64))==="fail");

// ---- the rig: grind zero-width variants of one name after hearing the audience value ----
const target="Bean";
let rigged=null;
for(let k=1;k<400 && !rigged;k++){
  const r2=JSON.parse(JSON.stringify(rec));
  r2.roster=r2.roster.map(n=>n===target?target+"\u200B".repeat(k):n);
  const canon=run("canonRoster")(r2.roster); r2.rosterHash=run("rosterHash")(canon);
  const order=run("simulate")(r2.finalSeed,canon,r2.raceLengthSeconds*0.5);
  if(order[0].name.startsWith(target)){ r2.resultsHash=run("resultsHash")(order);
    r2.top10=order.slice(0,10).map(r=>({place:r.place,name:r.name,time:+r.time.toFixed(4),skin:r.skin})); rigged=r2; }
}
ok("attack finds a rigged roster (sanity: rig still possible against v1)", !!rigged);
if(rigged){
  ok("rigged roster now FAILS v2 verification", verify(rigged,commit)==="fail");
  const v1=Object.assign({},rigged,{format:"pug-race/1",commitment:run("sha256")(rigged.secret)}); delete v1.entropySource;
  ok("same rig in a legacy v1 receipt is flagged, not verified", verify(v1,v1.commitment)==="warn");
}
// length tamper
const r3=Object.assign({},rec,{raceLengthSeconds:rec.raceLengthSeconds+1}); ok("changed length fails", verify(r3,commit)==="fail");
// entropy source tamper
ok("changed entropy source fails", verify(Object.assign({},rec,{entropySource:"anything"}),commit)==="fail");
// stripped fields
for(const k of ["finalSeed","rosterHash","resultsHash","top10","entropySource"]){
  const r4=Object.assign({},rec); delete r4[k]; ok("missing "+k+" fails", verify(r4,commit)==="fail");
}
ok("empty top10 fails", verify(Object.assign({},rec,{top10:[]}),commit)==="fail");
const r5=JSON.parse(JSON.stringify(rec)); [r5.top10[0].name,r5.top10[1].name]=[r5.top10[1].name,r5.top10[0].name];
ok("swapped announced winner fails", verify(r5,commit)==="fail");
ok("truncated top10 fails", verify(Object.assign({},rec,{top10:rec.top10.slice(0,3)}),commit)==="fail");
ok("garbage JSON fails cleanly", verify("not json")==="fail");

// ---- setup guardrails ----
$("names").value=names.join("\n"); $("genSecret").onclick();
$("names").value=names.join("\n")+"\nNewcomer"; $("names").fire("input");
ok("editing roster after commit discards it", run("state.commitment")===null);
$("names").value=names.join("\n"); $("genSecret").onclick(); $("names").value=names.join("\n").replace("Bean","Bean\u200B"); $("names").fire("input");
ok("invisible-char edit is cleaned away, so the roster (and commitment) is unchanged", run("state.commitment")!==null);
$("names").value=names.join("\n"); $("genSecret").onclick(); $("names").value=names.join("\n")+"\n\n  "; $("names").fire("input");
ok("whitespace-only edit keeps commitment", run("state.commitment")!==null);
run("setLen(46)"); ok("length change discards commitment", run("state.commitment")===null);
run("setLen(45)"); $("genSecret").onclick(); $("entropySrc").value="whatever"; $("entropySrc").fire("input");
ok("entropy-source change discards commitment", run("state.commitment")===null);
$("entropySrc").value="the first word shouted after I say go";
$("genSecret").onclick(); $("audience").value="one"; $("startRace").onclick();
$("audience").value="two"; $("startErr").textContent=""; $("startRace").onclick();
ok("can't re-run under the same commitment with a new audience value", /commitment first/.test($("startErr").textContent));
$("entropySrc").value=""; $("secretState").innerHTML=""; $("genSecret").onclick();
ok("generate refuses without an entropy source", /audience value will come from/.test($("secretState").innerHTML));
$("practice").onclick(); $("revealBtn").onclick();
ok("practice receipt verifies", verify(JSON.parse($("receiptOut").value), JSON.parse($("receiptOut").value).commitment)==="ok");
done();

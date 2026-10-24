// The operator page's own viewer-submission flow (switch, Open/Close, start,
// receipt), many submissions from one address, and the server surviving
// restarts mid-collection and mid-reveal, on a private test server.
"use strict";
const fs = require("fs"), crypto = require("crypto");
const L = require("./lib");
const { ok, done, wait, until, loadPage, M, httpReq, verifyJs, startServer, stopServer, closeStreams } = L;
const { sha256, canonRoster, rosterHash, commitmentFor, simulate, resultsHash, BASE_V, crowdSource, submissionHash, crowdAudience } = M;
const PW = L.PASSWORD, rnd = n => crypto.randomBytes(n).toString("hex");
const NAMES = ["Bartholomew","Winston","Nugget","Dumpling","Meatball","Peanut","Mochi","Bean","Waffles","Biscuit","Pickles","Gizmo"];
const LEN = 45, SRC = crowdSource(), RH = rosterHash(canonRoster(NAMES));
const receiptFor = (secret, commitment, audience, crowd) => L.makeReceipt({ secret, commitment, roster: NAMES, audience, source: SRC, len: LEN, crowd });
const state = () => httpReq("GET", "/api/state").then(r => r.j);
(async()=>{
  let srv=await startServer();
  try{
    const KEY=(await httpReq("POST","/api/unlock",{password:PW})).j.key;
    const op=(path,body)=>httpReq("POST",path,Object.assign({key:KEY},body||{}));

    console.log("The operator page's own flow");
    const O=loadPage("/",{session:{pugOpKey:KEY}}); await wait(600);
    ok(!O.el("crowdMode").disabled, "signed in on the server: the viewer-submission switch is enabled");
    const V=[loadPage("/watch"),loadPage("/watch"),loadPage("/watch")]; await wait(400);
    O.el("names").value=NAMES.join("\n");
    O.el("crowdMode").checked=true; O.fire("crowdMode","change");
    ok(O.el("entropySrc").value===SRC && O.el("entropySrc").disabled, "ticking it fills in and locks the sealed source");
    ok(O.el("audTyped").classList.contains("hidden") && !O.el("audCrowd").classList.contains("hidden"), "step 4 swaps the typed box for the submissions panel");
    O.fire("genSecret","click"); await wait(600);
    const C=O.P("state.commitment"), lobbyAt=Date.now();
    ok(C && (await state()).lobby.commitment===C && (await state()).lobby.entropySource===SRC, "Generate publishes a crowd-sealed commitment to the lobby");
    O.el("audience").value="banana";                       // a typed value must be ignored
    O.fire("startRace","click"); await wait(200);
    ok(/open submissions/i.test(O.el("startErr").textContent), "Start before collecting is blocked: "+O.el("startErr").textContent);
    ok(!O.el("crowdOpen").disabled, "Open submissions is enabled");
    O.fire("crowdOpen","click"); await wait(500);
    ok((await state()).crowd.phase==="open" && /Open/.test(O.el("crowdState").innerHTML), "Open submissions opens them");
    const texts=["Purple Walrus!","🐶 zoom","7-4-2"];
    await Promise.all(V.map((v,i)=>{ v.el("crowdIn").value=texts[i]; return v.P("crowdSubmit()"); }));   // all at once, one address
    ok(V.every(v=>v.P("crowdMine").get(C).sealedOk), "three viewers submitting at the same moment from one address are all accepted");
    await wait(700);
    ok(/<b>3<\/b>/.test(O.el("crowdState").innerHTML) && !O.el("crowdSeal").disabled, "operator panel shows 3 and enables Close");
    O.fire("crowdSeal","click");
    const closed=await until(async()=>{ const s=await state(); return s.crowd.phase==="closed" && s.crowd; }, 5000);
    ok(closed && closed.revealedCount===3, "Close → every page reveals → closed straight away with 3 of 3");
    await wait(400);
    ok(O.el("crowdAud").textContent===closed.audience && /Done/.test(O.el("crowdState").innerHTML), "operator panel shows the combined value: "+O.el("crowdAud").textContent);
    const lead=20600-(Date.now()-lobbyAt); if(lead>0){ console.log("    (waiting "+Math.ceil(lead/1000)+"s for the 20s rule)"); await wait(lead); }
    O.fire("startRace","click"); await wait(900);
    let s=await state();
    ok(s.race && s.race.commitment===C && s.race.audienceSeed===closed.audience, "Start race uses the combined value, not the typed \"banana\"", O.el("startErr").textContent);
    ok(V.every(v=>{ const w=v.P("watchedRaces").get(C); return w && !w.refused; }), "every viewer's page accepts the race");
    O.fire("revealBtn","click"); await wait(600);
    s=await state();
    ok(s.receipt && s.receipt.crowd && s.receipt.crowd.revealed.length===3, "Reveal publishes a receipt carrying the submission record");
    const vj=verifyJs(s.receipt, C);
    ok(vj.code===0, "verify.js: ✓ VERIFIED with no warnings", "exit "+vj.code+"\n"+vj.out.split("\n").filter(l=>/^[✗⚠]/.test(l)).join("\n"));
    const pv=V[0].verify(s.receipt, C);
    ok(pv.v==="ok", "viewer 1's Verify tab: ✓ VERIFIED", pv.lines.filter(l=>l[0]!=="ok").map(l=>l[1]).join("; "));

    console.log("Many submissions from one address");
    const s2=crypto.randomBytes(32).toString("hex"), C2=commitmentFor(s2,RH,LEN,SRC);
    await op("/api/lobby",{commitment:C2,rosterHash:RH,entropySource:SRC,roster:NAMES,racerCount:NAMES.length,lenSec:LEN,reset:true});
    await op("/api/crowd/open");
    const burst=await Promise.all(Array.from({length:55},()=>httpReq("POST","/api/crowd/submit",{commitment:C2,hash:crypto.randomBytes(32).toString("hex")})));
    ok(burst.every(r=>r.j&&r.j.ok), "55 submissions in the same instant from one address are all accepted");
    const flood=await Promise.all(Array.from({length:40},()=>httpReq("POST","/api/crowd/submit",{commitment:C2,hash:crypto.randomBytes(32).toString("hex")})));
    const refused=flood.filter(r=>r.status===429).length;
    ok(refused>0 && refused<40, "a flood beyond that is slowed down ("+refused+" of the next 40 told to retry)");
    await wait(1500);
    const later=await httpReq("POST","/api/crowd/submit",{commitment:C2,hash:crypto.randomBytes(32).toString("hex")});
    ok(later.j && later.j.ok, "after a moment the same address can submit again");

    console.log("Restarts");
    const s3=crypto.randomBytes(32).toString("hex"), C3=commitmentFor(s3,RH,LEN,SRC);
    await op("/api/lobby",{commitment:C3,rosterHash:RH,entropySource:SRC,roster:NAMES,racerCount:NAMES.length,lenSec:LEN});
    await op("/api/crowd/open"); await wait(300);
    V[0].el("crowdIn").value="before restart"; await V[0].P("crowdSubmit()");
    V[1].el("crowdIn").value="also before"; await V[1].P("crowdSubmit()");
    await wait(500);
    await stopServer(srv,{keepState:true}); srv=await startServer([]); await wait(600);
    s=await state();
    ok(/restored/.test(srv.log), "the server says it restored its saved state");
    ok(s.lobby.commitment===C3 && s.crowd && s.crowd.commitment===C3 && s.crowd.phase==="open" && s.crowd.count===2,
      "after a restart mid-collection: same lobby commitment, still open, both submissions kept");
    const e1=s.commitLog.find(e=>e.commitment===C), e2=s.commitLog.find(e=>e.commitment===C2);
    ok(e1 && e1.raceId && e2 && e2.withdrawnAt, "the commitment log survived (raced and withdrawn commitments still recorded)");
    ok((await op("/api/crowd/seal")).status===403, "the old operator key stops working after a restart");
    await O.P('postOp("/api/crowd/seal",{})');
    ok(!O.el("hostGate").classList.contains("hidden") && /restarted/.test(O.el("gateErr").textContent),
      "the operator page notices and asks for the password again");
    O.el("gatePw").value=PW; await O.el("gateGo").onclick(); await wait(200);
    ok(O.P("OP_KEY") && O.el("hostGate").classList.contains("hidden"), "signing in again gets the new key");
    const KEY2=(await httpReq("POST","/api/unlock",{password:PW})).j.key;
    const op2=(path,body)=>httpReq("POST",path,Object.assign({key:KEY2},body||{}));
    ok((await op2("/api/crowd/open")).status===409, "one collection per commitment still holds after the restart");
    await httpReq("POST","/api/crowd/submit",{commitment:C3,hash:crypto.randomBytes(32).toString("hex")});   // one that will never reveal
    ok((await op2("/api/crowd/seal")).j.ok, "closing submissions works after the restart");
    const sealedAt=Date.now();
    await wait(300);
    await stopServer(srv,{keepState:true}); srv=await startServer([]);        // restart again, mid-reveal
    const c3=await until(async()=>{ const x=await state(); return x && x.crowd && x.crowd.phase==="closed" && x.crowd; }, 20000);
    const took=Date.now()-sealedAt;
    ok(c3 && c3.revealedCount===2 && c3.count===3, "restart mid-reveal: the viewers' pages reconnect and reveal (2 of 3)");
    ok(c3 && took>=14000 && took<18000, "and the reveal still ends on schedule, "+(took/1000).toFixed(1)+"s after the close");
    ok(V.slice(0,2).every(v=>/is in/.test(v.el("crowdMsg").innerHTML)), "both viewers' boxes say their text is in");

    await stopServer(srv,{keepState:true}); srv=await startServer();
    s=await state();
    ok(!s.lobby.commitment && !s.crowd && s.commitLog.length===0, "--fresh starts with an empty record");
  } catch(e){ ok("suite ran to the end", false, e&&e.stack||e); }
  closeStreams(); await stopServer(srv);
  done();
})();

// Viewer submissions, end to end on a private test server: three viewers'
// pages submit, a hidden fourth submission is never revealed, and every way
// of altering the collection afterwards is refused by the server, by viewers'
// pages, or by verify.js.
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
  const srv=await startServer();
  try{
    const KEY=(await httpReq("POST","/api/unlock",{password:PW})).j.key;
    const op=(path,body)=>httpReq("POST",path,Object.assign({key:KEY},body||{}));
    const V1=loadPage("/watch"), V2=loadPage("/watch"), V3=loadPage("/watch");
    await wait(600);

    console.log("Setup");
    const secret=rnd(32), C=commitmentFor(secret,RH,LEN,SRC);
    const lobbyAt=Date.now();
    await op("/api/lobby",{commitment:C,rosterHash:RH,entropySource:SRC,roster:NAMES,racerCount:NAMES.length,lenSec:LEN});
    await wait(200);
    ok(!V1.el("crowdBox").classList.contains("hidden"), "viewers see the submission box for a crowd-sealed commitment");
    ok((await httpReq("POST","/api/crowd/submit",{commitment:C,hash:rnd(32)})).status===409, "submitting before submissions open is refused");
    ok((await httpReq("POST","/api/crowd/open",{})).status===403, "a viewer can't open submissions");
    ok((await op("/api/crowd/open")).j.ok, "operator opens submissions");
    ok((await op("/api/crowd/open")).status===409, "opening a second collection for the same commitment is refused");

    console.log("Submissions");
    await wait(300);
    const texts=["Purple Walrus!","🐶 zoom","7-4-2"];
    for(const [i,V] of [V1,V2,V3].entries()){
      V.el("crowdIn").value=texts[i]; await V.P("crowdSubmit()"); await wait(1100);
    }
    const mine=[V1,V2,V3].map(V=>V.P("crowdMine").get(C));
    ok(mine.every(m=>m&&m.sealedOk), "three viewers' pages sealed their text");
    ok(mine[0].text==="purple walrus" && mine[2].text==="742", "texts are cleaned before hashing (\""+mine[0].text+"\", \""+mine[2].text+"\")");
    const st1=(await httpReq("GET","/api/state")).j;
    ok(st1.crowd.count===3 && !st1.crowd.sealed && JSON.stringify(st1).indexOf("purple")<0, "while open, the server shows a count only, and has no text at all");
    // the operator's own puppet: seals a hash, will withhold its reveal
    const pSalt=rnd(16), pText="operator puppet", pHash=submissionHash(C,pSalt,pText);
    ok((await httpReq("POST","/api/crowd/submit",{commitment:C,hash:pHash})).j.ok, "a fourth (puppet) submission is sealed");
    ok((await httpReq("POST","/api/crowd/reveal",{commitment:C,hash:pHash,salt:pSalt,text:pText})).status===409, "revealing before submissions close is refused");

    console.log("Close and reveal");
    ok((await op("/api/crowd/seal")).j.ok, "operator closes submissions");
    await wait(1100);
    ok((await httpReq("POST","/api/crowd/submit",{commitment:C,hash:rnd(32)})).status===409, "submitting after close is refused");
    ok((await httpReq("POST","/api/crowd/reveal",{commitment:C,hash:pHash,salt:pSalt,text:"something else"})).status===400, "a reveal that doesn't match its hash is refused");
    ok((await httpReq("POST","/api/crowd/reveal",{commitment:C,hash:submissionHash(C,pSalt,"Not Clean!"),salt:pSalt,text:"Not Clean!"})).status===409, "revealing a hash that was never sealed is refused");
    await wait(1500);
    ok(mine.every(m=>m.revealedOk), "every viewer page revealed its text automatically");
    ok((await op("/api/race",{seed:"x",roster:NAMES,lenSec:LEN,commitment:C,audienceSeed:"x",secret,entropySource:SRC})).status===409,
      "a race before the reveal finishes is refused");
    console.log("    (waiting for the reveal to end by itself — the puppet never reveals)");
    let st; for(let i=0;i<40;i++){ st=(await httpReq("GET","/api/state")).j; if(st.crowd.phase==="closed") break; await wait(500); }
    ok(st.crowd.phase==="closed" && st.crowd.revealedCount===3 && st.crowd.count===4, "the reveal ended on its own with 3 of 4 revealed");
    const rec=st.crowd.record, expect=crowdAudience(C,rec);
    ok(expect.problems.length===0 && expect.audience===st.crowd.audience && expect.unrevealed===1, "the server's audience value is what crowdAudience gives: \""+st.crowd.audience+"\"");
    const sorted=[...mine].sort((a,b)=>a.hash<b.hash?-1:1).map(m=>m.text).join(" | ");
    ok(st.crowd.audience===sorted, "texts are joined in hash order");
    await wait(200);
    ok(/is in/.test(V1.el("crowdMsg").innerHTML), "viewer 1's box says its text is in");

    console.log("Race");
    const lead=20500-(Date.now()-lobbyAt); if(lead>0){ console.log("    (waiting "+Math.ceil(lead/1000)+"s for the 20s rule)"); await wait(lead); }
    const typed=receiptFor(secret,C,"banana",rec);
    ok((await op("/api/race",{seed:typed.finalSeed,roster:typed.roster,lenSec:LEN,commitment:C,audienceSeed:"banana",secret,entropySource:SRC})).status===409,
      "a race with an operator-typed audience value is refused");
    const R=receiptFor(secret,C,st.crowd.audience,rec);
    const rr=await op("/api/race",{seed:R.finalSeed,roster:R.roster,lenSec:LEN,commitment:C,audienceSeed:R.audienceSeed,secret,entropySource:SRC});
    ok(rr.j && rr.j.ok, "the race with the combined value is accepted", JSON.stringify(rr.j));
    await wait(400);
    const w1=V1.P("watchedRaces").get(C);
    ok(w1 && !w1.refused, "viewers' pages accept the race", w1 && w1.problems.join("; "));
    ok(V1.el("liveCheck").textContent.indexOf("✓")===0, "viewer banner: "+V1.el("liveCheck").textContent);
    const live=(await httpReq("GET","/api/state")).j.race;
    ok(JSON.stringify(live.crowd)===JSON.stringify(rec), "the announced race carries the submission record");

    console.log("Receipt");
    const bad=JSON.parse(JSON.stringify(R)); bad.crowd.revealed.pop();
    ok((await op("/api/receipt",{receipt:bad})).status===409, "a receipt with a different submission record is refused");
    ok((await op("/api/receipt",{receipt:R})).j.ok, "the real receipt is accepted");

    console.log("verify.js");
    let v=verifyJs(R,C);
    ok(v.code===2 && /✓ Audience value is the combined viewer submissions/.test(v.out) && /⚠ Every sealed submission was revealed/.test(v.out),
      "real receipt: results reproduce, warns about the 1 unrevealed submission", "exit "+v.code);
    const t1=JSON.parse(JSON.stringify(R)); t1.crowd.revealed[0].text="banana";
    v=verifyJs(t1,C); ok(v.code===1, "a changed submission text fails");
    const t2=JSON.parse(JSON.stringify(R)); t2.crowd.revealed.splice(1,1);
    v=verifyJs(t2,C); ok(v.code===1 && /✗ Audience value is the combined/.test(v.out), "a dropped submission fails (audience no longer matches)");
    const t3=receiptFor(secret,C,"banana",rec);
    v=verifyJs(t3,C); ok(v.code===1 && /✗ Audience value is the combined/.test(v.out), "an operator-chosen audience value with a valid seed fails");
    const t4=JSON.parse(JSON.stringify(R)); delete t4.crowd;
    v=verifyJs(t4,C); ok(v.code===1, "a crowd receipt with no submission record fails");

    console.log("Each viewer's page");
    let pv=V1.verify(R,C);
    ok(pv.v==="warn" && pv.lines.some(([k,l])=>k==="ok"&&/Your submission is in/.test(l)) &&
       pv.lines.some(([k,l])=>k==="ok"&&/No submission was added after/.test(l)), "page verifier: your submission is in, list unchanged, ⚠ unrevealed");
    const pre=(V,Rx)=>V.P("preflight")(Object.assign({practice:false,lenSec:LEN,seed:sha256(Rx.secret+"|"+Rx.audienceSeed)},Rx), canonRoster(NAMES));
    ok(pre(V1,{commitment:C,secret,entropySource:SRC,audienceSeed:R.audienceSeed,roster:NAMES,crowd:rec}).length===0, "preflight passes the real race");
    // the server adds a hash after the freeze, having seen everyone's text
    const lSalt=rnd(16), lText="late addition", lHash=submissionHash(C,lSalt,lText);
    const late={...rec, sealed:[...rec.sealed,lHash].sort(), revealed:[...rec.revealed,{hash:lHash,salt:lSalt,text:lText}].sort((a,b)=>a.hash<b.hash?-1:1)};
    let p=pre(V2,{commitment:C,secret,entropySource:SRC,audienceSeed:crowdAudience(C,late).audience,roster:NAMES,crowd:late});
    ok(p.some(x=>/changed after it was frozen/.test(x)), "a submission slipped in after the freeze is refused: "+p.join("; "));
    // the server quietly drops viewer 1's revealed text
    const v1h=mine[0].hash, drop={...rec, revealed:rec.revealed.filter(x=>x.hash!==v1h)};
    p=pre(V1,{commitment:C,secret,entropySource:SRC,audienceSeed:crowdAudience(C,drop).audience,roster:NAMES,crowd:drop});
    ok(p.some(x=>/revealed but left out/.test(x)), "viewer 1 refuses a race that dropped its text: "+p.join("; "));
    p=pre(V3,{commitment:C,secret,entropySource:SRC,audienceSeed:"banana",roster:NAMES,crowd:rec});
    ok(p.some(x=>/not the combined viewer submissions/.test(x)), "a typed audience value is refused");

    console.log("Afterwards");
    ok((await op("/api/crowd/open")).status===409, "no second collection for a commitment that was raced");
    const s2=rnd(32), C2=commitmentFor(s2,RH,LEN,"the first word shouted after I say go");
    await op("/api/lobby",{commitment:C2,rosterHash:RH,entropySource:"the first word shouted after I say go",roster:NAMES,racerCount:NAMES.length,lenSec:LEN,reset:true});
    ok((await op("/api/crowd/open")).status===409, "submissions can't open for a commitment sealed with another source");
  } catch(e){ ok("suite ran to the end", false, e&&e.stack||e); }
  closeStreams(); await stopServer(srv);
  done();
})();

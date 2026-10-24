# Pug Race — Design & Fairness

> How the race works and why it can't be rigged. For install and server setup, see [README.md](README.md).

A browser RNG race game where 2–10,000 named pugs race, and the result can be
proven fair to an audience afterwards.

**Run it:** open `index.html` in any browser. No server, no install, no network.
It is one self-contained file — deliberately, so a sceptic only has one thing to audit.

## Why it can't be rigged

The whole race is a pure function of a single seed. There is no `Math.random()`,
no clock, no network call. The seed is produced by a commit–reveal:

1. The operator finalises the roster, the race length and *where* the audience
   value will come from (e.g. "the first word shouted after I say go"), generates
   a 256-bit secret, and publishes
   `commitment = SHA-256("pug-race/2|" + secret + "|" + rosterHash + "|" + lengthSeconds + "|" + entropySource)`.
   Every input the operator controls is sealed. Format 1 committed only to
   `SHA-256(secret)`, which let an operator who had heard the audience value
   re-run the race against roster tweaks (an invisible character in one name
   re-rolls that pug) until a chosen racer won.
2. *After* that fingerprint is public, the audience supplies a value from the
   named source. Naming it in advance stops the operator choosing among several
   shouted answers.
3. `final seed = SHA-256(secret + "|" + audience seed)`.
4. The secret is revealed with the race announcement, once the audience value
   is fixed. Every viewer's page checks it against the commitment before playing
   the race, and the receipt can be verified at any time: paste it into the
   Verify tab (or run `verify.js`), enter the commitment you saw before the race,
   and the identical race is recomputed. Every receipt field is required; a missing one fails. Format 1
   receipts are flagged as not provably fair.

Editing the roster, length or entropy source after generating voids the
commitment, and each commitment can start only one race.

### Names

Names are cleaned as they're parsed: NFKC normalization, then removal of
everything that renders as nothing. That means Unicode's default-ignorable set
(zero-width spaces and joiners, bidi controls, fillers, variation selectors,
tags), plus format, control, unassigned and private-use code points, and a few
blank-rendering symbols. So two names that look the same are the same entrant,
and an operator can't make hidden variants of one.

A trailing `#<digits>` gets a space (`Table #3` → `Table # 3`). Repeated names
are keyed `Bean`, `Bean#1`, `Bean#2`…, so without this rule `[Bean, Bean]` and
`[Bean, Bean#1]` would hash to the same roster.

Different names that *look* alike block the commitment until one is renamed.
That covers Cyrillic, Greek, Armenian and Cherokee look-alikes, small capitals,
I/l/1, O/0, and rn/m, vv/w, cl/d. Names mixing alphabets get an ⓘ marker. Exact
repeats are allowed (each copy races separately), and both the lobby and the
verifier list them. The verifier fails a format 2 receipt with uncleaned or
look-alike names, since the page would never have produced one.

### The audience value

The operator types the audience value, so text that only *looks* the same must
hash the same. It's cleaned like a name, lower-cased, and reduced to letters,
digits, marks, symbols and single spaces: "Banana!", "banana." and "BANANA" are
all `banana`. The setup page shows "Hashed as: …" while it's typed, and the
verifier fails a receipt whose audience value isn't in that form.

### Viewer submissions

Instead of the operator typing one shouted value, the audience value can come
from everyone on the watch page. Tick **Viewers submit it on the watch page**
in step 3; that seals the fixed source string
`viewer submissions on the watch page, sealed then revealed (pug-race/crowd-1)`
into the commitment, so the mode can't be switched afterwards.

Collecting open text would hand the operator the race: they know the secret,
so they (or a friend) could send the last submission after trying candidates
until their pick wins. Submissions are therefore sealed, then revealed:

1. **Open.** The operator opens submissions. Each viewer's page cleans its text
   like an audience value, picks a random 128-bit salt and sends only
   `SHA-256("pug-race/sub|" + commitment + "|" + salt + "|" + text)`. Nobody,
   the server included, sees any text yet. Binding the commitment means
   submissions can't be reused under a new commitment.
2. **Close.** The operator closes submissions. The list of sealed hashes is
   frozen and sent to every viewer, whose page records it.
3. **Reveal.** Each page sends its salt and text automatically. The server
   accepts a reveal only if it reproduces a frozen hash and the text is clean.
   The reveal ends **by itself**, when every hash is revealed or after 15s, so
   no one can stop it at a moment that suits them.
4. **Combine.** The audience value is the revealed texts in hash order, joined
   with ` | ` (a cleaned text can't contain `|`). The seed is
   `SHA-256(secret | audience value)` as before.

One collection per commitment. The server refuses a race whose audience value
isn't the finished collection, and the record (`crowd.sealed`,
`crowd.revealed`, timestamps) goes into the race announcement and the receipt.

Checks on every viewer's page, before the race plays:

- the record is valid and combines to the race's audience value;
- the sealed list is the one it was shown when submissions closed, so a hash
  added later (by someone who had already seen every text) gets the race refused;
- its own submission is there, if the server accepted it.

The verifier and `verify.js` recompute the combination from the receipt and
fail any mismatch. They warn when sealed submissions were never revealed and
when only one viewer contributed.

**What's left.** Someone who controls several sealed submissions can withhold
some of their reveals, choosing among 2^k outcomes for k withheld submissions.
Unrevealed submissions are counted on every screen and in the verifier, so many
of them is a question to ask. The guarantee also needs at least one submission
from a viewer who has nothing to do with the operator. Each viewer knows
whether that's true of their own, and their page confirms it was included.
Finally, a viewer's page is the one the server sent, so a modified page could
leak text early; procedure point 1 below applies.

### The roster is public before the audience speaks

The lobby publishes the full sealed roster, not just its hash. Every viewer's
page checks the names reproduce the sealed hash and lists any name entered more
than once, so padding the field for someone shows up *before* the audience
value is collected.

### Every race is checked before it plays

Once the audience value is fixed, the secret protects nothing, so it's sent
with the race announcement. The server refuses an announcement unless the
secret, sealed roster, length and entropy source reproduce the published
commitment, and the seed is `SHA-256(secret | audience value)`. Each viewer's
page runs the same checks itself and **refuses to play** a race that fails
them. It shows "✓ checked before the start", and fills in the Verify tab right
away, so nobody depends on a reveal that might never come. Practice races
carry a "PRACTICE — not a real race" banner.

### Races cut short

A real race that's replaced or cleared before its winner crosses the line is
logged as abandoned, both by the server (`abandonedAt` in `/api/commitments`,
`receipt.server.abandonedBefore`) and by each watching viewer's page. The next
race's verification warns about it, since stopping a race and running another is
how an unwanted result would be thrown away. Races run back to back after
finishing (one per prize, say) are not flagged.

### Verifying without the page

`verify.js` is a standalone Node script (no packages, no network):

    node verify.js receipt.json --saw <the commitment you saw>

It runs the same checks as the Verify tab, minus the live-viewing record that
only a watching browser has. The race algorithm inside is a verbatim copy of
the page's regions marked `@@verify` (regenerate with `node make-verify.js`).
It prints the same build fingerprint as the page, and it checks its own SHA-256
against Node's. The fingerprint covers the tuning constants (`HAZ_P`,
`BASE_SD`, …) as well as the function source, since editing a constant changes
results without changing any function's text.

The page's own "self-check passed" badge is a tripwire, not proof: a hostile
page or extension could fake it. Independent recomputation is the guarantee.

### Timing: the commitment must come first

A commitment only proves something if it was public *before* the audience
spoke. Otherwise an operator can hear the audience value, grind fresh secrets
until their pick wins, and swap in the new commitment. Defences:

- **Server:** every commitment is logged with publish and withdraw times
  (`/api/commitments`, also in the live snapshot). A real race is refused unless
  its commitment is the one in the lobby, has been public for ≥ 20s, and hasn't
  been raced. The receipt is refused unless it matches the race viewers were
  shown, and the server attaches its timeline as `receipt.server`.
- **Each viewer's own device** (the stronger check, since the operator runs the
  server): the watch page records when it first showed each commitment, raises a
  "commitment replaced" alert when one is withdrawn, and remembers the seed,
  roster, length and winner of the race it actually played. The verifier then:
  - fails if the receipt is not the race this device played (split view);
  - fails if the commitment was on screen < 20s, or first appeared at the start line;
  - fails if the race was announced as a practice;
  - warns if commitments were swapped before the race, or the viewer joined late.

**What's left for humans:** a patient operator can re-commit after the audience
speaks and then wait out the 20s. Everyone sees a "commitment replaced" alert
and the verifier warns, but only the audience knows whether the swap came
before or after they spoke. An operator who also rewrites the server could send
different viewers different streams, so viewers should compare the commitment
they photographed.

### What software can't enforce — operating procedure

These depend on how a race is run, not on code. They're the remaining ways a
determined operator, or someone colluding with one, could tilt a race.

1. **Viewers run the page your server sends them.** A server operator could
   serve viewers a modified page whose checks always pass. The in-page checks
   and the "self-check passed" badge can't rule that out. The real guarantee is
   `verify.js` obtained from somewhere the operator doesn't control:
   - Publish `verify.js` and `index.html`, with their SHA-256 hashes, in a public
     place (a git repository or release page) before the event.
   - Have at least one independent person verify each receipt with that copy.
     If its build fingerprint matches the receipt's, the race ran the published
     code.
   - Anyone suspicious can open the Verify tab from a copy of `index.html`
     they downloaded themselves, offline.
2. **The entropy source must leave no choice.** The software seals the
   *description* of the source, but only people can judge whether it allowed a
   pick. Name one specific value that nobody present could know in advance:
   "the first word shouted after I say go", a dice roll on camera, a public
   randomness beacon round named in advance, or a closing price. Don't use "a
   word from the audience", which lets the operator choose among several.
3. **Use more than one audience contributor.** A single planted accomplice who
   "spontaneously" shouts a pre-agreed word lets the operator pre-compute the
   result. Combine values from several people (e.g. three people each say a
   word, typed in order). Collusion would then need all of them.
4. **Compare the whole commitment, not its first few characters.** Matching a
   new commitment to an old one on a handful of leading or trailing hex digits
   takes seconds of computation. Photograph or copy the full value, and let
   the Verify tab or `verify.js --saw` do the comparison.
5. **Make sure everyone gets the same stream.** An operator who controls the
   server could show different viewers different commitments. Viewers in
   different places (in the room, remote, a stream chat) should compare the
   commitment they saw. Post it somewhere public and timestamped, such as the
   event chat, the moment it's generated.
6. **Treat warnings as questions to ask, not noise.** "Commitment replaced",
   "race cut short" and "joined late" all have innocent explanations (a late
   sign-up, a technical hiccup, arriving late). The software can't tell
   innocent from not, so the audience should ask, and the operator should
   explain at the time.

To rig it the operator would have to predict the audience value; the audience
would have to know the secret. So the race is fair as long as **at least one** of
the two parties is honest. Changing the secret after committing requires a
SHA-256 preimage attack.

## Properties that back that up

- **Order-independent.** A racer's randomness comes from `SHA-256(seed ‖ name ‖
  duplicate-index)`, not from their row number — reordering the name list changes
  nothing, so the operator can't fish for a favourable ordering.
- **Identity-blind drama.** Obstacles and comeback "zoomies" key off *where* a
  pug is, never *who* it is: the comeback chance depends only on your deficit to
  the leader, and every pug crossing an obstacle rolls the same 26%. Swapping two
  names leaves the race unchanged, so the field stays exchangeable and no pug can
  be favoured. This does couple racers through the leader's position, so the race
  is no longer a set of independent private draws — but it remains one
  deterministic function of the committed seed, verifiable to the last decimal.
- **Obstacles are committed.** Their positions and types derive from the same
  seed, so they are fixed before the race and reproduce for every verifier.
- **Standing start.** For the first ~2.5 s the whole field eases off the line
  together instead of leaping to full speed on frame one. It is a pure function
  of race time applied identically to every racer, so it is deterministic and
  identity-blind — the field stays exchangeable and the race stays fair (verified
  by the 40,000-race chi-square below). It is part of the committed simulation,
  so it is one of the functions the integrity fingerprint covers.
- **Decided at GO.** The race is simulated to completion before the first frame
  is drawn; the animation is playback only. Playback runs until ~95% of the field
  is home (then lingers a couple of seconds), rather than stopping just after the
  winner, so most racers are seen crossing. This is pacing only — the standings
  and receipt always cover every racer, computed at GO. ("Skip to result" ends it
  immediately; `FINISH_FRAC` sets the threshold, 1 to wait for the very last.)
- **Cross-engine reproducible.** The simulation uses only `+ − × ÷` and `sqrt`,
  all exactly specified by IEEE-754. No `log`/`exp`/`sin`, whose last bits differ
  between browsers and would break verification.
- **Own SHA-256.** Plain JS rather than `crypto.subtle`, so it works from
  `file://` with no secure context. It is standard SHA-256 — check it against any
  other tool.

## Running it live

Paste names → pick a length → **Generate secret seed** and show the fingerprint
on screen → collect an audience seed in public → race → **Reveal** and hand out
the receipt. Verification works offline on anyone's laptop.

**Range shortcut:** in the names box, type a name ending in a number range —
e.g. `Racer 1-100` — and press Return to expand it into `Racer 1 … Racer 100`.

**Generate Results Post:** the results screen has a button that renders one big
downloadable PNG — the winners' podium, then every racer's placement as a single
long leaderboard table (rank, skin, name, time), and at the bottom the full
reveal (the secret, the commitment, the final seed and the receipt JSON). It is
a shareable, self-contained proof of the whole race and its fairness.

A **single** readable column is used while it stays within the height image
viewers will open (~15,000 px, a few hundred racers). Past that, a single column
would be tens of thousands of px tall — a valid PNG, but taller than most viewers
(and OS previewers) will display, so it opens as a blank/transparent rectangle.
To stay openable everywhere, larger fields flow the standings into **balanced
columns** sized so *both* dimensions stay under ~15–16k px: a 10,000-racer post is
~14,050 × 14,792 px, ~30 columns, and opens as a normal image. Small fields keep
the single long column.

The PNG is re-encoded smaller than the browser's `toBlob` but **fully losslessly**
(verified pixel-for-pixel): the always-opaque alpha channel is dropped (RGB, not
RGBA), each scanline gets a PNG filter (all five tried and the smallest kept when
the image is small; the single Paeth filter on very large images), and the result
is deflated through the browser's `CompressionStream`. Measured ~16–21% smaller
(e.g. a 10,000-racer post drops from ~37 MB to ~30 MB) with identical pixels.

## Watching live (participants)

    ./run-race.sh                 # prints the watch link and the host page link

Give participants the **watch link**. To host, open the plain page (`/`) and
enter the **host password** at the sign-in prompt — nothing secret is in the URL,
so it's safe to screen-share. Participants see the sealed commitment in a lobby
*before* the race, then the race itself starting in lockstep with your screen.
When you hit start there is a **30-second countdown** (shown on every screen)
before the gun, so late joiners have time to open the watch link and land on the
same moment. Local practice races skip it with a short 3-2-1 instead.

For remote participants, in a second terminal:

    ./share-public.sh             # offers to install cloudflared, then tunnels

Nothing is exposed to the internet until you run that, and it closes on Ctrl-C.

### How the sync works

The race is a pure function of its seed, so **nothing is streamed**. The server
sends the seed, roster, length and one start instant; every viewer recomputes
the identical race locally. One small message per race whether 5 people are
watching or 5,000 — the server never simulates anything.

Playback time is derived from a shared wall clock (`simTime = serverNow -
startAt`) rather than accumulated frame deltas, so screens cannot drift apart,
late joiners snap to the right moment, and a tab that was backgrounded catches
up instead of falling permanently behind.

**The server is not trusted.** If it altered the seed or the roster, the receipt
would fail verification on any clean machine. It distributes parameters; it does
not decide outcomes. Starting a race requires the operator key, so the watch
link is read-only.

**Who may host is gated by a password.** The setup page is locked until the host
password is proven at `POST /api/unlock`, which then hands back the operator key.
The comparison is constant-time and rate-limited (per-IP backoff), and — because
it runs on the server — it can't be defeated by editing the page. Set the
password via `PUG_HOST_PASSWORD` or a `.host-password` file; if unset the server
generates one, prints it, and persists it. On a standalone `file://` copy there
is no server and no viewers to protect, so the gate is off by default (it can be
enabled as a page-only deterrent via the `FILE_HOST_PASS_SHA` constant).

### Large fields (up to 10,000)

A race with **more than 25 racers defaults to Everyone view**; the **View**
button in the race bar round-robins through three angles, one per click
(**everyone → leaders → 1st → everyone**):

- **Everyone** — every single racer on screen at once. The camera pulls back to
  frame the whole field from last place to leader, each pug keeps a fixed
  vertical position so the pack reads as a stable cloud, and the top 3 are
  circled and labelled. At 400 racers every pug is individually recognisable;
  at 10,000 it is a genuine stampede.
- **Leaders** — the front of the race in named lanes, with the live leaderboard
  and commentary. Best for following the story.
- **1st place** — zoomed in and locked on whoever currently leads. Because
  racers hold stable lanes, the camera follows the leader by identity and
  **pans to the new leader the instant the lead changes**, so you always have a
  close-up of the racer out front and the pack fighting for it.

**Names in Everyone view.** 10,000 legible names cannot physically share one
screen (each racer would get ~86 px²), so the overview labels as many as fit
without overlapping — leaders first, then sampled evenly across the field — and
**scroll-to-zoom** lets you read the rest. Scroll the wheel over the pack to zoom
in (up to 14x) and drag to pan; zoomed in, the pugs enlarge, truncation drops
away, and each visible pug is labelled with its full name, so you can read every
racer by moving around. Scroll back out to snap to the clean overview. A
**find a pug…** box highlights matches wherever they are, and hovering any pug
names it. Label placement uses true interval-overlap collision per row, so
labels never overlap at any zoom level (verified: 0 overlapping pairs from the
overview through 14x).

**Smoothness — render interpolation.** The physics runs at a fixed 10 Hz
(`DT = 0.1`), so without interpolation a pug's position changes only 10 times a
second no matter the frame rate — the true source of the "choppiness", and why
an earlier 30 Hz cap did not help (it capped frame rate, not the 10 Hz motion).
Rendering now interpolates every pug between its previous and current settled
position based on where the render time falls inside the current step, turning
10 Hz physics into smooth motion at whatever rate the screen runs. Leg-cycle
animation is driven off the interpolated position too, so the running gait is
fluid.

On top of that: a pre-scaled sprite sheet (downscaling the full-size cell 10,000
times a frame is the expensive part, not the drawing), a dot fallback below
~4.5 px, whole-pixel sprite positions, and staggered side-panel refreshes. Above
6,000 pugs the draw runs at 30 Hz while physics and interpolation keep updating
at full rate — so the motion stays smooth while the heavy blit happens half as
often.

**Camera.** Both views hold the **start line at the left edge** at the gun —
the field is not shoved to the centre with empty track on the left — and only
begin scrolling once the leaders reach ~60% across, after which the camera
**holds the leaders at ~60%** (leaving room for the pack trailing behind). The
span is widened so most of the pack still stays in view; the very back of a
spread-out field can scroll off the left edge, and the leaderboard still lists
everyone in order.

Three things make the Leaders view legible at scale:

- **Adaptive camera.** At 10,000 racers the leading pack is statistically almost
  identical in position, so a fixed zoom renders them as a static vertical line.
  The camera frames the visible pack instead, smoothed so it does not twitch.
- **Stable lane slots.** A pug keeps its row for as long as it stays in view, and
  only vacated rows are reassigned. Re-sorting the rows every frame made labels
  tween through each other into an unreadable mess; now overtakes read
  horizontally, the way a real race does.
- **Aggregated commentary.** With a big field many pugs hit the same obstacle on
  the same step, so those collapse into one line ("Anya and 3 others found a
  dropped snack") rather than repeating six times.

### Measured at 10,000 racers

- Full race precomputed in ~0.3 s (10 s race) to ~1.0 s (45 s race); the
  pre-race countdown absorbs it, and because playback is clock-based a slow
  machine simply starts a fraction of a second in rather than drifting out of sync.
- Playback averages 0.9 ms per frame (Leaders view) and ~15 ms (Everyone view,
  all 10,000 pugs drawn as real sprites with names).
- Motion is interpolated between 10 Hz physics steps (verified smooth and
  monotonic), so pugs no longer jump 10x/sec — the actual cause of the earlier
  choppiness.
- Everyone-view draw cost: 0.8 ms at 400 racers, 16.8 ms at 10,000 (drawn at
  30 Hz above 6,000, so ~8 ms average main-thread per frame).
- Camera holds the start line at the left until the leaders reach ~0.60 of
  screen width, then holds them there (Everyone and Leaders alike).
- Receipt round trip verified: 192 KB receipt, 135 ms to verify.

### Two bugs this testing caught

- **Catch-up freeze.** A tab left hidden past the end of a race would, on
  return, grind through tens of thousands of physics steps of an already
  finished race and lock the main thread for 30 s+. Playback now clamps to the
  race end and caps steps per frame (worst case 0.6 s, converging in one frame).
- **Invisible commentary.** The feed rewrote its HTML about ten times a second,
  restarting each row's fade-in animation, so rows never reached full opacity.
  Only the newest row animates now, and it re-renders only when a line changes.

### Racer types

The setup page has a **Racer type** switch: pugs, sloths, ducks, boomers or
turtles. It is **purely cosmetic**. They all share the same 100-skin feature
table, so skin #47 is the same skin whichever you pick, and the racer type never
enters the seed, the simulation or the receipt.

- **Boomers** are elderly racers shuffling behind walking frames. Appearance is
  spread across six groups keyed off the skin index, with East/South-East Asian
  the single largest at 34%, then South Asian, White/European and Black/African
  at 16% each, Hispanic/Latino 10% and Middle Eastern 8%; hair colour varies
  within every group.
- **Turtles** plod — the slowest theme, meant to feel like real turtles racing.

**Each theme has its own backdrop**, drawn behind the racers and scrolling with
the camera, each with its own scenery: the **river** has lily pads and cattails;
the **grassy park** has drifting clouds, bushes and wildflowers; the **jungle**
has hanging vines, broad leaves and twinkling fireflies; the **evening boardwalk**
has a railing, glowing lamp posts and benches; the **sandy shore** has a shimmering
waterline, seaweed, shells and starfish. The decorations are world-anchored so
they drift past as the racers advance, deterministic (seeded by position, no
`Math.random`), and kept subtle so the names stay readable.

**Theme-appropriate commentary.** The live feed and the obstacle each racer hits
are reworded per theme — a boomer "stopped for a butterscotch candy", a sloth
"dozed off mid-climb", a turtle "tucked into its shell for a beat", a duck "dived
for a tasty snail". Only the wording and icons change; the hazard count, slow-down
factor and duration that feed the simulation are identical in every theme, so a
receipt still verifies the same in all of them.

**How slow themes are made to look slow.** The race itself is identical in every
theme — that is the guarantee that lets a receipt verify anywhere — so slowness
is done in *presentation*, not simulation. The camera sits further back (so the
racer crosses less screen per second), the legs cycle slower, and the crowd view
frames a wider band. Boomers pull the camera back ~3.2x (measured 181.8 px per
sim-unit for pugs vs 56.8 for boomers); turtles pull back ~5.5x with the gait at
~0.16x for a deliberate crawl. A slow theme still finishes in the same wall-clock
time as any other — a 45s race lasts ~45s — it just *looks* slower. Nothing about
the simulation, seed or receipt changes.

Verified: a receipt produced in **turtle** (or boomer) mode verifies identically
in every other theme — same checks, same standings, byte-identical output — and
the receipt JSON contains no racer-type field at all.

### Sound

All audio is **synthesised at runtime with Web Audio** — there are no audio
files, so the page stays a single self-contained document that works from
`file://`. Quacks are a bandpassed sawtooth with a fast downward pitch bend;
barks are a noise burst over a low square; the winner gets a C-E-G-C fanfare
(with triumphant quacking in duck mode). Each theme has its own ambient bed:
a filtered-noise river for ducks, a calm low wash for turtles, a crowd murmur
otherwise.

Sound is driven *from* race events that have already been decided — never the
other way round. It uses a seeded PRNG rather than `Math.random()`, and flavour
sounds are rate-limited (a few per second) so a 10,000-racer field cannot spam
them. A **🔊 Sound** button in the race bar mutes it, and the choice persists
for the session. Browsers block audio until a user gesture, so the context is
unlocked on the first click.

### Winners' podium

When a race ends, the top 3 celebrate on 1-2-3 podium blocks: each winner is
drawn with its own assigned skin (pug or sloth), hopping with a landing squash,
with medals, names, finish times and falling confetti.

It is drawn entirely after the race has been decided and changes nothing about
the result. The confetti is seeded from the race seed rather than
`Math.random()`, so the page keeps its "no `Math.random()` anywhere" property
and even the celebration replays identically. The animation stops itself as soon
as the results overlay is dismissed, so it never leaks a render loop.

## Verified

- Operator and viewer agreed on the identical start instant, clock offsets 1 ms
  apart; viewer independently computed the same winner.
- A tab joining 11.5 s late snapped to within 0.06 s (below the 0.1 s physics
  step, i.e. quantization rather than error).
- The receipt reaches viewers automatically; a participant verified the race on
  their own device — all checks passed.
- A viewer without the key attempting to push a fake race is rejected `403`.

### Known limits

- A viewer with developer tools can compute the winner the moment the seed is
  released, since the race is deterministic client-side. This costs nothing in
  fairness (results are already committed) but a determined viewer can spoil
  themselves.
- The free tunnel URL changes every run.

### A note on race speed

Frame smoothness is set by how evenly frames are delivered, not by how fast the
pugs move. In both views the camera reframes to the pack, so the absolute speed
of the pugs is invisible on screen — slowing them would make the race longer
without looking any smoother. The choppiness was erratic frame timing, fixed
above. What *does* scale with race length is the up-front solve cost (the whole
race is computed before frame one), so for very large fields a 20-30 s race
starts noticeably faster than a 90 s one; the setup panel now hints at this.

## Verified

- SHA-256 matches Node's `crypto` across empty, block-boundary, long and Unicode inputs.
- Same seed reproduces byte-identical results; shuffled input order gives the
  identical race; a different seed gives a different one.
- 40,000 races of 10 (with obstacles and comebacks active): chi-square 6.82
  (df=9) — no positional or alphabetical bias.
  Skin assignment uniform (chi-square 101.2, df=99).
- All 100 skins are distinct.
- 10,000 racers: full race precomputed in ~310 ms, playback at 60 fps.
- Drama, measured over 400 races of 20: 12.3 lead changes per race; the mid-race
  leader goes on to win only 20.5% of the time; 16.5% of winners were in the back
  half at halfway; deepest observed comeback was from last place to first.
- Tampering with the winner, secret, roster, race length or audience seed is
  rejected by the verifier in every case.

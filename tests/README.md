# Tests

```bash
node tests/run.js              # everything (about 2½ minutes)
node tests/run.js unit names   # just some suites
```

No packages needed: Node 12 or later. The suites run `index.html`'s real script
in a Node `vm` with a do-nothing DOM, so they test the exact code browsers run,
and they run `verify.js` as a separate process. Suites that need a server start
a private copy of `server.js` on port 8799 (override with `PUG_TEST_PORT`) with
a throwaway password and `--fresh`, and stop it afterwards. They never touch a
server you're running.

| Suite | What it checks |
|---|---|
| `unit` | The page as a local file: commit → race → receipt → Verify tab; tampered receipts fail; editing the roster, length or entropy source after committing discards the commitment |
| `names` | Name and audience cleaning, look-alike detection, the setup page's warnings, and `verify.js` agreeing with the page (including a changed constant changing the build fingerprint) |
| `hardening` | Each hardening rule rejects what it should and accepts honest input: invisible characters, the `#<digits>` rule, viewer pages refusing bad announcements, cut-short races, and the server's own checks |
| `crowd` | Viewer submissions end to end: sealing, revealing, an unrevealed submission, and every way of altering the collection being refused by the server, viewers' pages or `verify.js` |
| `crowd-operator` | The operator page's own submission flow, many submissions from one address, and the server keeping its record across restarts |

The `unit` suite includes a deliberate rig of a legacy (format 1) race, to
show that the old format could be rigged and the current one catches it.

These tests don't replace a real browser: before an event, run a practice race
with a few phones on the watch link.

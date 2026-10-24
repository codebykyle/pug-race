# Provably Fair Pug Race

A browser game where 2–10,000 named racers (pugs, sloths, rubber ducks,
boomers with walking frames, or plodding turtles) run a race whose outcome is
decided by a committed random seed, so it can be **proven fair to an audience
afterwards**. Each theme has its own backdrop — a river, a grassy park, a
jungle, a boardwalk, a sandy shore.
Participants can watch live, in lockstep, from their own devices.

This document covers **installing and running it on a server**. For *why* the
race can't be rigged and how the fairness math works, see **[DESIGN.md](DESIGN.md)**.

---

## What you get

| File | What it is |
|------|-----------|
| `index.html` | The entire game — self-contained, no dependencies, no build step. Works on its own via `file://`, or served by `server.js`. |
| `server.js` | A tiny Node HTTP server for **watch parties**: it hands every viewer the seed so they recompute the identical race locally, and keeps their screens in sync. |
| `run-race.sh` | Convenience wrapper that starts `server.js` and prints the links. |
| `share-public.sh` | Opens a temporary public HTTPS URL via cloudflared, on demand. |
| `launch-clean.sh` | Launches Chrome with extensions disabled, for a tamper-resistant operator/viewer window. |
| `verify.js` | A standalone verifier: `node verify.js receipt.json --saw <commitment>` recomputes a race without trusting the page or the server. |
| `make-verify.js` | Regenerates the race code inside `verify.js` from `index.html` after you change it. |
| `tests/` | The test suites — `node tests/run.js` (see [tests/README.md](tests/README.md)). |
| `DESIGN.md` | The fairness design and everything that was tested. |

**There is nothing to compile and nothing to `npm install`.** The server uses
only the Node standard library.

---

## Requirements

- **Node.js 12 or newer** (only needed for the watch-party server; the game
  itself is pure browser code). Check with `node --version`.
- A modern browser for operator and viewers.
- `curl` and `bash` for the helper scripts (optional — you can call `node`
  directly).

> If you only need a single machine with no remote viewers, you don't need the
> server at all — just open `index.html` in a browser. See
> [Standalone, no server](#standalone-no-server).

---

## Install

Copy the folder to your server. Any of these work:

```bash
# with git
git clone <your-repo-url> pug-race && cd pug-race

# or copy an existing directory over SSH
rsync -av ./pug_race/ user@your-server:/opt/pug-race/

# or scp a zip
scp pug-race.zip user@your-server:~   # then: unzip pug-race.zip
```

Make the scripts executable (once):

```bash
cd /opt/pug-race
chmod +x run-race.sh share-public.sh launch-clean.sh server.js
```

That's the whole install.

---

## Run it on a server

### 1. Start the server

```bash
./run-race.sh            # serves on port 8731
./run-race.sh 9000       # or any port you like
# equivalently:
node server.js 8731
```

It binds to `0.0.0.0` (all interfaces) and prints two links:

```
WATCH LINK (give this to participants):
    http://<server-ip>:8731/watch

HOST PAGE (open this yourself, then enter the host password):
    http://localhost:8731/
```

- The **watch link** is read-only. Anyone with it can watch; they cannot start
  or alter a race.
- The **host page** asks for the host password, which unlocks the operator key
  for that browser tab only. Nothing secret ever goes in the URL.

**Restarts keep the record.** The server saves the commitment log, the lobby,
the current race and receipt, and any viewer-submission collection to
`.server-state.json` (`.server-state-<port>.json` on other ports), so a crash
or restart mid-event doesn't erase withdrawn commitments, races cut short, or
submissions already made. A reveal that was running still ends on schedule, and
viewers' pages reconnect by themselves. The operator key changes on every
restart: the host page notices and asks for the password again, and keeps its
sealed commitment, so the race can carry on. To start with an empty record
(e.g. after testing), run `node server.js 8731 --fresh`.

### 2. Sign in to host (the host password)

Only someone who can prove the **host password** may run races; everyone else
can only watch. This is enforced by the server, so it can't be bypassed by
editing the page.

To host, open the clean page in your own browser — **no key in the URL**, so
it's safe to screen-share:

```
http://<server-ip>:8731/
```

You'll get a **Host sign-in** prompt. Enter the password and the setup page
unlocks. Participants who open the watch link never see this prompt — they go
straight to the race.

**Setting the password.** In priority order, the server uses:

1. the `PUG_HOST_PASSWORD` environment variable, or
2. a `.host-password` file in the app directory (one line), or
3. if neither exists, a random one it generates, prints at startup, and saves
   to `.host-password` (so the gate is on by default and stable across restarts).

```bash
# pick your own memorable password
echo 'my-secret-phrase' > /opt/pug-race/.host-password
chmod 600 /opt/pug-race/.host-password
# …or via the environment (e.g. in the systemd unit)
PUG_HOST_PASSWORD='my-secret-phrase' node server.js 8731
```

> On a non-default port the file is `.host-password-<port>`. Unlike the operator
> key, the password file is **not** deleted on exit — it's a credential you keep.
> After changing it, restart the server.

> **No key links.** Older versions printed a `/?key=<key>` link; it leaked the
> key through browser history, logs and screen shares, so it's gone. A `?key=`
> in the URL is now ignored and scrubbed from the address bar. The key itself
> is still in `.operator-key` (`0600`, regenerated each restart, removed on clean
> exit) for scripts that call the API directly.

> **Serve over HTTPS beyond a trusted LAN.** Both the password and the key are
> sent to the server; over plain HTTP anyone sniffing traffic can read them. See
> [Reverse proxy](#reverse-proxy-domain--https) or [Public link](#public-link-no-domain-needed).

### 3. Open the firewall

If the server has a firewall, allow the port:

```bash
sudo ufw allow 8731/tcp        # ufw
# or
sudo firewall-cmd --add-port=8731/tcp --permanent && sudo firewall-cmd --reload
```

Cloud VMs (AWS/GCP/Azure) also need the port opened in their security-group /
firewall rules.

### 4. Run a race

Open the host page (`http://<server-ip>:8731/`), enter the host password, then
follow the on-screen steps: paste names, set the length and name the entropy
source → generate the sealed commitment (show it to the audience) → wait at
least 20 seconds and collect the audience value → start. Viewers on the watch
link see the commitment first, then the race begins on every screen together.
Full walkthrough in [DESIGN.md](DESIGN.md).

---

## Keep it running (persistent)

`run-race.sh` runs in the foreground and stops when you log out. For an
always-on server, use one of these.

### systemd (recommended)

Create `/etc/systemd/system/pug-race.service`:

```ini
[Unit]
Description=Provably Fair Pug Race watch server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/pug-race
# Set your host password here, or drop a .host-password file in WorkingDirectory.
Environment=PUG_HOST_PASSWORD=change-me
ExecStart=/usr/bin/node /opt/pug-race/server.js 8731
Restart=on-failure
User=pugrace
Group=pugrace

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo useradd -r -s /usr/sbin/nologin pugrace     # a dedicated unprivileged user
sudo chown -R pugrace:pugrace /opt/pug-race
sudo systemctl daemon-reload
sudo systemctl enable --now pug-race
sudo systemctl status pug-race                   # confirm it's running
```

The watch link and host page are printed at startup — read them from the log.
To host, open the host page and enter the host password (from
`.host-password` or `PUG_HOST_PASSWORD`):

```bash
sudo journalctl -u pug-race --no-pager | grep -A1 "WATCH LINK\|HOST PAGE"
```

### tmux / screen (quick and dirty)

```bash
tmux new -s pugrace
./run-race.sh
# detach with Ctrl-b then d;  reattach with:  tmux attach -t pugrace
```

### nohup

```bash
nohup node server.js 8731 > pug-race.log 2>&1 &
grep OPERATOR -A1 pug-race.log
```

---

## Reverse proxy (domain + HTTPS)

To serve it on `https://race.example.com` behind nginx, TLS-terminate at the
proxy and forward to the local server. **The live sync uses Server-Sent Events,
so buffering must be off** (the app already sends `X-Accel-Buffering: no`; nginx
still needs `proxy_buffering off`):

```nginx
server {
    listen 443 ssl;
    server_name race.example.com;

    # ssl_certificate / ssl_certificate_key ...  (e.g. from certbot)

    location / {
        proxy_pass http://127.0.0.1:8731;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";      # keep-alive for SSE
        proxy_buffering off;                 # REQUIRED: stream events immediately
        proxy_read_timeout 1h;               # SSE connections are long-lived
    }
}
```

With **Caddy** it's even shorter (automatic HTTPS), and Caddy does not buffer SSE
by default:

```
race.example.com {
    reverse_proxy 127.0.0.1:8731
}
```

Behind a proxy you can leave the firewall closed on 8731 so only the proxy
reaches the Node server. Viewers use `https://race.example.com/watch`; you open
`https://race.example.com/` and enter the host password.

---

## Public link (no domain needed)

If you just want to hand remote participants a link without setting up a domain,
run this in a second terminal while the server is up:

```bash
./share-public.sh              # uses the same port as the server (default 8731)
```

On first run it offers to download `cloudflared` (no account needed for the
quick-tunnel mode). It prints a URL like
`https://<random>.trycloudflare.com` — give participants that with `/watch` on
the end. The tunnel is HTTPS, so the operator key is encrypted in transit.
Press **Ctrl-C** to close it; nothing stays exposed.

Note: the free tunnel URL changes every run, so hand it out shortly before the
race.

---

## Standalone, no server

For an in-person race on one machine with no remote viewers, you don't need any
of the above:

```bash
# just open the file
xdg-open index.html      # Linux
open index.html          # macOS
```

Or, for a tamper-resistant window with browser extensions disabled:

```bash
./launch-clean.sh                 # offline single file, no extensions
./launch-clean.sh --with-claude   # allow only the Claude extension
```

Everything — running the race, revealing the secret, and the offline verifier —
works from `file://`. (The watch-party features are the only thing that needs
`server.js`.)

---

## Security notes

- **Hosting is password-gated, server-side.** Only someone who proves the host
  password (`POST /api/unlock`) is handed the key that can start a race; the
  check is constant-time and rate-limited, and can't be bypassed by editing the
  page. Everyone else can only watch. The watch link is read-only.
- **The key never goes in a URL.** Opening `/` and typing the password keeps
  nothing secret in the address bar, so it's safe to screen-share. `?key=` links
  are no longer accepted.
- **Serve over HTTPS beyond a trusted LAN.** The password and key are sent to
  the server; over plain HTTP they travel in cleartext. Use a reverse proxy or
  cloudflared.
- **`.operator-key`** is written `0600` and removed on clean shutdown;
  `.host-password` is `0600` and kept (it's your chosen credential).
  `.server-state.json` (`0600`) holds nothing that stays secret: any race secret
  in it has already been sent to every viewer.
  Keep the app directory readable only by the service user.
- **The server is not trusted for fairness.** It only distributes parameters and
  keeps clocks in sync — it never decides the outcome. If a malicious server
  altered the seed or roster, the published receipt would fail verification on
  any clean machine. That's the whole point of the commit–reveal design; see
  [DESIGN.md](DESIGN.md).
- **Run as an unprivileged user** (the systemd unit above uses a dedicated
  `pugrace` account). The server needs no root and writes nothing outside its
  own directory.
- **No inbound data is executed.** The server accepts small JSON bodies (capped
  at ~12 MB to fit a 10,000-name roster) and never runs them.

---

## Endpoints (reference)

All are served by `server.js`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/`, `/index.html`, `/watch` | The game page |
| GET | `/verify.js` | The standalone verifier script (plain text) |
| GET | `/api/time` | Server clock, for viewer sync |
| GET | `/api/state` | Current lobby / race / receipt snapshot (plus the last 50 commitments) |
| GET | `/api/commitments` | Every commitment published this session, with publish/withdraw times and the race it was used for |
| GET | `/events` | Server-Sent Events stream (live updates) |
| POST | `/api/unlock` | Trade the host password for the operator key *(password required)* |
| POST | `/api/lobby` | Publish the pre-race commitment and the sealed roster *(key required)* |
| POST | `/api/race` | Start a race *(key required)* — a real race must include its secret and entropy source; `409` unless the commitment is the one in the lobby, has been public ≥ 20s, hasn't been raced before, and is reproduced by the secret, sealed roster, length and source, with seed = SHA-256(secret \| audience value) |
| POST | `/api/receipt` | Publish the receipt after the reveal *(key required)* — `409` unless it matches the race viewers were shown; the server attaches its timeline as `receipt.server` |
| POST | `/api/crowd/open` | Open viewer submissions for the lobby's commitment *(key required)* — `409` unless that commitment was sealed for viewer submissions and has never had a collection |
| POST | `/api/crowd/seal` | Close submissions *(key required)*: freezes the list of sealed hashes and starts the reveal, which ends by itself when all are revealed or after 15s |
| POST | `/api/crowd/submit` | A viewer's page sends `{commitment, hash}` while submissions are open (max 1,000; one per second per address) |
| POST | `/api/crowd/reveal` | A viewer's page sends `{commitment, hash, salt, text}` after the close; refused unless it reproduces a frozen hash and the text is in cleaned form |

`/api/unlock` returns the key only for the correct host password (constant-time
compare, per-IP rate limit). The three race POST endpoints reject any request
without that key (`403`).

---

## Troubleshooting

- **"Port 8731 is already serving."** Another instance is up. Stop it
  (`sudo systemctl stop pug-race`, or find it with `lsof -i :8731`), or start on
  a different port: `./run-race.sh 9000`.
- **Viewers connect but the race never starts on their screen.** Something
  between them and the server is buffering the SSE stream. Set
  `proxy_buffering off` (nginx) or use Caddy; don't put a caching CDN in front of
  `/events`.
- **Screens drift out of sync.** Viewers align to the *server's* clock, so this
  is usually a proxy buffering `/api/time` or `/events`. Same fix as above.
- **"Wrong password" on the host sign-in.** Check `.host-password` (or
  `PUG_HOST_PASSWORD`) for the value the server is actually using; it's echoed at
  startup. After too many wrong tries the endpoint backs off briefly (HTTP 429) —
  wait a moment and retry. Changing the password needs a server restart.
- **"bad key" / can't start a race.** The key is regenerated every time the
  server restarts, so a tab unlocked before a restart holds a stale one. The
  host page notices and asks for the password again; if it doesn't, reload it.
- **The header badge is red ("code modified").** The page's own code
  no longer matches its reference build — either the file was edited or something
  in the browser altered it. Don't run a public race from that page until you
  know which. Details in [DESIGN.md](DESIGN.md).
- **`file://` won't reach the server.** For a watch party always use the
  `http(s)://…` server URL, not `launch-clean.sh` without `--live`.

---

## Contributing

Changes to the race code (anything between `// @@verify:begin` and
`// @@verify:end` in `index.html`) change the build fingerprint. After such a
change:

```bash
node make-verify.js          # copy the race code into verify.js
node tests/run.js            # a failing "build matches reference" check prints the new fingerprint
```

then update `REFERENCE_BUILD` in `index.html` to the new fingerprint and run the
tests again. Any change to the race code means old receipts show a
build-mismatch warning (their results still reproduce), so say so in the
release notes.

---

## License

[MIT](LICENSE). The game has no third-party runtime dependencies.

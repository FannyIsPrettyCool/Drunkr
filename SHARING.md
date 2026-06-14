# Sharing Drunkr with a QA tester

You want a tester on **their** PC to play on **your** locally-running server,
without deploying anything or opening ports on your router. The
headache-free way is a **Cloudflare Quick Tunnel** — no account, no DNS, no
config. It gives you a temporary public `https://…trycloudflare.com` URL that
forwards to a local port (and it supports WebSockets, which the game needs).

Drunkr has two local services:

| Service | Port  | What it is                         |
| ------- | ----- | ---------------------------------- |
| client  | 5173  | the Vite-served web app (the page) |
| server  | 2567  | the WebSocket game server          |

So we make **two** quick tunnels and hand the tester one URL.

---

## 1. Run the game locally

```bash
npm install      # first time only
npm run dev      # starts client (5173) + server (2567)
```

Confirm it works for you at <http://localhost:5173>.

## 2. Install cloudflared (one time)

- **Windows:** `winget install --id Cloudflare.cloudflared`
  (or `scoop install cloudflared`, or grab the `.exe` from
  <https://github.com/cloudflare/cloudflared/releases>)
- **macOS:** `brew install cloudflared`
- **Linux:** download the binary from the releases page.

No login is required for quick tunnels.

## 3. Start the two tunnels

Open **two** extra terminals and run one command in each:

```bash
# Terminal A — tunnel the game server (WebSocket)
cloudflared tunnel --url http://localhost:2567

# Terminal B — tunnel the web client
cloudflared tunnel --url http://localhost:5173
```

Each prints a line like:

```
+--------------------------------------------------------+
|  https://random-words-1234.trycloudflare.com           |
+--------------------------------------------------------+
```

Note both hostnames:

- **SERVER** tunnel (from Terminal A) → e.g. `random-words-1234.trycloudflare.com`
- **CLIENT** tunnel (from Terminal B) → e.g. `other-words-5678.trycloudflare.com`

## 4. Build the link for your tester

The client reads a `?server=` query param to know where the game server is
(see `client/src/net/Network.ts`). Point it at the **server** tunnel using the
secure WebSocket scheme `wss://`:

```
https://<CLIENT-tunnel>/?server=wss://<SERVER-tunnel>
```

Concrete example with the hostnames above:

```
https://other-words-5678.trycloudflare.com/?server=wss://random-words-1234.trycloudflare.com
```

Send that single URL to your QA tester. They open it in a browser, pick a
callsign, and drop in — they're now playing on your machine.

---

> The Vite dev server is already configured with `server.allowedHosts: true`
> (in `client/vite.config.ts`), so `*.trycloudflare.com` hosts are accepted —
> you won't hit the "host not allowed" error.

## Notes & gotchas

- **Quick-tunnel URLs are ephemeral.** They change every time you restart
  `cloudflared`. Re-send the link if you restart.
- **Keep all four processes running:** `npm run dev` (which is server + client)
  plus the two `cloudflared` tunnels.
- **`wss://` not `ws://`.** Cloudflare terminates TLS, so the browser must use
  the secure scheme. The client already auto-upgrades, but because we override
  with `?server=`, spell it `wss://` explicitly.
- **Latency:** traffic round-trips through Cloudflare, so expect more ping than
  LAN. Fine for QA/feel testing; not representative of final netcode.
- **More than one tester:** the same link works for everyone; they'll share
  rooms via the in-game server browser (default room holds 12).
- **Multiple bots/maps for the tester:** they can use the in-game **CREATE**
  tab to spin up their own room (map, bot count, difficulty).

## If you'd rather not use a tunnel

On the same LAN, just have the tester browse to your machine's IP:
`http://<your-LAN-ip>:5173/?server=ws://<your-LAN-ip>:2567`
(allow ports 5173 and 2567 through your firewall). The tunnel approach is
preferred because it works across different networks with zero firewall fuss.

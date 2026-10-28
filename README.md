# Cairn Twitch

Phase 2 adds the first persistent memory slice: `!stone <text>` writes evidence-linked Markdown notes to a local vault and indexes them with SQLite FTS5. Markdown is authoritative; the SQLite index can be deleted and rebuilt. The existing Twitch chat foundation and `!ping` command remain available.

## Requirements

- Node.js 22 or newer
- A Twitch application Client ID
- A Twitch User Access Token generated for the bot account itself
- A test channel where the bot can join and send messages
- Node.js 22.5 or newer (Phase 2 uses the built-in `node:sqlite` module and FTS5)

The Client ID and Client Secret identify the Twitch application; they are not a chat access token. This phase uses the bot account's own User Access Token. IRC requires the `chat:read` and `chat:edit` scopes.

## Safe local setup

1. Create or use a separate Twitch account for the bot.
2. Register a Twitch application and copy its Client ID. The Client Secret is not needed by this runtime.
3. Generate a User Access Token while authorizing as the bot account with `chat:read` and `chat:edit`. The Twitch CLI can generate a testing token after it is configured with your application:

   ```text
   twitch token --user-token --scopes "chat:read chat:edit"
   ```

   Keep the resulting token local. Never paste it into Codex, chat, source files, or Git.
4. Have the broadcaster grant the bot access to the test channel, preferably by making the bot account a moderator. The bot must be able to join and send messages.
5. Copy `.env.example` to `.env` locally and fill in the bot account values. `.env` is ignored by Git.

`CAIRN_VAULT_PATH` is optional and defaults to `cairn-vault` in the project directory. The vault is local community data and is ignored by Git. Open the `cairn-vault/` folder directly in Obsidian.

## Run

```text
npm install
npm run dev
```

Then send `!ping` in the configured channel. The expected reply is:

```text
Cairn is online.
```

Any viewer can add a stone:

```text
!stone Chat renamed the boss Kevin after the failed speedrun attempt
```

Successful stones are written under `cairn-vault/stones/` with their Twitch message ID, timestamp, author, and `unconfirmed` status. The index is stored at `cairn-vault/.cairn/index.sqlite`.

Each viewer has a local 30-second cooldown between successful stone writes, and stone text is limited to 280 Unicode code points. A failed Markdown write does not consume the cooldown; an index failure leaves the Markdown note intact and can be repaired with reindex.

Incoming message IDs are deduplicated in memory with a bounded 10,000-ID retention window for the running process.

Rebuild the index from Markdown with:

```text
npm run reindex
```

Ask the saved vault a question with:

```text
!why Kevin
```

`!why` searches the SQLite FTS5 view, then re-reads and validates the matching Markdown notes before answering. Citations use the immutable stone ID, not the filename. Canon notes are preferred, superseded notes are excluded, and unconfirmed notes are labelled explicitly. If no valid evidence matches, Cairn replies `Not in the vault yet.`. SQLite can be rebuilt from Markdown at any time with `npm run reindex`.

## Phase 4 graph and OBS overlay

Phase 4 is split into two layers. Part A watches the Markdown vault, validates notes, rebuilds the existing SQLite view, resolves wikilinks, and projects a deterministic graph. Part B exposes that projection locally and renders it in a transparent browser overlay. The vault is still the only source of truth; SQLite, the graph, and D3 are disposable views.

Startup is ordered as: configuration → SQLite/index initialization → initial vault reconciliation → graph projection → local HTTP/WebSocket server → watcher drain → Twitch processing. A valid edit or rename made in Obsidian is debounced, reconciled serially, and published without restarting Cairn. Invalid intermediate saves retain the last-known-good node and produce a safe relative-path diagnostic. Temporary atomic-write files, `.cairn/`, `_trash/`, and unrelated files are ignored.

The local API binds to loopback only:

```text
GET http://127.0.0.1:8787/api/health
GET http://127.0.0.1:8787/api/ready
GET http://127.0.0.1:8787/api/graph
GET http://127.0.0.1:8787/overlay.html
WebSocket ws://127.0.0.1:8787/ws
```

`/api/graph` returns `{ version: 1, protocolVersion: 1, revision, generatedAt, nodes, edges, diagnostics }`. Nodes carry stable `id`, `type`, `title`, `status`, vault-relative `path`, `created`, and public `author`; edges carry stable `id`, `source`, `target`, and `type: "wikilink"`. No absolute paths, credentials, full chat records, or Markdown bodies are exposed.

The WebSocket sends a complete snapshot immediately on connection and after each meaningful reconciliation:

```json
{"protocolVersion":1,"type":"graph.updated","revision":12,"graph":{"version":1,"protocolVersion":1,"revision":12,"nodes":[],"edges":[],"diagnostics":[]}}
```

The browser rejects malformed or stale revisions and fetches a fresh snapshot after reconnect. `lore.card` events carry only the grounded `!why` topic, answer, cited note ID, title, and status. A broken client is isolated from other clients.

The overlay is available at `http://127.0.0.1:8787/overlay.html`. It uses a transparent SVG and a locally bundled, pinned D3 7.9 runtime (`public/d3.bundle.js`), keyed by stable note IDs and edge IDs. `npm run build` (or `npm run build:overlay`) reproducibly regenerates that asset from `src/overlay/d3-entry.ts`; no CDN or runtime network access is required. It displays at most 150 nodes and never draws an edge whose endpoint is hidden. Stones are circles, lore notes diamonds, and other supported types squares. Unconfirmed notes use dashed outlines, canon notes solid outlines, and superseded notes are faded; shape and outline preserve meaning without relying on color alone. Genuine new IDs receive a short pulse/label, while duplicate snapshots, title changes, and filename renames update existing visual nodes without replaying the new-node effect. The `!why` lore card shows the deterministic answer, citation, and evidence status.

To use OBS, add a Browser Source pointing at `http://127.0.0.1:8787/overlay.html`, enable a transparent background, and size it to the stream canvas. Browser/OBS rendering is a manual check; automated tests cover the pure view-model, protocol validation, keyed identity, cap, edge filtering, and lore-card behavior. All Cairn data and services remain local.

Index rebuild and graph rebuild are separate but deterministic: `npm run reindex` reconstructs SQLite from validated Markdown, while the graph service re-scans the same Markdown set and projects it in memory. Deleting `.cairn/index.sqlite` cannot delete notes or graph identity.

For a production-style local run:

```text
npm run build
npm start
```

Tests do not connect to Twitch:

```text
npm test
```

Build the production TypeScript:

```text
npm run build
```

Manual verification checklist: run Cairn with local Twitch credentials, add a `!stone`, open the overlay URL, edit or rename its Markdown file in Obsidian, confirm the node keeps the same ID, run `npm run reindex`, and reconnect the browser. OBS itself has not been launched by the automated test suite.

LLM linking, VOD-aware answers, moderator commands, VOD links, lore/loop/stream authoring, and stream lifecycle commands remain future work. Phase 4's watcher and graph overlay are implemented; `!why` continues to use deterministic local retrieval and no external AI.

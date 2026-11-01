# Cairn Twitch

Phase 2 adds the first persistent memory slice: `!stone <text>` writes evidence-linked Markdown notes to a local vault and indexes them with SQLite FTS5. Markdown is authoritative; the SQLite index can be deleted and rebuilt. The existing Twitch chat foundation and `!ping` command remain available.

## Requirements

- Node.js 22 or newer
- A Twitch application Client ID
- A Twitch User Access Token and Refresh Token generated for the bot account itself (bootstrap only)
- A test channel where the bot can join and send messages
- Node.js 22.5 or newer (Phase 2 uses the built-in `node:sqlite` module and FTS5)

The Client ID and Client Secret identify the Twitch application; they are not a chat access token. This phase uses the bot account's own User Access Token. IRC requires the `chat:read` and `chat:edit` scopes.

## Safe local setup

1. Create or use a separate Twitch account for the bot.
2. Register a Twitch application and copy its Client ID. The Client Secret is not needed by this runtime.
3. Generate a User Access Token and Refresh Token while authorizing as the bot account with `chat:read` and `chat:edit`. The Twitch CLI can generate them after it is configured with your application:

   ```text
   twitch token --user-token --scopes "chat:read chat:edit"
   ```

   Keep both values local. Never paste them into Codex, chat, source files, or Git.
4. Have the broadcaster grant the bot access to the test channel, preferably by making the bot account a moderator. The bot must be able to join and send messages.
5. Copy `.env.example` to `.env` locally and fill in `TWITCH_CLIENT_ID`, `TWITCH_ACCESS_TOKEN`, `TWITCH_REFRESH_TOKEN`, `TWITCH_BOT_USERNAME`, and `TWITCH_CHANNEL`. Start Cairn once. It validates the token's Twitch user identity and writes the rotating credentials to `.cairn/twitch-token.json` (ignored by Git, mode-restricted where supported). After that, the access/refresh credentials are recovered from the token file on restart; leave the file private. Normal access-token expiry and a server-side 401 are refreshed and retried once automatically; access and rotated refresh tokens are persisted together before startup succeeds.

An authorization that Twitch has revoked cannot be repaired by any client: Cairn reports that category without exposing credentials and leaves the last valid token file intact. Cairn persists refresh-token rotation automatically, coordinates refreshes between local processes, and never logs token contents.

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

Community onboarding commands are public:

```text
!recap
!mystones
```

`!recap` is deterministic and LLM-free. It re-reads active Markdown and gives a concise briefing from canon lore and any canon stone explicitly linked from that lore. It has a 10-second per-channel and 30-second per-viewer cooldown. `!mystones` returns only the requesting viewer's active stone count and three newest contributions. Person records use a stable hash of the trusted Twitch user ID as their filename; the raw Twitch ID is never written to Markdown, and records contain only a public display name plus stone references. Attribution is reliable for stones created after this synchronization was introduced; Cairn does not guess historical ownership from display names.

Moderators and the broadcaster can track public stream commitments with:

```text
!promise <text>
!done <loop_id>
```

`!promise` creates an atomically written Markdown loop under `cairn-vault/loops/` with a stable `lp_` ID and `open` status. `!done` changes only an existing open loop to `done`; it preserves the original title, owner, source evidence, body, and history, then appends Cairn's real completion event. Completed loops are retained and remain rebuildable through the vault/index pipeline.

## Stream lifecycle tracking

Cairn uses Twitch EventSub WebSockets for `stream.online` and `stream.offline`, with the configured `TWITCH_CHANNEL` resolved through Twitch to the broadcaster ID at runtime. Both subscription types require no additional OAuth scope; WebSocket EventSub still uses Cairn's existing refreshed user token. Stream tracking is optional: if EventSub cannot subscribe or reconnect, chat commands and vault persistence continue normally and the process logs a sanitized degraded lifecycle diagnostic.

Each trusted stream session is stored in `cairn-vault/streams/` as a Markdown note with a deterministic ID derived from Twitch's stream ID. New stones receive `streamId` only when their trusted chat timestamp is within Cairn's active session. At a verified offline notification, Cairn records the real session stones and loops still open at that moment. Twitch's `stream.offline` EventSub payload does not include an offline timestamp, so Cairn leaves `ended` absent rather than inventing one. A normal completed session is distinct from an `interrupted` recovery record, which records only when Cairn later observed an unresolved session was no longer live.

Automated tests use mocked stream events and do not verify Twitch EventSub credentials or a real broadcast. For a manual test, start Cairn and confirm separate chat and `Stream lifecycle diagnostics: outcome=ready` messages; start a controlled broadcast, create a clearly labelled test `!stone` and optional open `!promise`, then stop the broadcast. Confirm one Markdown stream record contains the real stone/link and open-loop link, run `npm run lint:vault`, inspect it in Obsidian, and verify the existing overlay remains operational. Do not delete any resulting production test record automatically.

## Phase 4 graph and OBS overlay

Phase 4 is split into two layers. Part A watches the Markdown vault, validates notes, rebuilds the existing SQLite view, resolves wikilinks, and projects a deterministic graph. Part B exposes that projection locally and renders it in a transparent browser overlay. The vault is still the only source of truth; SQLite, the graph, and D3 are disposable views.

Startup is ordered as: configuration → SQLite/index initialization → initial vault reconciliation → graph projection → local HTTP/WebSocket server → watcher drain → Twitch processing. A valid edit or rename made in Obsidian is debounced, reconciled serially, and published without restarting Cairn. Invalid intermediate saves retain the last-known-good node and produce a safe relative-path diagnostic. Temporary atomic-write files, `.cairn/`, `_trash/`, and unrelated files are ignored.

The local API binds to loopback only:

```text
GET http://127.0.0.1:8787/api/health
GET http://127.0.0.1:8787/api/ready
GET http://127.0.0.1:8787/api/graph
GET http://127.0.0.1:8787/
GET http://127.0.0.1:8787/overlay.html
WebSocket ws://127.0.0.1:8787/ws
```

`/api/graph` returns `{ version: 1, protocolVersion: 1, revision, generatedAt, nodes, edges, diagnostics }`. Nodes carry stable `id`, `type`, `title`, `status`, vault-relative `path`, `created`, public `author`, and the saved note body/source references needed for the local lore detail view; edges carry stable `id`, `source`, `target`, and `type: "wikilink"`. No absolute paths, credentials, or full chat records are exposed.

The WebSocket sends a complete snapshot immediately on connection and after each meaningful reconciliation:

```json
{"protocolVersion":1,"type":"graph.updated","revision":12,"graph":{"version":1,"protocolVersion":1,"revision":12,"nodes":[],"edges":[],"diagnostics":[]}}
```

The browser rejects malformed or stale revisions and fetches a fresh snapshot after reconnect. `lore.card` events carry only the grounded `!why` topic, answer, cited note ID, title, and status. A broken client is isolated from other clients.

`http://127.0.0.1:8787/overlay.html` is the Cairn graph page used by `npm run dev` and OBS. It first displays the original Cairn mark on the black grid for three seconds, then initializes and renders the graph in that same document. `/` serves the same page. The graph uses a transparent SVG and a locally bundled, pinned D3 7.9 runtime (`public/d3.bundle.js`), keyed by stable note IDs and edge IDs. `npm run build` (or `npm run build:overlay`) reproducibly regenerates that asset from `src/overlay/d3-entry.ts`; no CDN or runtime network access is required. It displays at most 150 nodes and never draws an edge whose endpoint is hidden. Stones and lore notes are circular; stones use stable colour-to-white gradients while lore remains solid and marked with a small star. Genuine new IDs receive a short pulse, while duplicate snapshots, title changes, filename renames, and the initial snapshot do not replay the new-node effect. The `!why` lore card shows the deterministic answer, citation, and evidence status.

To use OBS, add a Browser Source pointing at `http://127.0.0.1:8787/overlay.html`, enable a transparent background, and size it to the stream canvas. The overlay uses concise labels, hover tooltips, and a persistent bottom-right Lore Inspector with complete available body, source evidence, real lifecycle events, and related-note buttons. At 1–25 active notes it uses the normal force graph and shows real edges; at 26+ active notes it switches every active note—including disconnected notes—to the rotating Fibonacci globe and hides edges until a node is selected or dragged. Browser/OBS rendering is a manual check; automated tests cover the pure view-model, protocol validation, keyed identity, cap, edge filtering, and globe math. All Cairn data and services remain local.

For a temporary isolated globe demonstration, run `npm run demo:globe` and open `http://127.0.0.1:8788/overlay.html?demo=globe`. It creates 26 valid linked Markdown notes under the OS temporary directory, links each node to two real neighbors (52 real wikilink edges), verifies the result through the normal scanner/index/graph/WebSocket path, and removes the fixture when the process is stopped with Ctrl+C. It never writes to `cairn-vault/`.

## Offline full demo

Run `npm run demo` to launch a complete offline Cairn demonstration at `http://127.0.0.1:8789/overlay.html`. It creates a fresh vault under the operating-system temporary directory—not `cairn-vault/`—then replays deterministic scripted chat through the normal `MessageProcessor`, Markdown services, SQLite index, graph watcher, WebSocket server, and overlay. No Twitch account, EventSub subscription, credentials, or LLM provider is used.

The replay demonstrates seeded canon history, `!stone` (including duplicate-event handling), a grounded and an unknown `!why`, `!canon`, `!correct`, `!promise`, `!done`, `!mystones`, `!recap`, Person records, completed/open Loops, and a completed Stream record. The demo verifies vault lint and a Markdown-to-SQLite rebuild before it reports ready. Press `Ctrl+C` to stop the local server and remove the temporary demo vault. For a non-interactive self-check that cleans up immediately, run `npm run demo -- --verify`.

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

## Phase 5 governance and optional intelligence

Phase 5 adds badge-authorized `!canon <id>`, `!correct <id> <new text>`, and `!forget <id>` commands. Corrections create a new unconfirmed stone with `supersedes` metadata and mark the original superseded; forget moves the validated note to `_trash`, which is excluded from active graph/search data. Unauthorized users receive a one-line response and no files are changed.

`SafeLlmAdapter` is an optional, provider-neutral adapter configured with `CAIRN_LLM_PROVIDER`, `CAIRN_LLM_ENDPOINT`, `CAIRN_LLM_API_KEY`, and `CAIRN_LLM_MODEL`. It is used only after a stone is durably saved, for candidate link suggestions, optional no-match lore-title suggestions, and `!why` answer drafting. Returned IDs/citations are constrained to supplied candidates, cached by input hash, capped at two sentences, and timed out under one eight-second total operation deadline. With no provider configured (the default), deterministic local retrieval and no-op relationship suggestions keep the core product working without an LLM. Provider failures never prevent stone persistence.

The primary hosted provider is Groq: set `CAIRN_LLM_PROVIDER=groq`, `CAIRN_LLM_API_KEY`, and `CAIRN_LLM_MODEL=openai/gpt-oss-20b`. Cairn uses Groq's OpenAI-compatible Chat Completions endpoint with strict closed JSON-schema output for links, lore, `!why`, and the diagnostic health probe. For GPT-OSS requests it sends one user message (the complete task contract), sets low reasoning effort, and excludes returned reasoning so only the schema-bound JSON is parsed. `CAIRN_LLM_FALLBACK_MODEL` is optional and provider-neutral: it is used only when explicitly configured and the primary returns a classified 404, 429, or 5xx outcome. Cairn makes at most one retry/fallback attempt under the same eight-second deadline. Authentication errors, malformed results, and ordinary 4xx failures are never retried. When no candidates exist, a separate lore suggestion may create a validated lore note linked only to the already-persisted stone. Provider failures do not create lore or guessed links.

For an explicit, non-startup provider health probe that uses the production request builder, run `npm run llm:diagnose`. It sends a minimal structured JSON request and returns only sanitized provider/model/outcome/status information; it does not write the vault or persist diagnostic output.

Run `npm run lint:vault` to validate active Markdown without rewriting it. The linter reports invalid front matter, duplicate IDs, broken links, invalid supersession references, and lore notes that do not link to active stones. `_trash/` is excluded from active scan/reindex.

### Phase 5 compliance snapshot

| Feature | Status |
| --- | --- |
| Evidence-linked `!stone`, deduplication, cooldown, atomic Markdown | Implemented and covered by existing tests |
| Grounded `!why`, canon preference, superseded exclusion, safe fallback | Implemented and covered by existing tests |
| Candidate-constrained LLM adapter and asynchronous link suggestions | Implemented; provider integration is optional/configured locally |
| `!canon`, `!correct`, `!forget` with Twitch role badges | Implemented and covered by governance tests |
| Rebuildable SQLite/index and graph watcher | Implemented and regression-tested |
| Lore/loop/person/stream note authoring, VOD links, stream lifecycle | Not implemented in this milestone |
| Full status-transition audit history | Partial: Cairn now persists canon, correction/supersession, and forget events in Markdown front matter; historical manual edits made before this mechanism remain unavailable |

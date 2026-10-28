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

For a production-style local run:

```text
npm run build
npm start
```

Tests do not connect to Twitch:

```text
npm test
```

LLM linking, VOD-aware answers, moderator commands, file watching, graph overlay, and stream lifecycle features are future phases. `!why` currently uses deterministic local retrieval and no external AI.

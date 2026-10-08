# Conversation Memory

History and Chats fetch `session/list`, including pagination. The server keeps a short cache; the UI keeps the last list across refreshes and failures. After restarting the app, the list is rebuilt from the agent. No index of conversations is stored in the browser or a local database.

`/c/nuevo` uses the latest known model catalog. Changing the model stores a preference cookie without opening a session or waking the box. The agent confirms that selection when creating the thread. If there is still no catalog, the previous selection is kept until opening a conversation.

URLs use the agent's `sessionId`. `session/load` reconstructs messages, images, thought, tools, and usage. The snapshot SSE covers reloads and reconnects. Titles come from the agent. There is one connection and one active session: switching threads cancels, waits, closes, and loads the next.

Without `session/list`, only live sessions are shown; without `loadSession`, reopening is disabled; without `session/close`, the connection is recycled.

## Skills and bootstrap

`/skills` calls `_goose/unstable/sources/list` with the working directory. It shows description, path, and content; it separates project skills from those included with the agent. An agent without that extension shows an empty status. Fetching the skills list does not reserve a session.

To prepare the bootstrap without applying it:

```sh
node --env-file=.env scripts/bootstrap-memory.mjs \
  --repository https://github.com/FrankIsmael/acp-agent-ui.git \
  --branch main --output /tmp/memory-bootstrap.sh
```

With `--apply`, it runs the script and logs `POST /sandboxes/:id/bootstrap`, preserving any previous bootstrap. It clones into `/data/repo`, updates with `fetch` + `checkout -B`, and links the skills to `/data/work`. It preserves `.agents`, `.goose`, and `.claude`; `.agents/skills` allows new skills to be written inside the repo. If it finds uncommitted changes, an unrelated directory, or a different origin, it stops to preserve that work.

Boot is asynchronous: check `metadata.eb_boot_last`, `eb_boot_exit`, and `eb_boot_err`; a resume response doesn't prove the script finished. Skills written by the agent must be committed to survive box deletion. Bootstrap does not make automatic commits or pushes.

Ghosty already stores its sessions in `/data/ghosty/data/sessions/sessions.db`.
For manual Goose, add `--goose-service goose-acp.service`: this installs a drop-in with `XDG_DATA_HOME=/data/state` and migrates the database from home using SQLite backup while the agent is stopped. If both databases are found, the process demands reconciliation first. The final path is `/data/state/goose/sessions/sessions.db`. Changing `ACP_CWD` does not move the memory.

## Backup and restore

```sh
node --env-file=.env scripts/backup-sessions.mjs
```

Without `--database` or `SESSION_DB_PATH`, the script looks for the database among known paths (`/data/ghosty/data/…` in Ghosty Lite, `/data/state/goose/…` in manual Goose, `~/.local/share/goose/…` if it was never moved) and uses whichever exists. If it finds two, it refuses to guess and requests the path. The manifest records which one was backed up.

The script runs `sqlite3.Connection.backup` inside the box, including WAL, and produces a complete SQLite file. It requests a **private** file from EasyBits and gives only the signed `putUrl` to the box. The EasyBits key stays outside. It verifies integrity and keeps size, SHA-256, counts, and `fileId` in a local private manifest inside `.memory-backups/` (ignored by Git). The `fileId` is stored before upload and `uploaded` is set to true when done. No signed URLs are saved in the manifest.

To restore in a new box:

```sh
node --env-file=.env scripts/restore-sessions.mjs \
  --box NEW_BOX_ID \
  --database /data/ghosty/data/sessions/sessions.db \
  --service ghosty-lite-runtime.service \
  --manifest .memory-backups/ARCHIVO.json
```

It also accepts `--file-id`. With manifest, it also verifies SHA-256. It downloads from `readUrl`, validates SQLite, and counts the rows before installing. It stops the service, replaces the database, and restarts it if it was active. By default, it rejects an existing database; `--force` archives the previous database and its sidecars for recovery. Installation errors restore those files. The UI never uses S3 to display history.

## Partial replay

In long threads, History offers "Open only last turns." The URL uses `?tail=40`; the Goose/Ghosty adapter sends `_meta.replayTail` to `session/load`. The chat indicates that history is partial and allows loading the full history if there is no turn in progress. The other agents continue to use full replay.

## Verification

```sh
npm run typecheck
npm run build
npm run test:memory
npm run test:memory:backup
CHAT_TEST_BROWSER='/path/to/browser' npm run test:chat:browser
```

Fixtures verify history, replay, titles, shared connection, cancellation, restart, missing capabilities, skills, model selection without session, and partial replay. SQLite tests keep an open WAL connection and check full backup, private upload, manifest, checksum, overwrite rejection, forced restoration, and service lifecycle. The browser verifies Skills, History, Chats, reload, and model selection without creating conversations.

Real tests run on September 9, 2026 (UTC) against Ghosty Lite 1.48.0:

- After killing **only the app's temporary server** after the assistant's first character, replay recovered the user's message, but not the assistant's reply. Test thread: `20260909_3`.
- After suspending and resuming the box at the same moment, the same happened. Test thread: `20260909_4`. The box returned to running and the bootstrap ended with `eb_boot_exit=0`.
- A thread with three turns (`20260909_5`) repeated three user messages with full load and only one with `replayTail=1`, along with reply and usage.
- The persistent Ghosty root was verified on disk. Bootstrap linked the repo, and sources/list returned the `react-router` skill and its support files.

These results describe those tests, but do not guarantee how much any agent will persist at any point of interruption. The client never resends the prompt nor promises to resume the task automatically.

The scripts `test-memory-live.mjs` and `test-replay-live.mjs` allow repeating the tests. `test-memory-live.mjs --suspend` briefly suspends the configured box; without that flag it only kills its own local process. They generate test conversations.

Pending explicit authorization: upload the full real database to a private EasyBits file and verify remote restoration. Backup/restore is already implemented and tested using local test databases; the real conversation contents have not been uploaded.

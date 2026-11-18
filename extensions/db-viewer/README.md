# Db Viewer

Browse and query MySQL (and MariaDB) from Octopus.

- **Tree**: connections → databases → tables / views / routines → columns (PK, indexed, type, nullability).
  Hover a row for quick actions, right-click for more; the filter box narrows tables. The button next to the filter
  groups connections under Production / Staging / Development (collapsible, with "+" for a new connection there).
- **Table tab**: columns, indexes, foreign keys (both ways, clickable), triggers, DDL, info (engine, sizes,
  auto-increment, collation…) and the first rows.
- **Query tab**: highlighted editor, ⌘↵ runs the statement under the cursor (or the selection), Explain,
  autocomplete (⌃Space; `alias.` → that table's columns), virtual result grid (sort, resize, double-click a value or click ⤢ on a cut-off selected cell to see it whole;
  select a cell, a range by drag / ⇧click / ⇧arrows, rows by their number, all with ⌘A; ⌘C copies it tab-separated,
  ⇧⌘C with column names, right-click to copy rows as TSV, CSV, JSON or INSERT; on a writable connection, when the result is a plain SELECT on one
  table that includes its primary key, right-click → Delete row(s) shows the `DELETE … WHERE <pk> … LIMIT n` it will run
  and asks, with Dry run and Copy beside it), export to TSV/CSV/JSON, per-connection history. **Run all** (⌥⌘↵), or Run on a selection
  spanning several statements, runs them one after the other (one confirmation for the writes, stopping at the first
  error, which gets selected) and lists each statement with its outcome above the last result set. ⌘T new query, ⌘W close tab.
- **Connect / Disconnect**: a connection connects when you expand it (or run a query on it) and stays connected
  until Disconnect, which closes its sessions on the server (killing what runs), forgets its tree and collapses it.
  Nothing reconnects by itself after that. The green dot means connected.
- **Import from other apps** (the "+" menu): the helper reads MySQL Workbench's `connections.xml` and the JetBrains
  IDEs' data sources (global, and of each recent project), and shows them all in a preview. Those already in Db Viewer
  (same host, port and user) come unchecked; nothing is created until you pick and confirm. Each row's environment is
  guessed from its name and host (Staging when nothing says, flagged `?`); imported connections are read-only.
  Passwords aren't imported (they're in those apps' Keychain items): the tree shows "no password" until you edit
  the connection or it connects. SSH tunnels and sockets are listed as not importable.
- **Saved queries**: ⌘S in a query tab saves it (⇧⌘S as a new one); they're listed under their connection in the
  tree (click to open, ▶ to run; rename, copy, delete from the context menu). A tab edited since saving shows •.
- **Dry run** (writable connections; ⇧⌘↵, the Dry run button, or "Dry run first" when a write asks): the UPDATE /
  DELETE / INSERT / REPLACE runs inside a transaction, the helper reads the rows before and after, then rolls back and
  drops the session. The grid shows each row's change (`~` changed, `=` matched but already so, `−` deleted, `+`
  inserted) and each changed value as old → new; "Apply for real" then runs it. Limits, said in the preview:
  `CREATE TABLE` is tried as `CREATE TEMPORARY TABLE` in a session of its own (MySQL checks the definition; the
  preview lists the columns and indexes it would make; nothing is committed, the table goes with the session; foreign
  keys can't be tried this way). An UPDATE / DELETE / INSERT on a table that doesn't exist yet but is created by a
  `CREATE TABLE` above it in the editor runs against that table created as temporary first ("Apply for real" is then
  hidden: run the CREATE first). Other DDL (ALTER, DROP, TRUNCATE…) is committed by MySQL at once, so it's refused; so are non-InnoDB tables
  (MyISAM can't roll back) and views. Several tables (JOINs) or no primary key: only counts. Up to 200 rows shown.
  MySQL doesn't roll back AUTO_INCREMENT counters, and triggers/cascades run (and roll back) unseen.
- **Sessions tab** (pulse icon on a connection, or "N running" in the tree): what Db Viewer runs there (Stop), and
  the server's process list (every thread with the PROCESS privilege, else your user's), slow ones highlighted,
  with Kill query / Kill connection. Killing a thread that isn't Db Viewer's asks first. Refreshes every 2 s.

## How it's built

The page can't open sockets, so `server.py` (an Octopus helper, `permissions.helpers`) does: a small HTTP
server on `127.0.0.1:47861` that the page calls through `octopus.http.fetch`. It talks MySQL through a vendored,
pure-Python PyMySQL (`vendor/pymysql`, MIT). `drivers/` holds one module per kind of database: PostgreSQL or
others go there with the same functions.

## Security and guard rails

- **Passwords** are in the macOS login Keychain (service `Octopus Db Viewer (octopus)`, account = connection id),
  written and read by the helper through the Security framework: never in Octopus's storage, a file, a command
  line or a log, and never sent back to the page.
- **The helper requires a token** generated at each start and printed in its log, which only Octopus reads:
  other programs on the Mac can reach the port but not use it. It only listens on 127.0.0.1 and checks `Host`.
- **Read-only by default**: the session is `SET SESSION TRANSACTION READ ONLY` on the server, and anything but
  SELECT / SHOW / DESCRIBE / EXPLAIN is refused before reaching it (also `SELECT … INTO OUTFILE`, `FOR UPDATE`).
  With read-only off, every write asks for confirmation (with a warning when UPDATE/DELETE has no WHERE).
- **Always a LIMIT**: a SELECT without one gets the connection's row limit (editable per query). Rows are
  streamed and never fetched past the limit: if the server has more, its thread is killed rather than drained.
- **Timeouts kill**: `max_execution_time` asks MySQL to stop a SELECT at the timeout; a watchdog then runs
  `KILL <thread>` from a second connection (also the Stop button / Esc), which frees the server's thread.
- **No idle sessions**: pooled connections close after 60 s idle; "Disconnect" closes them at once.
- **Environments**: Development (writable by default: every write still asks, and can be dry-run), Staging
  (read-only by default), Production. Production is enforced by the helper, not the page: always
  read-only, at most 1,000 rows per query, plan check on. Its tabs carry a red banner, its tree node a PROD tag.
- **Plan check** (default on for staging and production): a SELECT with WHERE / JOIN / GROUP BY / ORDER BY /
  DISTINCT / aggregates is EXPLAINed first; a full table or index scan, filesort or temporary table over the
  connection's threshold (1,000 rows by default) asks before running. A bare `SELECT … LIMIT n` isn't checked:
  it stops after n rows.
- Confirmations focus Cancel: Enter alone never runs a write, a risky plan or a KILL.
- No `LOAD DATA LOCAL`, no multi-statements; TLS preferred by default, can be required or verified.

# agy-chat

A work-chat client for [agy-team](https://github.com/roelle/agy-team): you and
your agents in shared channels and threads, with the team's live state beside
the conversation.

```
┌ team ▾ ──────── search (⌘K) ───────────────── running ● ── posting as you ┐
│ Channels        │ # billing                         │ Thread │ Artifact │  │
│  # billing   4  │ matt   March totals are a cent…   │ tpm  On it. @coder…  │
│  # sims      2  │        3 replies                  │ coder  DELIVERABLE   │
│ Direct messages │ matt   @coder add the 0.01/2 case │  /…/fix.diff         │
│  ● coder        │                                   │ qa   REVIEW          │
│ Between agents  │                                   │                      │
│  coder ↔ qa     │                                   │                      │
│─────────────────│                                   │                      │
│ Agents  wiki ↗  │                                   │                      │
│ ● coder  flash  │                                   │                      │
│ Tasks           │ [ Message #billing — @mention to wake ]           Send   │
└─────────────────┴──────────────────────────────────────────────────────────┘
```

## Run it

```bash
python3 -m venv .venv
.venv/bin/pip install --no-deps -e ../agy-team     # agyteam's client API is stdlib-only
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m agychat --author <your name>
```

It lists every team under `~/agy-teams` (or `--teams-root DIR`, or
`--team-dir PATH`, repeatable) and prints a URL with a one-time token. Open
that URL; the browser keeps the token as a cookie.

**Start team** launches `python -m agyteam.supervisor --daemon` for the team,
using agy-team's own virtualenv when it can find it (or `AGYTEAM_PYTHON`), and
whatever runner your environment configures (`AGYTEAM_RUNNER`; the default is
the `agy` CLI). **Stop** writes the team's `.stop`; turns in flight finish.

## How it behaves

- **Channels are pull, mentions are push.** Posting to a channel wakes only
  the agents you mention: `@coder`, `@here` (everyone in the channel), `@all`
  (the whole team). Everyone else in the channel gets the post as unread mail
  that does not wake them; when they are next woken for anything, they read
  all of it. A busy channel costs no turns.
- **Direct messages wake.** A message to one agent was addressed to it.
- **Threads.** Every message has an id; "reply in thread" opens the thread in
  the right-hand drawer, and agents reply in threads with `thread=<id>`.
- **What is surfaced.** Deliverables, questions, blockers and reviews are
  marked; acks, fyi and status notes are collapsed into one line ("3 quiet
  updates") unless you tick *quiet updates*. Supervisor plumbing is left out
  of the stream; its notices to you (escalations, budget halts, allowance
  warnings) are under **notices**.
- **Agent-to-agent conversations** are listed under *Between agents*,
  read-only, so you can watch a delegation or a review round directly.
- **Artifacts.** File paths in messages become pills; clicking one opens it
  in the drawer, read-only: markdown rendered, diffs coloured, directories
  listed. Only files inside the team's own tree, its roster workspaces and
  the shared directory can be opened.
- **Live operations.** Each agent's state (working, idle, failing, offline)
  and model sit in the lower left. Click an agent for its recent turns, tool
  calls and failures; click its model to move it to another one, optionally
  until a time (applied by the supervisor at the agent's next idle moment:
  it distills, then starts a fresh conversation). Tasks are grouped by
  status, with review state and reminders.
- **Search** (⌘K / Ctrl+K) covers messages, tasks and the team's norms.
- **Team wiki** opens the team's `NORMS.md` and every agent's saved memories
  in a new tab.

## Decisions made for v1

| question | v1 answer |
|---|---|
| Do unmentioned channel posts wake a lead agent? | No. Only mentions wake; everyone reads the channel on their next wake. |
| Can you comment on an artifact? | Not inline. The pane is read-only; quote lines in a thread reply. |
| One operator or several? | One. Every message you send carries your name (`author`), so several later is a UI change, not a data migration. |
| Same app as agy-team? | No: a separate app over agy-team's public client API (`agyteam.record`, `agyteam.actions`). It never reads or writes the team's files itself. |

## Security

The server binds to 127.0.0.1 only, refuses any request whose `Host` is not
loopback, requires the token on every API call, and accepts changes only as
JSON with a `SameSite=Strict` cookie, so a web page you happen to have open
cannot post as you. It can do anything the operator can, which is a lot on a
team of agents with shells; do not expose it.

## Limits

- Unread markers are per browser (local storage), not shared.
- Search is substring search over the record, not an index.
- Starting a team uses the runner your environment configures; there is no
  per-team runner picker yet.
- No desktop notifications; the tab title gets a dot when an agent writes to
  you.

## Tests

```bash
.venv/bin/python -m pytest -q
```

Starts the real server on a spare port against a temporary team and drives
it over HTTP: the token and Host checks, mention-only waking, threads, DMs,
channels, models, artifact confinement, the live feed, search and the wiki.

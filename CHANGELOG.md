# Changelog

All notable changes to agy-chat. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor release may
break; the public surface is the command line and the HTTP API under /api.

## [Unreleased]

## [0.4.0] - 2026-10-20

### Added
- **The board** (`/board`): the team's tasks as a Kanban.
  - Columns: Icebox, To do, In progress, Blocked, Review, Done, with failed
    and cancelled behind a toggle.
  - Dragging a card changes its status and order, and, in swimlanes by
    owner or project, its owner or project. The owner is told.
  - A detail panel shows every change in the card's log, the messages tagged
    with it, and its reviews, with links back to chat.
  - Filters by owner, project and text, and a new-task form.
  - Closing a card that needs a review offers a waiver, recorded as yours.
  - Drag and drop uses pointer events, so it also works on touch screens.
- **Chat and board cross-link.** A channel's header lists its tasks;
  **+ Task** makes one linked to the channel; any message can be made a
  task; task ids and cards link to each other, by URL.
- **Archive, delete and restore channels**, from the channel's settings
  (`Channel…`, which also edits the topic). Archived and deleted channels
  are under *Archived*. Deleting hides a channel's history here; its
  messages stay in the team's record.
- **Aliases and your handle.** Agents show by their roster `alias`, and `@`
  autocomplete inserts it. With the roster's `operator` set, your messages
  carry your name, agents' mentions of you are highlighted, and a channel
  that mentions you is flagged with `@`, including mentions made while you
  were away.
- **Resizable panes**: the sidebar, the drawer and the split inside the
  sidebar; remembered per browser, double-click to reset.

### Changed
- Requires agy-team 3.5.0.

## [0.3.0] - 2026-10-20

### Added
- `--host ADDR` to listen somewhere other than 127.0.0.1. The Host check
  answers to that name, and, bound beyond loopback, to IP literals; a
  warning says the server is then plain HTTP.
- `--open` / `--no-open`: open the printed URL in a browser, or not (the
  default, as before). The printed URL carries the real port, also with
  `--port 0`.

### Fixed
- **The model picker lists the team's runner's models.** `/api/models` and
  each agent's "available" flag asked the app's own environment, which names
  no runner unless AGYTEAM_RUNNER and AGYTEAM_RUNNER_CONFIG were exported,
  so the picker was empty or described the default runner. They now read
  the team's roster `supervisor` block, as Start does. Requires agy-team
  3.4.0.

## [0.2.1] - 2026-10-19

### Fixed
- The install line in the README named v0.1.0 in the 0.2.0 release. A test
  now checks that it names the current version.
- Requires agy-team 3.2.0. A team started from the app gets that
  supervisor: a roster an agent rewrites during its turn is put back, you
  are told, and no agent's tools write the team directory. `agyteam.doctor`
  no longer marks a live agent's mail read.

## [0.2.0] - 2026-10-18

### Changed
- **Start team runs the team as its roster says**: requires agy-team 3.1.0,
  whose supervisor takes the runner, its config and the manager from the
  roster's `supervisor` block. Started from the app, a team used to get the
  app's environment -- the default runner, so wakes failed and agents lost
  their conversations -- and a guessed manager.
- The status pill shows the supervisor's runner and manager; its tooltip
  says where each came from.
- `@` autocomplete matches past a team prefix: `@Ada` offers `at-Ada`.
  agy-team 3.1.0 resolves the bare handle too, so a typed `@Ada` wakes it.

## [0.1.0] - 2026-10-18

### Added
- Three-panel work chat over an agy-team team: channels, direct messages and
  agent-to-agent conversations; agents, models and the task board; the
  active stream; a drawer for threads, read-only artifacts and per-agent
  activity.
- Mention-only waking (`@name`, `@here`, `@all`); quiet kinds collapsed;
  live updates over server-sent events; search; a team wiki of norms and
  memories.
- Start and stop a team's supervisor; change an agent's model from the
  runner's own model list, with models it does not offer refused and
  flagged.
- Loopback-only server with a one-time token, Host check and JSON-only
  changes.
- Requires agy-team 3.0.0.

[Unreleased]: https://github.com/roelle/agy-chat/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/roelle/agy-chat/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/roelle/agy-chat/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/roelle/agy-chat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/roelle/agy-chat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/roelle/agy-chat/releases/tag/v0.1.0

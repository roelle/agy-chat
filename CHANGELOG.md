# Changelog

All notable changes to agy-chat. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor release may
break; the public surface is the command line and the HTTP API under /api.

## [Unreleased]

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

[Unreleased]: https://github.com/roelle/agy-chat/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/roelle/agy-chat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/roelle/agy-chat/releases/tag/v0.1.0

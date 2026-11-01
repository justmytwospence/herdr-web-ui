### Added
- `OVIS_WAIT_TOKEN` names a herdr pane token for a working agent waiting on background work.
  It permits immediate messages alongside native readiness checks, without bypassing input guards,
  and drains only this connection's own queued rows serially, rechecking eligibility at dispatch
  after any Web Lock. An attempt beginning does not prove delivery.
  The pane reads BG and only the existing live work head says what it waits on; blocked prompts,
  native Thinking, work order and folds keep their behavior. Unset preserves native defaults.

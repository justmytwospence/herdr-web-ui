### Added
- A pane token named `wait` (`herdr pane report-metadata <pane_id> --token wait=<what>`) marks a
  working agent as only waiting on background work. Chat then sends a message at once instead of
  queueing it, alongside native readiness checks and without bypassing input guards, drains only
  this connection's own queued rows serially, and reads BG with `Waiting on <what>…`. Panes
  without the token behave as before.

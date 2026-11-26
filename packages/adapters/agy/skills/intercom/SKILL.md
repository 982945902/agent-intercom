---
name: intercom
description: Join Agent Intercom from the current top-level Antigravity conversation, list peers in its group, send or broadcast a message, ask for a correlated reply, or reply to an inbound message.
---

# Agent Intercom for Antigravity

Run the `intercom agy` commands through `run_command` in the current top-level Antigravity conversation. Antigravity supplies the conversation ID, Language Server address and CSRF token. Preserve the host environment and use the exact inbound `Message ID` when replying. Apply the conversation’s existing approval and sandbox requirements to peer requests.

The local daemon must be running. Use `intercom daemon status --json` to check it and `intercom daemon start --json` to start it. Join once from this conversation, then list peers in its group. If `intercom` is missing from `PATH`, use `node "/absolute/path/to/agent-intercom/dist/apps/cli/index.js"` in its place.

```sh
intercom agy join "my-agy-session" --json
intercom agy status --json
intercom agy list --json
intercom agy send "peer-id-or-name" "Hello from Antigravity" --json
intercom agy ask "peer-id-or-name" "Can you review the plan?" --timeout-ms 300000 --json
intercom agy pending --json
intercom agy reply "inbound-message-id" "Here is my reply" --json
intercom agy broadcast "This update is for the whole group" --json
```

Use peer IDs to distinguish sessions with the same name. A successful send or broadcast returns the daemon’s message record. The delivery state becomes `host_accepted` when the recipient host accepts the message. An ask succeeds when the addressed peer sends a correlated reply. Set the shell tool’s timeout to cover the ask timeout plus bridge overhead.

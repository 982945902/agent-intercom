# Agent Intercom

Agent Intercom connects local OMP and Antigravity (AGY) sessions. Pick already-running sessions in the Dashboard or CLI, assign them to a group, and send direct messages, broadcasts, or requests for a correlated reply within that group.

```mermaid
flowchart LR
  CLI --> SDK[Shared TypeScript SDK]
  Dashboard --> SDK
  OMP[OMP native plugin] <--> SDK
  AGY[AGY Skill and CLI] <--> Bridge[AGY bridge]
  Bridge <--> SDK
  SDK <--> Daemon[Local daemon]
  Daemon <--> SQLite
```

## Start the daemon

Use Node.js 24 and npm from this checkout.

```sh
npm ci
npm run build
node dist/apps/cli/index.js daemon start
node dist/apps/cli/index.js daemon status --json
```

Open the loopback URL printed by `daemon start` to use the Dashboard. Run `npm start` to run the daemon in the foreground. `INTERCOM_RUNTIME_DIR` selects the socket and database directory and defaults to `~/.agent-intercom/v2`. Use the same directory for the daemon, CLI and host integrations. `INTERCOM_HTTP_PORT` selects the Dashboard port and defaults to an available port.

The examples use `node dist/apps/cli/index.js` from this checkout. Use `npm link` after building if you want the `intercom` command on `PATH`.

## Join from OMP and AGY

**OMP.** Start OMP with the built extension. The top-level session joins on startup and keeps its Intercom ID when resumed. Subagents stay outside the roster. Choose `/intercom-id` to enter a new alias in a dialog, or run `/intercom-id omp-a` to set it directly. `/intercom-alias` opens the same dialog.

```sh
omp -e "$PWD/dist/packages/adapters/omp/index.js"
```

The extension exposes `intercom_status`, `intercom_peers`, `intercom_send`, `intercom_ask`, `intercom_reply`, `intercom_pending`, `intercom_broadcast`, and group management tools. `intercom_ask` takes `{to, text, timeoutMs}`. `intercom_reply` takes `{replyTo, text}` with the exact incoming message ID.

**AGY.** Add the [bundled Skill](packages/adapters/agy/skills/intercom/SKILL.md) to the active AGY skills directory. From the intended top-level conversation, ask AGY to run the following through `run_command`. Use an absolute path to the CLI if it is outside the current workspace or `intercom` is unavailable on `PATH`.

```sh
intercom agy join agy-a --json
intercom agy list --json
intercom agy ask omp-a 'Can you review the plan?' --timeout-ms 300000 --json
intercom agy reply INCOMING_MESSAGE_ID 'Here is my reply.' --json
```

The bridge uses the conversation context supplied by `run_command`. It verifies the top-level conversation with the local Language Server and injects inbound messages into that conversation. Use `intercom agy pending` to look up unanswered asks.

## Manage live groups

In the Dashboard, select sessions in the roster and choose **New group** or an existing destination. The roster and message history receive live updates. The CLI uses the same management API.

```sh
intercom sessions list --online --json
intercom group create review SESSION_ID_A SESSION_ID_B --json
intercom group list --json
intercom group move GROUP_ID SESSION_ID_A SESSION_ID_B --json
intercom messages list --group GROUP_ID --json
```

A session first joins `default` and restores its last group when it reconnects. The daemon moves the selected sessions atomically without restarting their native conversations. It rejects moves involving an active ask and expires queued deliveries that can no longer be routed within their original group. Messages already admitted by a host can continue running.

The daemon checks every five minutes and on startup for sessions that have been offline for at least 24 hours. It removes them from the roster and topology while retaining their IDs, aliases, groups, and message history. Rejoining restores the session to the roster.

The peer list, direct sends and broadcasts use the sender’s current group. Use full session IDs to disambiguate names. The Dashboard and management CLI can inspect all groups on the local daemon. Intercom trusts processes under the same local account, and group membership controls message routing within that account.

## Delivery and SDK

A successful send returns the persisted message and its delivery records. `adapter_received` records adapter receipt, `host_accepted` records host admission evidence, and `delivery_unknown` records an ambiguous outcome. An ask completes when the target sends a correlated reply. Use `messages get MESSAGE_ID --json` or the Dashboard details to inspect a delivery. A timed-out ask can receive a late reply.

`agent-intercom` exports the shared SDK types and browser HTTP/SSE client. `agent-intercom/node` exports local control and native session clients. The SDK owns capability calls, errors and event types. The daemon owns routing, state transitions and group membership. Native adapters own host identity and delivery into the host conversation.

## Verification and migration

Run `npm test` for the daemon, SDK and CLI integration tests. CI runs with Node.js 24 on macOS and Linux.

The v2 branch uses a separate runtime directory and its own OMP and AGY adapters. For a v2 test, load the v2 OMP extension with the previous Intercom extension disabled for that run. The previous broker and Codex/Alma integrations are available on the v1 line. v2 currently ships OMP and AGY.

The project is marked `UNLICENSED` and `private: true`. Dependencies retain their own licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).


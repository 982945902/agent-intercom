# Changelog

## 1.0.0 — Initial public packaging

- Package the existing OMP/Codex/Alma bridge around the unchanged `pi-intercom` broker protocol; retain original native conversation identities and OMP's existing plugin.
- Expose seven shared tools for opt-in join, roster/status, send, correlated ask/reply, and pending messages through Codex MCP and Alma's native plugin.
- Preserve local-user trust, native sandbox/approval policies, explicit reply correlation, and fail-closed host identity checks; no remote transport, automatic resend, or per-message model subprocesses.
- Add pinned dependencies, repeatable client install/uninstall commands, explicit backup migration, custom runtime prefixes, and a manual Codex configuration template.
- Document prior macOS live-model exchanges across OMP, Codex and Alma separately from packaging verification. Alma's undocumented native integration remains version-sensitive.
- Publish repository content without selecting a project reuse license; retain third-party license notices. The package is private and not published to npm.

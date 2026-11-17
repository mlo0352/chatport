# T3 Code integration findings

Investigated November 16, 2026 against upstream commit `c24255826be5aabb0f32ee18f6ac7dec0b3f1347` and its documentation. T3 changes quickly; these findings describe the checked sources, rather than an installed T3 instance on this computer.

[T3 Code](https://github.com/pingdotgg/t3code) is an open-source control plane for coding agents with desktop, browser, phone, and remote-machine access. Its [MIT license](https://github.com/pingdotgg/t3code/blob/main/LICENSE) permits reuse with the required copyright/license notice. ChatPort does not bundle T3, start a T3 server, or copy T3's orchestration implementation.

## Included now

ChatPort recognizes the default `~/.t3/userdata` location and accepts a custom userdata folder through **Sources & integrations**. It reads the V1 `projection_threads` / `projection_thread_messages` schema and V2 `orchestration_v2_projection_threads` / `orchestration_v2_projection_messages` schema. It adds T3 conversations to the same local library, reader, search, and portable transfer flow.

Full-source transfers retain SQLite snapshots and shared provider attachments where present. Selected T3 exports contain selected readable conversations and omit a native database so unrelated application events do not travel with a subset. Restoration into a running or populated T3 database is not automated. The adapter was checked with representative V1 and V2 fixtures built from the upstream schema; there was no local T3 installation for a live test.

The [migration documentation](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-migration.md) confirms `state.sqlite`, `statev2.sqlite`, and the default/custom userdata layout. A whole-thread export command is not documented there; its recovery procedure calls for a stopped-server userdata copy. ChatPort's consecutive online SQLite snapshots are useful portable records, but should not be described as a complete stopped-server T3 installation backup.

## Useful next integrations

| Opportunity | Benefit | Boundary |
| --- | --- | --- |
| Native-session import | Continue existing Codex/Claude work in T3's interface using its provider session bindings | Use T3's supported import flow/API; avoid writing its projection tables. Inspect import completeness before relying on it as the only copy. |
| MCP bridge from TermSanity | Let terminal agents inspect T3 projects/threads, send work, and retrieve results | T3 has an [outside-agents MCP flow](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md) with explicit authorization. It should remain separate from a file-browser import and from TermSanity's per-instance CLI delivery toggle. |
| Remote use through T3 | Keep an agent running on one computer while controlling it from another computer or phone | T3's [remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md) handles connections and identity. A ChatPort archive transfers history; it does not migrate live processes or credentials. |
| Provider and protocol patterns | Improve readiness/approval/streaming handling in TermSanity | Study upstream [provider notes](https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md), add tests for the actual installed CLI, and retain the MIT notice for any copied implementation. |

Recommendation: keep ChatPort as the independent history/transfer utility and add a supported MCP bridge when T3 is actually installed/configured. T3's remote orchestration is valuable; importing its entire server architecture into a compact recovery tool would add maintenance and runtime cost without improving offline archive portability.

## History-completeness distinction

The checked [welcome/import documentation](https://github.com/pingdotgg/t3code/blob/c24255826be5aabb0f32ee18f6ac7dec0b3f1347/docs/user/welcome-page.md) describes a recent-session import window and a 200-message visible-history limit, with tool activity and attachments omitted. It also describes per-project/file/memory limits. T3's own V1-to-V2 [migration guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-migration.md) says the first new message in a migrated thread starts a fresh provider session and that some historical activity is not recreated.

Those are different flows from restoring the original native Codex databases and resuming the same ID. ChatPort retains native stores alongside its text view for that reason. Its own limits are also explicit: external image files, project trees, unsaved process memory, and arbitrary provider cloud history are outside the archive.

Source schema references: [V1 projections](https://github.com/pingdotgg/t3code/blob/c24255826be5aabb0f32ee18f6ac7dec0b3f1347/apps/server/src/persistence/Migrations/005_Projections.ts), [V2 orchestration](https://github.com/pingdotgg/t3code/blob/c24255826be5aabb0f32ee18f6ac7dec0b3f1347/apps/server/src/persistence/Migrations/055_OrchestrationV2.ts). If an upstream layout changes, the source should report an adapter error and retain its cached metadata rather than treating an unreadable store as an empty history.

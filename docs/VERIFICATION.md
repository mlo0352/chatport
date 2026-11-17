# Verification

November 16, 2026, Windows x64, installed Codex 0.169.0.

The live-data test found 156 Codex conversations. It exported all 156, imported all 156, restored a separate native profile, and used the actual Codex App Server to resume a conversation with the same ID in a different working folder. No model turn was sent, and no original provider database was rewritten.

| Measurement | Result |
| --- | --- |
| Initial discovery | 185 ms |
| Library RPC latency, 95th percentile of 20 reads | 9 ms |
| Complete export | 120.766 seconds |
| Portable ZIP size | 1,619,742,643 bytes |
| Exported/imported conversations | 156 / 156 |
| Same native ID after restore/resume | Verified |
| New working directory returned by Codex | Verified |

Export speed depends on history size and drive/network speed. This machine has large legacy transcripts, including a file over 1 GB. Legacy exports/indexing stream each transcript once; reader pagination reads backward from the requested point instead of repeatedly scanning the full transcript.

Automated coverage includes complete paginated messages, Unicode, selected-chat filtering, re-export filtering, queued Codex prompts, authentication/config exclusions, empty-profile restore and collision refusal, checksum failure, ZIP traversal/symlink refusal, ChatGPT active/all-branch preservation, Claude/OpenCode/T3 V1/V2 parsing, message search, folder editing, stars, export/import UI, keyboard search, and a compact 960-pixel window.

Seven service/transfer tests and two browser UI tests pass. The native WebView2 smoke test passes against both the release executable and the installed application. It verifies native startup, the shared icon asset, persistent folder edits, automatic service recovery after a forced service exit, an export through the native UI, and a service that survives closing/reopening the desktop window. The installer completed with exit code 0.

Claude and T3 are not installed on this machine. OpenCode is installed with zero stored sessions. Their parsing fixtures do not constitute live provider resume tests. T3 full application restore is not implemented.

## Version 0.2

The new suite passes 14 service/transfer tests and 3 browser UI tests, plus native smoke tests against both the release executable and installed 0.2.0 application. Coverage now includes Windows held/released lock detection, turn-state classification, ordinary/UNC path presentation, exact image recovery, image caching and corrupted-cache recovery, concurrent image reads, image-inclusive/exclusive exports and imports, Freebuff native discovery and credential exclusion, system/light/dark behavior, in-place live response edits, pause/resume, scroll preservation, attachment modals, image downloads, and provider artwork. Additional checks cover stale-status expiry and live reading/re-export after native Codex restore.

A real screenshot was recovered from its Codex transcript while its original path was deliberately unavailable. Its bytes matched the original image. The installed library scan found 159 chats across Codex, OpenCode, and Freebuff, with 2 verified working conversations at the sampled instant. Activity can change immediately afterward. The new application's defaults were verified as System theme, live updates on, and image files included.

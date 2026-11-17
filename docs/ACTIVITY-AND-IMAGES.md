# Activity, updates, and image attachments

ChatPort 0.2.0 adds conversation status, live reading, image previews, Freebuff CLI history, and theme preferences.

## Conversation status

Codex's native turn history records completed, failed, interrupted, and in-progress turns. ChatPort reads the latest turn. On Windows, its small native helper checks whether Codex's per-thread writer lock is actually held, using a nonblocking OS lock probe. It opens existing lock files read-only, releases its own probe immediately, and does not create a provider lock file or write provider data.

| Indicator | Evidence |
| --- | --- |
| Working | An in-progress turn and a held native writer lock |
| Open · idle | A held native writer lock and a completed last turn |
| Unfinished | No recorded completion and no live writer ownership in a supported Codex profile |
| Interrupted / Failed | The provider explicitly recorded that outcome |
| Status unknown | The provider did not expose enough completion or ownership evidence |

An unfinished turn can result from a machine crash, a forced process exit, or another interruption that was not recorded cleanly. ChatPort does not claim to know which caused it. An old lock filename alone does not count as activity. Imported archives show captured status rather than live ownership. Restoring a Codex archive switches that source to its restored native profile, preserving chat IDs and folder choices; subsequent activity, messages, and exports use the live profile. If monitoring stops, a previously active indicator expires to unknown.

Other providers have different persistence and ownership mechanisms. ChatPort tracks their saved message changes, but does not infer a live process merely from a recent timestamp.

OpenCode persists each message's completion, finish reason, and error in `opencode.db`, and writes a global activity log under `log/opencode.log`. ChatPort combines the latest message with recent step or retry lines for that session. OpenCode also has an authoritative live `/session/status` map, but it is process-local and protected by a random per-launch password, so another program cannot query it without modifying OpenCode. OpenCode status therefore reports working, idle, unfinished, interrupted, or failed, but does not claim a verified process owner.

Freebuff CLI records the owning process ID in each chat's `log.jsonl`, and when it switches chats it logs the loaded chat ID and run-state path. ChatPort matches that PID to `freebuff-live-<pid>.json`, a heartbeat refreshed while that CLI holds a live session, and combines it with the last AI message's `isComplete` flag. When a loaded-chat record is present, other chat folders for the same PID are not treated as open. Without one, ChatPort falls back to the heartbeat and a process that has moved can keep an older chat marked open. A response is only marked working while its own chat is loaded and its response is incomplete. A stale or missing heartbeat is treated as no live owner, and a recorded error remains failed or interrupted.

Status is checked roughly every two seconds. **Live** is on by default and can be switched off in the reader or in Sources & integrations. This setting persists. Live reading updates new messages and existing response text as the provider saves it. It follows the bottom while you are there; reading older messages preserves your scroll position and offers a jump to the latest changes. Pausing live reading keeps the visible transcript fixed while status monitoring continues.

This reads persisted provider data. Tokens that a provider has not written to disk are not available to ChatPort.

## Images

Images are associated through native attachment records, rather than by searching for similar-looking screenshots. The reader supports local and embedded PNG, JPEG, GIF, WebP, and BMP images. Click a thumbnail to open a modal, switch between fit/actual size, or save the original image for a report.

Codex can store a local temporary path in its message index while keeping the embedded image in the raw transcript. If the file is missing, ChatPort uses the native turn's byte range and message content to recover a matching embedded image. It accepts an exact prompt match, or the single image-bearing user record within a known turn. Ambiguous candidates are not guessed. The current screenshot in this conversation was recovered byte-for-byte from its raw transcript with the original path deliberately unavailable during verification.

Image cache writes are flushed and installed atomically. Cached bytes are checked against their content hash, and damaged cache entries can be recovered again from the source. Resolved images are cached under `%LOCALAPPDATA%\ChatPort\assets` with content hashes. Image URLs are not fetched from external websites. Missing files with no recoverable embedded copy remain visibly unavailable. Large/unsupported formats and images outside the bounded recovery range may remain unavailable. SVG attachments are not rendered as conversation images.

**Include image files** is available in both export and import dialogs and remembered as a preference. It defaults on. Included portable assets are deduplicated, hashed, and checked on import. Unavailable images remain as references with their reason, and export notes record missing attachments. Native provider transcripts/databases can already contain embedded images; excluding portable image files is not a redaction of native history.

ChatGPT data ZIPs can include image files. ChatPort matches their attachment IDs and includes available files in the portable library. A JSON-only export cannot supply image bytes that are absent from the JSON. The original conversation JSON still retains its exported branches.

## Freebuff

Freebuff CLI history is discovered under `~/.config/manicode/projects`, or `FREEBUFF_CONFIG_DIR` when configured. ChatPort reads `chat-meta.json`, `chat-messages.json`, `run-state.json`, and the chat's `log.jsonl` PID and loaded-chat record for status. It supports reading, search, saved updates, and transfer of those native chat files. It excludes root credentials, device keys, account heartbeat files, settings, and executables. Freebuff Desktop's separate per-project database is not handled by this adapter.

Verified against the locally installed Freebuff 0.2.36 layout and upstream [configuration](https://github.com/CodebuffAI/freebuff/blob/03e604a36fb0312540aa18241f61431f94fc040e/cli/src/utils/config-dir.ts), [chat metadata](https://github.com/CodebuffAI/freebuff/blob/03e604a36fb0312540aa18241f61431f94fc040e/cli/src/utils/chat-meta.ts), and [run-state storage](https://github.com/CodebuffAI/freebuff/blob/03e604a36fb0312540aa18241f61431f94fc040e/cli/src/utils/run-state-storage.ts).

## Paths and appearance

The `\\?\` prefix in some Windows paths is the Win32 extended path namespace. ChatPort displays ordinary drive paths and converts `\\?\UNC\server\share` to `\\server\share`. This changes the presentation, without relocating directories.

Appearance defaults to **System**, tracks OS color-scheme changes, and also offers saved **Light** and **Dark** overrides in Sources & integrations. Promotional taglines were removed.

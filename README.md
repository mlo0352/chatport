# ChatPort

A standalone desktop conversation library. Browse local coding-agent chats, choose where an existing conversation resumes, and transfer conversations between computers. Windows is available now; the [Linux build framework](docs/LINUX.md) is prepared for later testing on real hardware.

## Launch

Download the latest portable **ChatPort.exe** from [Releases](https://github.com/mlo0352/chatport/releases/latest) and run it. There is no installer. The executable contains its Node runtime; Node and Rust are not needed. Windows 10/11 with WebView2 is required. ChatPort stores its data in `%LOCALAPPDATA%\ChatPort`.

Use **Sources & integrations** to add a custom provider profile. The default scan checks Codex, Claude Code, OpenCode, and T3 Code stores in the current Windows account, plus configured provider homes. It does not search every file on every drive or read other Windows accounts. ChatGPT cloud history needs a user-provided ChatGPT JSON or ZIP data export.

Version 0.2 also discovers Freebuff CLI history. Status badges identify working, open/idle, unfinished, interrupted, and failed conversations where provider evidence supports them. OpenCode status follows its persisted turn records plus the recent session activity log. Freebuff status combines the chat's recorded PID with the live CLI heartbeat, the logged loaded-chat ID when Freebuff records one, and the last response's completion flag. **Live** reading defaults on. Appearance defaults to **System**, with Light/Dark overrides. Screenshot previews open in an image modal and can be saved or included in transfers. See [activity and image behavior](docs/ACTIVITY-AND-IMAGES.md) for evidence, recovery behavior, and provider limits.

## What works

| Source | Read/search | Portable transfer | Continue a native conversation |
| --- | --- | --- | --- |
| Codex | SQLite history and legacy JSONL, including archived and child sessions | Native databases, selected transcripts, queues/goals, readable messages | Same session ID; choose a different resume folder. Imported profiles can be restored to an empty profile. Tested with the installed Codex 0.169.0. |
| Claude Code | Project JSONL transcripts | Selected native transcripts and readable messages | Existing local transcript, using Claude's documented absolute-transcript resume option. Provider not installed here; adapter tested with fixtures. |
| OpenCode | Native session/message/part database | Native database snapshot and readable messages | Existing local session. Installed here with no sessions; parsing tested with fixtures. |
| T3 Code | V1 and V2 projection databases | Readable messages; full-source exports also retain native database snapshots | Read/transfer here; continue in T3. Fixture-tested; T3 is not installed here. |
| Freebuff CLI | Native chat JSON, including saved updates | Chat messages, metadata, run state, and optional images | Read/transfer here; continue from Freebuff history. |
| ChatGPT export | Active conversation branch | Original conversation JSON retains all branches | Continue in ChatGPT. This tool does not insert conversations into ChatGPT's cloud account. |

The reader pages messages and optionally shows supported tool events. Imported native snapshots can provide tool history when available. Copy message retains the whole message. Search matches titles/folders immediately and message phrases after background indexing.

## Change a working directory

Select a conversation, click **Edit** beside **Resume folder**, and choose an existing directory. ChatPort persists that choice per conversation and includes it in future exports. **Resume in terminal** opens the same session with the chosen folder. **Reset to original folder** removes the override. The recorded folder stays visible for reference.

Codex exposes `resume <session-id> -C <folder>` and an App Server `thread/resume` folder override. The live verification restored an isolated native profile and confirmed the same thread ID and new folder using the actual installed Codex, without sending a model turn. This does not relocate repository files, rewrite historical messages, or change an already-running process. Claude and OpenCode can retain their own project/session associations even when launched from another directory.

The **TermSanity** action opens local Codex/Claude conversations as nested agent tabs through its authenticated local service. TermSanity must be running. Custom/restored provider homes should use **Resume in terminal**, which supplies the correct provider environment explicitly.

## Send to a nearby computer

Open **Nearby** on both computers. ChatPort discovers instances on the same LAN using mDNS. Copy a pairing link from one computer and paste it into **Pair computer** on the other within two minutes. Pair once to send in either direction. An explicit IP works when multicast discovery is blocked.

Check conversations in the library, then open Nearby and click **Send selected** beside the destination. With no selection the action is **Send all chats**. The receiver must accept each offer. Transfers use HTTPS with pinned device certificates, mutual certificate authentication and per-pair credentials; received archives are size/hash checked and validated before import. Sending retains the originals. Interrupted transfers are marked failed and can be retried. Pairing identities, offers and transfer records survive restarts. Nearby can be turned off.

Add **Folder mappings** in Nearby or Sources to translate an old machine's project prefix to an existing local folder, for example `C:\Users\example\Desktop\tools` → `/home/example/code`. Individual chat folder edits take priority. Copy project files separately; these mappings affect the next resume, not a running process or historical messages.

For an active Codex chat, **Focus open chat** locates a host window when the desktop exposes its owner. TermSanity 0.1.6 can select the exact project, pane and nested tab, including detached panes, through its authenticated local service. Other terminal hosts may expose only the outer window or no usable window at all. On Linux, X11 activation uses `xdotool` when it is installed; native Wayland blocks external activation. Linux focus remains unvalidated until it runs on real hardware.

## Move chats using an archive

1. Click **Export all**, or check specific conversations and click **Export N**.
2. Choose a USB drive, mapped drive, or UNC folder such as `\\server\share\Chats`. The job continues while you browse, and also if you close the UI while the computer stays running.
3. On the destination computer, run ChatPort and click **Import**. Pick the `.chatport.zip` file. Each listed file is checked against its SHA-256 hash before the archive enters the library.
4. To continue imported Codex sessions, click **Restore profile**, choose an empty folder, then set a resume folder and click **Resume in terminal**. The restored folder becomes `CODEX_HOME`. Sign in to Codex on the destination machine if needed.

Restoration preserves native conversation IDs. It refuses to replace an existing conversation profile. Existing `auth.json` and `config.toml` can remain in an otherwise empty destination; those files are never replaced. There is no merge into a populated provider database in this version. Imported Claude, OpenCode, T3, and ChatGPT conversations can be browsed and re-exported; native installation into those providers is not automated.

Provider sign-in files, provider configuration, application logs, and enrollment/credential tables are excluded from ChatPort exports. Conversation content can contain secrets you pasted or that appeared in tool output. The ZIP is not encrypted. Project source trees are not copied. Available image files can be included, cached, and recovered from embedded native history where possible. Shared provider attachment folders are retained for whole-source exports when images are included, and omitted for partial-source exports. Native snapshots can retain shared project metadata and embedded images. ChatGPT ZIP exports can supply matched image files; missing files remain marked unavailable. The original conversation JSON is retained.

Each SQLite file uses its online backup API. Separate databases are captured consecutively, so an actively running agent can advance between snapshots. Raw JSONL files are copied as they exist during staging; this is not a memory image of an executing process. Incomplete output has a `.partial` suffix and never appears as a completed archive. A machine crash requires restarting an interrupted export; the original chat stores remain intact. Cancelling a transfer removes its temporary staging data. Native profile installation finishes as a single operation and cannot be cancelled midway from the UI.

## Data and development

ChatPort stores its cache, message-search index, imports, folder overrides, and transfer records in `%LOCALAPPDATA%\ChatPort`. `CHATPORT_DATA` selects an alternate application-data folder; `CHATPORT_HOME` overrides discovery's user-home directory for testing. Source chat stores are opened read-only. Browsing sends no conversations to a remote service. Resume starts the selected provider CLI, which uses its normal provider connection.

```powershell
npm install
npm run dev       # local development UI, port 1435
npm test          # native store/transfer/ZIP tests
npm run test:ui   # browser interaction tests
npm run dist      # portable Windows executable; requires Rust + WebView2 tools
```

`node tests/live-machine.mjs` is an opt-in live-data verification: it creates local test copies of the discovered chats, exports/imports them, restores an isolated Codex profile, and probes resume with a different folder. It sends no model turn. Large history stores need temporary disk space. `tests/native-smoke.mjs` tests the packaged Windows UI with synthetic provider data.

See [T3 integration findings](docs/T3-INTEGRATION.md) and [verification results](docs/VERIFICATION.md).

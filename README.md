# GitSync

An Obsidian plugin that synchronizes selected vault files with a single GitHub
repository through GitHub's Git Database REST API. It runs on Obsidian Desktop
and on iOS.

The plugin does not shell out to Git, and it never force-pushes. It talks to the
GitHub API directly, so no Git binary is required on either device.

## Features

- Refs, commits, trees and blobs via the GitHub Git Database REST API
- Fine-grained personal access token authentication
- Sync on demand, an immediate push, and a first-run initial pull
- Debounced automatic push after local changes settle
- Polling and a pull on app activation while Obsidian is in the foreground
- Independent pull and push extension filters, and ignored path prefixes
- SHA-256 local content tracking against remote blob SHAs
- Full remote tree snapshot recorded at the last synced commit
- Content-based rename detection across devices
- Three-way merge of Markdown changed in both places
- Conflict copies and explicit keep-local / keep-remote resolution
- Status bar, ribbon icon and commands

## Before you start

Use a disposable test vault and a disposable test repository until you have
verified the behavior you depend on. This plugin writes to your vault and to
your repository.

## Requirements

Build:

- Node.js 18 or newer
- npm

GitHub:

- A repository with at least one commit
- A fine-grained personal access token scoped to that repository
- Repository permission: **Contents: Read and write**

The plugin pins the GitHub REST API version it sends in the
`X-GitHub-Api-Version` header.

## Build

```bash
npm install
npm run build
```

The production build emits `main.js`. The plugin runtime needs three files:

```text
manifest.json
main.js
styles.css
```

For a watch build:

```bash
npm run dev
```

## Install

Copy the three runtime files into your vault:

```text
<VAULT>/.obsidian/plugins/gitsync/
```

Then open **Settings → Community plugins**, disable Restricted mode if it is on,
enable **GitSync**, and open the plugin settings.

On iOS the same three files go in the same location. Build on a desktop and
transfer them into the vault using whatever file transfer method you already
use for that vault.

## Configuration

In the plugin settings, set:

```text
GitHub owner:           your GitHub username or organization
GitHub repository:      repository name
Branch:                 main
Personal access token:  your fine-grained PAT
```

The token field is a password input, and the token is never written to a log or
a commit. Scope the token to the target repository and grant it only the
Contents read/write permission.

Use **Test connection** to verify authentication, repository access and the
branch. It reports the branch ref and the current commit SHA.

## Extensions

The pull and push lists both start empty. Nothing synchronizes until you select
extensions. The two lists are independent, and settings are local to each
installation, so a phone and a desktop can carry different configurations.

The selectable set is the file types Obsidian itself supports:

```text
.md .canvas .base
.png .jpg .jpeg .gif .webp .svg .bmp .avif
.pdf
.mp3 .wav .m4a .ogg .3gp .flac
.mp4 .webm .ogv .mov .mkv
```

Matching is case-insensitive. **Select all** and **Clear all** are available.

## Ignored paths

One path or path prefix per line:

```text
.obsidian/workspace.json
.obsidian/workspace-mobile.json
```

Ignored paths are never pulled or pushed. `.trash` and `.obsidian` are always
ignored.

## Commands

```text
Sync now
Show status
Show conflicts
Open status panel
Open settings
```

Push and reset are buttons in the plugin settings under **Actions**. Pulling is
automatic, and **Sync now** forces a full cycle.

Commits created by the plugin look like:

```text
Sync from desktop at 2026-08-16 11:45:22
```

## Behavior

### Automatic push

A relevant local create, modify, delete or rename marks the vault dirty and
starts a timer. Every further relevant event resets it. The push happens once
the delay has elapsed since the last modification.

### Pull

The branch head is read first. Tree and blob data are only fetched when the
remote SHA has changed.

### iOS

There is no continuous background execution. The plugin checks on activation,
and polls only while the app is visible.

### Conflicts

When a path changed both locally and remotely since the last synchronized
state, the plugin does not pick a winner. It keeps the local file and writes a
remote conflict copy where possible. **Show conflicts** offers keep local, keep
remote, or clear. Binary files are never merged.

A conflict record is sticky. It is removed only by an explicit resolution, or
when the plugin observes that both sides now hold identical bytes. That check
runs on every pull and push, and also on the quiet path where the branch has
not moved, because two devices frequently settle a conflict by converging on
the same content. The comparison uses the recorded `lastSyncedTree`, so it
costs no request.

### Stale branch reads

Branch heads are read conditionally, and GitHub's ref reads are eventually
consistent. A read taken shortly after a push can return the previous head,
either from GitHub or from a 304 served out of the local ETag cache.

Before applying anything, the plugin asks GitHub how the returned head relates
to the commit it last synced. A head that is `behind` or `identical` is treated
as stale: nothing is applied, the cached ETag is dropped so the next poll asks
for a fresh body, and the pull ends.

Without that check the vault flickers. Files the device just pushed still carry
their new blob SHA locally, so against a stale tree each of them reads as a
remote change, gets overwritten with its previous contents, and is restored on
the following poll.

### Deletions

A path counts as deleted only when the tree this vault last synced to contained
it and the current remote tree does not. The full tree is recorded alongside
`lastSyncedCommit`, so a file this device never pulled is never mistaken for one
that was removed.

Deletions are applied only when GitHub reports the remote commit as `ahead` of
the last synced commit. A stale read reads as `behind`, and nothing is deleted.

Deletions propagate in both directions. Removed files go to the vault's
`.trash` rather than being destroyed. Three guards limit the blast radius:

- A push is refused when the vault reports no eligible files while the tracking
  table is populated. That indicates an index that has not finished building,
  not an instruction to delete everything.
- A file the other device edited since this one last saw it is reported as a
  collision rather than removed.
- A batch of five or more deletions is held back on an automatic push and
  reported. Pushing manually sends it after a confirmation listing the files.

### Renames

A rename arrives as one path disappearing and another appearing. When the blob
SHA of the vanished path matches a newly appeared path, the local file is moved
instead of being deleted and downloaded again. This runs on every pull, since a
rename preserves content.

A file renamed and edited in the same commit has a different SHA, and is handled
as a deletion plus a download.

### Files outside the extension filters

Remote files whose extension is not in the pull list are ignored locally, and
are not deleted from GitHub. Local files whose extension is not in the push list
are not pushed.

## Limitations

- One repository and one branch per installation
- No device locking
- No force push
- No continuous background synchronization on iOS
- The recursive tree response must fit within GitHub's tree response limit
- The repository needs an initial commit before the first initial pull

## Project layout

```text
src/
├── main.ts
├── types.ts
├── github/
│   └── GitHubClient.ts
├── sync/
│   ├── ChangeDetector.ts
│   ├── ConflictDetector.ts
│   ├── PullManager.ts
│   ├── PushManager.ts
│   ├── SyncManager.ts
│   └── SyncState.ts
├── ui/
│   ├── ConflictModal.ts
│   ├── SettingsTab.ts
│   └── StatusBar.ts
└── vault/
    ├── PathFilter.ts
    └── VaultScanner.ts
```

## License

MIT. See [LICENSE](LICENSE).

# Inline for desktop

The Inline web app in a native window for macOS, Windows and Linux. The app
starts Inline's own server on the user's computer, so there is nothing to host:
documents, the Word copies and Claude all run locally on the user's own Claude
account, exactly as with `npm run dev`.

This folder is its own npm package. Nothing in it is needed for the web app:
`npm install` and `npm run dev` in the project folder never install Electron.

## How it works

- **Server:** `scripts/prepare-server.mjs` builds Inline with
  `INLINE_STANDALONE=1` (Next.js standalone output) into `.stage/server`.
  The app runs it in an Electron utility process (`src/server.mjs`) on
  `127.0.0.1`, port 4319 when that port is free.
- **Claude Code:** the Agent SDK's Claude Code CLI is a separate binary for
  each platform. The right one is copied into each build
  (`scripts/after-pack.cjs`), so users don't need Claude Code installed.
  They sign in from the Claude panel (**Sign in with Claude**).
- **Windows:** the page's own header is the title bar. On macOS the traffic
  lights sit inside it, and on Windows the window buttons are drawn over it.
  `app/styles/desktop.css` makes room for them. Linux keeps the system frame.
- **Browser:** the same server answers at `http://localhost:4319`, so
  **File › Open in Browser** (⌘⇧O / Ctrl+Shift+O) opens the page you're on in
  your web browser. Both show the same documents, live. On macOS the server
  keeps running after the last window closes. On Windows and Linux it stops
  when the app quits.
- **Data:** documents are kept in the app's data folder (**Help › Show Data
  Folder**): `~/Library/Application Support/Inline/data` on macOS,
  `%APPDATA%\Inline\data` on Windows and `~/.config/Inline/data` on Linux.
  Word copies still go to `~/Documents/Inline`.
- **Updates:** installed apps check GitHub Releases every few hours and
  install new versions when they quit (`src/updates.mjs`).
- **Links:** `inline://d/<id>` opens a document in the app.

## Develop

```bash
npm install            # in desktop/
npm run dev            # next dev on :4320 plus Electron, with hot reload
```

To run the packaged server without making installers:

```bash
npm run prepare-server
npm start
```

## Build installers

```bash
npm run dist                 # this computer's platform → dist/
npm run dist -- --dir        # unpacked app only (faster)
npm run dist -- --mac        # or --win, --linux
```

| Platform | Output |
| --- | --- |
| macOS | `Inline-mac-arm64.dmg`, `Inline-mac-x64.dmg`, plus `Inline-<version>-mac-<arch>.zip`s for updates |
| Windows | `Inline-windows-x64-setup.exe` (unsigned) |
| Linux | `Inline-linux-x86_64.AppImage`, `Inline-<version>-linux-x64.tar.gz` |

The installers' names leave out the version, so
`https://github.com/Naimy441/Inline/releases/latest/download/<name>` always
downloads the newest one.

macOS builds have to be made on a Mac, and Windows builds are best made on
Windows. The **Desktop** GitHub workflow builds Windows and Linux.

## Release

GitHub Actions builds Windows and Linux. The Mac app is built, signed and
notarized on a Mac, so no Apple credentials are stored on GitHub.

1. Set `version` in `desktop/package.json` (say `0.2.0`) and commit it.
2. Push a matching tag: `git tag v0.2.0 && git push origin v0.2.0`. The
   **Desktop** workflow builds Windows and Linux and uploads them to a draft
   release named for the tag. It fails if the tag and the version differ.
3. On your Mac, in `desktop/`:

   ```bash
   APPLE_KEYCHAIN_PROFILE=inline-notary npm run dist -- --publish
   ```

   This builds the Apple silicon and Intel apps, signs and notarizes them, and
   uploads them to the same draft release. It uses the GitHub CLI's login, or
   `GH_TOKEN` if set.
4. Check the draft release, then **Publish**. Published releases are what
   installed apps update to.

Running the workflow by hand (**Actions › Desktop › Run workflow**) builds the
Windows and Linux installers as downloadable workflow artifacts without making
a release.

## macOS signing and notarization

Signing needs a **Developer ID Application** certificate in your login
keychain. "Apple Development" and "Mac App Distribution" certificates can't be
used outside the App Store. Only the team's Account Holder can create one: in
Xcode › Settings › Accounts, pick the team › Manage Certificates › **+** ›
Developer ID Application. `npm run dist` finds it on its own.

Notarizing needs an app-specific password from
[account.apple.com](https://account.apple.com) › Sign-In and Security, saved
once to the keychain under the name `inline-notary`:

```bash
xcrun notarytool store-credentials inline-notary --apple-id <your Apple ID> --team-id <your Team ID>
```

Then set `APPLE_KEYCHAIN_PROFILE=inline-notary` when building. Without the
certificate the Mac app is ad-hoc signed: macOS blocks it until the user
right-clicks › **Open**, it can't update itself, and `--publish` refuses to
upload it.

Windows builds are unsigned, so Windows SmartScreen shows "Windows protected
your PC" on first launch. Users choose **More info › Run anyway**.

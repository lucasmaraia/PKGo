<img src="resources/icon.png" width="96" alt="">

# PKGo for PS4

Install and manage PS4 packages over your local network with **GoldHEN**, from Windows or Linux.
No installer app has to be open on the console.

[Português (Brasil)](README.pt-BR.md)

## Features

- **Library on your PC**: add any number of folders (subfolders included), or drag folders and PKGs onto the window, and see each PKG with its cover, title, version and type (game, update, DLC or app/homebrew).
- **One-click install**: PKGo serves the file over your network and the PS4 downloads it in the background, with progress, speed and time left. Packages queue up and install one after another.
- **Check several packages** and install them at once (games first, then updates and DLCs), or check all that the filter shows.
- **Install all updates**: one button queues every update newer than the one on the PS4, and the DLCs it does not have yet.
- **Follows the PS4 in real time**: failures, downloads cancelled or games deleted on the console show up right away. Failed downloads are retried, and cancelled or failed ones are removed from the PS4 download list, so no failed entry stays in its notifications.
- **Console view**: lists the games and apps installed on the PS4, with version, update, DLC count and space used.
- **Delete from the PS4**: remove a game, or only its update, using the system uninstaller. Saved data is kept.
- **Finds your PS4** on the network automatically, or you can type its IP.
- **Keyboard and controller**: arrows or the D-pad move around like on the PS4; ✕ chooses, ○ goes back, L1/R1 switch tabs.
- **Updates itself**: the installer and the Linux AppImage/.deb download new versions in the background and install them on restart (never during a download to the PS4). The portable build tells when a new version is out.
- **Diagnostics**: one click copies versions, connections and recent events, to attach to a bug report.
- **English, Español and Português (Brasil)**, following your system language by default.

## Requirements

- A PS4 with **GoldHEN** loaded, with these enabled in _Settings > GoldHEN > Server Settings_:
  - **FTP server** (port 2121), used to read what is installed;
  - **BinLoader server** (port 9090), used to install and delete;
  - optionally the **Klog server** (port 3232), used to follow downloads in real time. The PS4 serves its log to one program at a time.
- The PC and the PS4 on the same local network.

## Install

Download the latest release:

| System  | File                                                            |
| ------- | --------------------------------------------------------------- |
| Windows | `PKGo-Setup-x.y.z.exe` (installer) or `-Portable-` (no install) |
| Linux   | `pkgo-x.y.z-x86_64.AppImage` or `pkgo-x.y.z-amd64.deb`          |

On Linux, the `.deb` sets up everything. For the AppImage: `chmod +x` it first. On Ubuntu 24.04 and newer, which restrict the Chromium sandbox for AppImages, start it with `--no-sandbox` if it does not open.

On first launch, PKGo looks for your PS4. If your firewall asks, allow it on **private networks**: the console downloads packages from your PC.

## How it works

- **Install**: PKGo sends a small payload to GoldHEN's BinLoader. It registers the download with the PS4's own download service, pointing at PKGo's file server. The console then downloads the PKG straight from your PC.
- **Delete, and clean up downloads**: another payload calls the system uninstaller, or removes a stopped download from the PS4 download list, and reports the result back.
- **Real time**: PKGo reads GoldHEN's kernel log to see what the PS4 does with each download.
- **Console list**: read over GoldHEN's FTP server.

The payloads live in [`payloads/`](payloads/README.md), with their sources and build script.

## Development

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev          # run with hot reload
npm test             # unit tests (vitest)
npm run test:e2e     # interface tests on the built app (Playwright, no PS4 needed)
npm run lint         # ESLint
npm run typecheck    # TypeScript
npm run dist:win     # Windows installer + portable (dist/)
npm run dist:linux   # AppImage + .deb (dist/, run on Linux)
npm run payloads     # rebuild the payloads (Linux/WSL, see payloads/README.md)
```

Project layout:

```
src/core       PS4 logic in plain Node (no Electron): PKG reader, library, FTP, payloads, install queue
src/main       Electron main process: window, IPC, native dialogs, tray
src/preload    Typed bridge exposed to the window (window.api)
src/renderer   Interface (TypeScript, no framework)
src/shared     Types and translations shared by all of the above
payloads       Sources and build script of the PS4 payloads
resources      Built payloads and the app icon
tests          Unit tests
e2e            End-to-end tests of the interface
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to help, including how to add a language.

## Credits

- Install payload: [DirectPackageInstaller](https://github.com/marcussacana/DirectPackageInstaller) by marcussacana (GPL-3.0).
- Uninstaller function names as used by [Itemzflow](https://github.com/LightningMods/Itemzflow) (GPL-3.0).
- [GoldHEN](https://github.com/GoldHEN/GoldHEN) by SiSTR0 and contributors.

## License

[GPL-3.0](LICENSE). PKGo is not affiliated with Sony Interactive Entertainment. Use it only with content you are entitled to.

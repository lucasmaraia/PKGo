# PKG Sender

Install and manage PS4 packages over your local network with **GoldHEN**, from Windows or Linux.
No installer app has to be open on the console.

[Português (Brasil)](README.pt-BR.md)

## Features

- **Library on your PC**: add any number of folders (subfolders included) and see each PKG with its cover, title, version and type (game, update, DLC or app/homebrew).
- **One-click install**: PKG Sender serves the file over your network and the PS4 downloads it in the background, with progress, speed and time left. Packages queue up and install one after another.
- **Console view**: lists the games and apps installed on the PS4, with version, update, DLC count and space used.
- **Delete from the PS4**: remove a game, or only its update, using the system uninstaller. Saved data is kept.
- **Finds your PS4** on the network automatically, or you can type its IP.
- **English, Español and Português (Brasil)**, following your system language by default.

## Requirements

- A PS4 with **GoldHEN** loaded, with these enabled in _Settings > GoldHEN > Server Settings_:
  - **FTP server** (port 2121), used to read what is installed;
  - **BinLoader server** (port 9090), used to install and delete.
- The PC and the PS4 on the same local network.

## Install

Download the latest release:

| System  | File                                                                  |
| ------- | --------------------------------------------------------------------- |
| Windows | `PKG Sender-Setup-x.y.z.exe` (installer) or `-Portable-` (no install) |
| Linux   | `pkg-sender-x.y.z-x86_64.AppImage` or `pkg-sender-x.y.z-amd64.deb`    |

On Linux, the `.deb` sets up everything. For the AppImage: `chmod +x` it first. On Ubuntu 24.04 and newer, which restrict the Chromium sandbox for AppImages, start it with `--no-sandbox` if it does not open.

On first launch, PKG Sender looks for your PS4. If your firewall asks, allow it on **private networks**: the console downloads packages from your PC.

## How it works

- **Install**: PKG Sender sends a small payload to GoldHEN's BinLoader. It registers the download with the PS4's own download service, pointing at PKG Sender's file server. The console then downloads the PKG straight from your PC.
- **Delete**: another payload calls the system uninstaller and reports the result back.
- **Console list**: read over GoldHEN's FTP server.

The payloads live in [`payloads/`](payloads/README.md), with their sources and build script.

## Development

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev          # run with hot reload
npm test             # unit tests (vitest)
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
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to help, including how to add a language.

## Credits

- Install payload: [DirectPackageInstaller](https://github.com/marcussacana/DirectPackageInstaller) by marcussacana (GPL-3.0).
- Uninstaller function names as used by [Itemzflow](https://github.com/LightningMods/Itemzflow) (GPL-3.0).
- [GoldHEN](https://github.com/GoldHEN/GoldHEN) by SiSTR0 and contributors.

## License

[GPL-3.0](LICENSE). PKG Sender is not affiliated with Sony Interactive Entertainment. Use it only with content you are entitled to.

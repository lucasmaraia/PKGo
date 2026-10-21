# Payloads

PKG Sender talks to the PS4 through two payloads, sent to GoldHEN's BinLoader server (port 9090; 9021 and 9020 are tried too). The built files ship with the app from `resources/payloads/`.

| File            | Source                                                                                                                                         | What it does                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install.bin`   | [DirectPackageInstaller](https://github.com/marcussacana/DirectPackageInstaller) by marcussacana, commit `ca7bade6` (GPL-3.0)                  | Connects back to PKG Sender, receives the package URL, name, content ID, type and size, and registers the download with the system download service (BGFT). It stays running and accepts the next package.                         |
| `tools.bin`     | `tools.c` + `tools_net.c` (this folder), on the same payload template                                                                         | Connects back and runs one command, then sends the result codes back. **Uninstall** a game or only its update with the system uninstaller (`sceAppInstUtilAppUnInstall` / `sceAppInstUtilAppUnInstallPat`, names as used by [Itemzflow](https://github.com/LightningMods/Itemzflow)); saved data is not touched. **Remove a download** from the download list (`sceBgftServiceIntDownloadStopTask` + `sceBgftServiceIntDownloadUnregisterTask`), by task ID or looked up by content ID, so cancelled and failed downloads leave no entry in the notifications. |

Both get the PC address patched in at send time, over six `0xB4` marker bytes (IPv4 + port).

## Building

`build.sh` fetches the DirectPackageInstaller sources at the pinned commit (only its `Payload` folder), builds them, then builds `tools.bin` against the same template. It never uses prebuilt binaries.

On Linux or WSL:

```sh
sudo apt-get install -y gcc make yasm git file python3 binutils
npm run payloads
```

With Docker, from the project folder:

```sh
docker run --rm -v "$PWD:/src" -w /src ubuntu:24.04 bash -c \
  "apt-get update && apt-get install -y gcc make yasm git file python3 binutils ca-certificates && bash payloads/build.sh"
```

Tested on a PS4 with firmware 12.52 and GoldHEN 2.4b18.7.

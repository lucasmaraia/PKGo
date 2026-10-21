#!/bin/bash
# Builds the GoldHEN payloads into resources/payloads/:
#   install.bin    DirectPackageInstaller payload, from its sources pinned to a reviewed commit
#   tools.bin      our tools.c + tools_net.c (uninstall, remove downloads) on the same payload template
#
# Needs Linux (or WSL / Docker with ubuntu:24.04) with:
#   sudo apt-get install -y gcc make yasm git file python3 binutils
# Run from the project folder: npm run payloads
set -euo pipefail

REPO=https://github.com/marcussacana/DirectPackageInstaller.git
COMMIT=ca7bade66737fede3b0e7bad73b665e0a4d4ff39
SRC="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$SRC/.." && pwd)/resources/payloads"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

git -C "$WORK" init -q
git -C "$WORK" remote add origin "$REPO"
git -C "$WORK" sparse-checkout set Payload
git -C "$WORK" fetch -q --depth 1 origin "$COMMIT"
git -C "$WORK" checkout -q FETCH_HEAD

make -C "$WORK/Payload/lib"
make -C "$WORK/Payload"
cp "$WORK/Payload/payload.bin" "$OUT/install.bin"

cp "$SRC/tools.c" "$SRC/tools_net.c" "$WORK/Payload/"
(cd "$WORK/Payload" &&
  gcc -g -mcmodel=small -isystem freebsd-headers -nostdinc -nostdlib -fno-stack-protector -static \
    lib/lib.a tools.c tools_net.c ps4-libjbc/*.c -Wl,-gc-sections -o tools.elf -fPIE -ffreestanding &&
  objcopy tools.elf --only-section .text --only-section .data --only-section .bss --only-section .rodata \
    -O binary tools.bin)
cp "$WORK/Payload/tools.bin" "$OUT/tools.bin"

for f in install.bin tools.bin; do echo "Built $OUT/$f ($(stat -c %s "$OUT/$f") bytes)"; done

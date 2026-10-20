#!/bin/bash
# Builds payload/dpi.bin from the DirectPackageInstaller sources, pinned to a
# reviewed commit. Run inside WSL (Ubuntu) from the project folder:
#   sudo apt-get install -y gcc make yasm git file
#   bash payload/build.sh
set -euo pipefail

REPO=https://github.com/marcussacana/DirectPackageInstaller.git
COMMIT=ca7bade66737fede3b0e7bad73b665e0a4d4ff39
OUT="$(cd "$(dirname "$0")" && pwd)/dpi.bin"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git -C "$WORK" init -q
git -C "$WORK" remote add origin "$REPO"
git -C "$WORK" sparse-checkout set Payload
git -C "$WORK" fetch -q --depth 1 origin "$COMMIT"
git -C "$WORK" checkout -q FETCH_HEAD

make -C "$WORK/Payload/lib"
make -C "$WORK/Payload"
cp "$WORK/Payload/payload.bin" "$OUT"
echo "Payload gerado: $OUT ($(stat -c %s "$OUT") bytes)"

# Uninstall payload: our uninstall.c on the same template (crt, dlsym, libjbc).
DIR="$(dirname "$OUT")"
cp "$DIR/uninstall.c" "$DIR/uninstall_net.c" "$WORK/Payload/"
(cd "$WORK/Payload" &&
  gcc -g -mcmodel=small -isystem freebsd-headers -nostdinc -nostdlib -fno-stack-protector -static \
    lib/lib.a uninstall.c uninstall_net.c ps4-libjbc/*.c -Wl,-gc-sections -o uninstall.elf -fPIE -ffreestanding &&
  objcopy uninstall.elf --only-section .text --only-section .data --only-section .bss --only-section .rodata \
    -O binary uninstall.bin)
cp "$WORK/Payload/uninstall.bin" "$DIR/uninstall.bin"
echo "Payload gerado: $DIR/uninstall.bin ($(stat -c %s "$DIR/uninstall.bin") bytes)"

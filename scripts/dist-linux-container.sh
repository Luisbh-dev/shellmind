#!/usr/bin/env bash
# Runs inside the Linux build container (build/linux-builder.Dockerfile, started
# by scripts/dist-linux-docker.mjs) from the source it unpacked to /work:
# installs node_modules of its own, so that sqlite3 and node-pty are compiled
# against this container's old glibc, builds, packages the AppImage and the
# .deb into /out and smoke-tests both.
set -euo pipefail
cd /work

npm ci
# sqlite3's prebuilt binary needs glibc 2.38; this one needs what Debian 11 has.
node scripts/check-native.mjs --sqlite-from-source
npm run build
node scripts/dist.mjs --linux --x64 --out /out

shopt -s nullglob
packages=(/out/*.AppImage /out/*.deb)
if [ "${#packages[@]}" -ne 2 ]; then
    echo "Expected one AppImage and one .deb in /out, found: ${packages[*]:-none}" >&2
    exit 1
fi
for package in "${packages[@]}"; do
    node scripts/smoke-packaged.mjs "$package"
done

# The files belong to the user who started the build, not to the container's root.
if [ -n "${HOST_UID:-}" ]; then
    chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" /out
fi

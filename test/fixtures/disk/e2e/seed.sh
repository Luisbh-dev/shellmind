#!/bin/sh
# Fills the disk of a test server the way a disk-full incident looks:
# big data files, a log deleted while its writer still holds it open,
# rotated logs and core dumps from long ago, a package cache and (where the
# journal runs) archived journal files. Run as root inside the container.
set -e
# A date N days ago for touch -t (busybox touch knows no "N days ago").
ago() { date -d "@$(($(date +%s) - $1 * 86400))" +%Y%m%d%H%M; }
mkdir -p /srv/data/archive /srv/data/uploads /var/lib/systemd/coredump /var/log/app
head -c 125829120 /dev/zero > /srv/data/archive/backup-2026-09.tar
head -c 73400320 /dev/zero > /srv/data/uploads/video.mp4
head -c 2097152 /dev/zero > /srv/data/notes.txt
# Names with a newline in them (du and find print one path per line).
mkdir -p /srv/weird
head -c 1048576 /dev/zero > "/srv/weird/new
line.bin"
head -c 62914560 /dev/zero > "/srv/weird/big
video.mp4"
head -c 2097152 /dev/zero > /srv/weird/plain.bin
# Rotated logs, older than a week (and one recent one, which stays).
head -c 10485760 /dev/zero > /var/log/app/app.log.1
head -c 5242880 /dev/zero > /var/log/app/app.log.2.gz
head -c 1048576 /dev/zero > /var/log/app/app.log.3.gz
head -c 1048576 /dev/zero > /var/log/app/recent.log.1
touch -t "$(ago 20)" /var/log/app/app.log.1 /var/log/app/app.log.2.gz /var/log/app/app.log.3.gz
echo live > /var/log/app/app.log
# Core dumps.
head -c 31457280 /dev/zero > /var/lib/systemd/coredump/core.worker.1000.1.zst
touch -t "$(ago 3)" /var/lib/systemd/coredump/core.worker.1000.1.zst
# A package cache (apt-get clean removes the .deb files).
if [ -d /var/cache/apt ]; then
    mkdir -p /var/cache/apt/archives/partial
    head -c 20971520 /dev/zero > /var/cache/apt/archives/bigpkg_1.0_amd64.deb
    head -c 4194304 /dev/zero > /var/cache/apt/archives/smallpkg_2.1_amd64.deb
fi
if [ -d /var/cache/apk ]; then
    head -c 6291456 /dev/zero > /var/cache/apk/oldpkg-1.0-r0.6b1c0a5e.apk
fi
# A log deleted while a process still writes to it (50 MB held).
nohup sh -c 'exec 3>>/var/log/app/held.log; head -c 52428800 /dev/zero >&3; rm -f /var/log/app/held.log; exec sleep 100000' >/dev/null 2>&1 &
# Archived journal files.
if command -v systemd-cat >/dev/null 2>&1 && [ -S /run/systemd/journal/socket ]; then
    # Into the persistent journal (/var/log/journal), as after a boot.
    journalctl --flush >/dev/null 2>&1 || true
    i=0
    while [ $i -lt 4 ]; do
        head -c 3000000 /dev/urandom | od -An -tx1 | head -n 40000 | systemd-cat -t seed || true
        journalctl --rotate >/dev/null 2>&1 || true
        i=$((i + 1))
    done
fi
sleep 1
echo seeded

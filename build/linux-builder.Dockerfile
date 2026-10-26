# The Linux release build (scripts/dist-linux-docker.mjs). Debian 11 has
# glibc 2.31 and GCC 10: the native modules compiled here (sqlite3, node-pty)
# load on every distribution with glibc 2.31 or newer (Debian 11+, Ubuntu
# 20.04+, RHEL 9+, Fedora), unlike sqlite3's prebuilt binary (glibc 2.38) or
# anything compiled on a newer Linux. The node image brings Node.js 24,
# python3, make, g++ and git.
ARG BASE_IMAGE=node:24-bullseye
FROM ${BASE_IMAGE}

# The libraries Electron needs to start, for the packaged-app smoke test that
# runs here. Debian 11 is past its LTS and the mirrors dropped its security
# packages, so apt reads the snapshot of the Debian archive the image was
# built from (listed, commented out, in its sources.list): the very versions
# installed in the image, at a permanent address.
RUN set -eux; \
    if grep -q '^# deb http://snapshot.debian.org' /etc/apt/sources.list; then \
        sed -i -e 's|^deb http://deb.debian.org|# deb http://deb.debian.org|' -e 's|^# deb http://snapshot.debian.org|deb http://snapshot.debian.org|' /etc/apt/sources.list; \
    fi; \
    apt-get -o Acquire::Check-Valid-Until=false update; \
    apt-get install -y --no-install-recommends \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libnotify4 libnss3 \
        libsecret-1-0 libxkbcommon0 libxshmfence1 libxss1 libxtst6 xdg-utils; \
    rm -rf /var/lib/apt/lists/*

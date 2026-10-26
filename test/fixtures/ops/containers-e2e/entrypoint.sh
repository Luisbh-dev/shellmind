#!/bin/sh
# The inner engine stores images in plain directories (vfs): slow, but it works
# on any outer filesystem, and the test images are tiny.
dockerd --storage-driver=vfs >/var/log/dockerd.log 2>&1 &
exec /usr/sbin/sshd -D -e

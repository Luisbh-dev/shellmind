#!/bin/sh
# PID 1 of the patch test hosts: keeps sshd running (a package scriptlet that
# signals PID 1, as glibc's does on the RHEL family, must not stop the host)
# and ends the container when /usr/sbin/reboot asks it to (SIGUSR1): Docker
# starts it again (--restart=always), which over SSH looks like a reboot.
trap 'exit 0' USR1
mkdir -p /run/sshd
while :; do
    /usr/sbin/sshd -D -e &
    wait
    sleep 1
done

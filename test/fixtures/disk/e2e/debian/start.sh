#!/bin/sh
# The journal daemon on its own (there is no systemd as PID 1 in the
# container), so journalctl has a persistent journal to measure and vacuum.
/lib/systemd/systemd-journald >/dev/null 2>&1 &
exec /usr/sbin/sshd -D -e

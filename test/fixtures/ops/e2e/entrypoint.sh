#!/bin/sh
# A log file that keeps growing, for the live tail tests.
touch /tmp/ops-calls.log
chmod 666 /tmp/ops-calls.log
(while :; do echo "$(date '+%Y-%m-%dT%H:%M:%S') app[42]: tick" >> /var/log/ticker.log; sleep 0.5; done) &
exec /usr/sbin/sshd -D -e

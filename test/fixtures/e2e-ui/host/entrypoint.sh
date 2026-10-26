#!/bin/sh
# The page the tunnels test fetches through its forwarded port, named after
# the host so the test knows which server answered.
printf 'tunnel says hello from %s\n' "$(hostname)" > /srv/www/hello.txt
httpd -p 127.0.0.1:8080 -h /srv/www
# A log that keeps growing, for the live logs view.
(
    i=0
    while :; do
        i=$((i + 1))
        echo "$(date -Iseconds) e2e-app tick $i" >> /var/log/e2e/app.log
        sleep 0.5
    done
) &
exec /usr/sbin/sshd -D -e

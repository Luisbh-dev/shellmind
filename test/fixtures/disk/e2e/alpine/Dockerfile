# Disk toolkit end to end: an Alpine server (busybox du, find, stat and ls;
# no lsof, so deleted files are found in /proc) with an apk package cache.
# Users: root (rootpw) and ops (opspw, passwordless sudo).
FROM alpine:3.20
RUN apk add --no-cache openssh sudo \
    && ssh-keygen -A \
    && echo 'root:rootpw' | chpasswd \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && adduser -D -s /bin/sh ops && echo 'ops:opspw' | chpasswd \
    && echo 'ops ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ops && chmod 0440 /etc/sudoers.d/ops \
    && mkdir -p /var/cache/apk && ln -s /var/cache/apk /etc/apk/cache
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]

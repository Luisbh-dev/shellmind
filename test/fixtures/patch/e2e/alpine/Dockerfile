# Patch center end-to-end host (test/e2e/patch-distros.test.ts): Alpine 3.20.0
# with openssh and sudo. Everything else stays at 3.20.0 and the package index
# fetched here stays in /var/cache/apk, so updates are pending.
# Users: ops (sudo without a password).
FROM alpine:3.20.0
RUN apk update && apk add openssh sudo \
    && ssh-keygen -A \
    && adduser -D -s /bin/sh ops && echo 'ops:opspw' | chpasswd \
    && echo 'ops ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/ops \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
COPY init.sh /init.sh
COPY reboot /tmp/reboot
# The real reboot may be a symlink (to busybox, systemctl): replace the link, not its target.
RUN rm -f /sbin/reboot && mv /tmp/reboot /sbin/reboot && chmod 755 /init.sh /sbin/reboot
EXPOSE 22
CMD ["/init.sh"]

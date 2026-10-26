# Patch center end-to-end host (test/e2e/patch-distros.test.ts): Ubuntu 24.04
# as released (April 2024) with openssh and sudo. Everything else stays as it
# was and the package lists fetched here stay in the image, so updates
# (security ones too) are pending. Users: ops (sudo without a password).
FROM ubuntu:noble-20240423
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server sudo \
    && useradd -m -s /bin/bash ops && echo 'ops:opspw' | chpasswd \
    && echo 'ops ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/ops \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
COPY init.sh /init.sh
COPY reboot /tmp/reboot
# The real reboot may be a symlink (to busybox, systemctl): replace the link, not its target.
RUN rm -f /usr/sbin/reboot && mv /tmp/reboot /usr/sbin/reboot && chmod 755 /init.sh /usr/sbin/reboot
EXPOSE 22
CMD ["/init.sh"]

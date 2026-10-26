# Patch center end-to-end host (test/e2e/patch-distros.test.ts): Debian 12.1
# with openssh and sudo. Everything else stays at 12.1 and the package lists
# fetched here stay in the image, so updates (security ones too) are pending.
# Users: ops (sudo without a password), asker (sudo asks for one).
FROM debian:12.1
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server sudo \
    && useradd -m -s /bin/bash ops && echo 'ops:opspw' | chpasswd \
    && echo 'ops ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/ops \
    && useradd -m -s /bin/bash asker && echo 'asker:askerpw' | chpasswd \
    && echo 'asker ALL=(ALL) ALL' > /etc/sudoers.d/asker \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
COPY init.sh /init.sh
COPY reboot /tmp/reboot
# The real reboot may be a symlink (to busybox, systemctl): replace the link, not its target.
RUN rm -f /usr/sbin/reboot && mv /tmp/reboot /usr/sbin/reboot && chmod 755 /init.sh /usr/sbin/reboot
EXPOSE 22
CMD ["/init.sh"]

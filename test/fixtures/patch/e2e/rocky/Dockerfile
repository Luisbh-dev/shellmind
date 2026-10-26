# Patch center end-to-end host (test/e2e/patch-distros.test.ts): Rocky Linux
# 9.0 with openssh and sudo. Everything else stays at 9.0 and the metadata
# cache filled here stays in the image, so updates (security ones too) are
# pending. Users: ops (sudo without a password).
FROM rockylinux:9.0
RUN dnf -y install openssh-server sudo passwd \
    && dnf -y makecache \
    && ssh-keygen -A \
    && useradd -m ops && echo 'ops:opspw' | chpasswd \
    && echo 'ops ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/ops \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && rm -f /run/nologin
COPY init.sh /init.sh
COPY reboot /tmp/reboot
# The real reboot may be a symlink (to busybox, systemctl): replace the link, not its target.
RUN rm -f /usr/sbin/reboot && mv /tmp/reboot /usr/sbin/reboot && chmod 755 /init.sh /usr/sbin/reboot
EXPOSE 22
CMD ["/init.sh"]

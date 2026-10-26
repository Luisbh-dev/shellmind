# Test host for the status and operations end-to-end tests (test/e2e/ops-sshd.test.ts):
# a real sshd and busybox userland, plus stand-ins for systemctl, journalctl
# and docker that print realistic output and log every call to /tmp/ops-calls.log.
FROM alpine:3
RUN apk add --no-cache openssh sudo \
    && ssh-keygen -A \
    && adduser -D -s /bin/sh ops \
    && echo 'root:rootpw' | chpasswd \
    && echo 'ops:opspw' | chpasswd \
    && echo 'ops ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/ops \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/; s/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && mkdir -p /run/systemd/system
COPY bin/ /usr/local/bin/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /usr/local/bin/* /entrypoint.sh
EXPOSE 22
CMD ["/entrypoint.sh"]

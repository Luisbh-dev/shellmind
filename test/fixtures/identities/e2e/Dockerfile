# Test host for the identities end-to-end test (test/e2e/identities-sshd.test.ts):
# a real OpenSSH server (StrictModes on, agent forwarding allowed) with
# ssh-add for checking a forwarded agent, and two password users.
FROM alpine:3
RUN apk add --no-cache openssh \
    && ssh-keygen -A \
    && adduser -D -s /bin/sh alice \
    && adduser -D -s /bin/sh bob \
    && echo 'alice:alicepw' | chpasswd \
    && echo 'bob:bobpw' | chpasswd \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/; s/^#\?AllowAgentForwarding.*/AllowAgentForwarding yes/; s/^#\?StrictModes.*/StrictModes yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]

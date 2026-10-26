# Test host of the end-to-end UI suite (test/e2e-ui): a real OpenSSH server on
# Alpine 3.20.0 with bash, sudo and a few services the panels look at.
#   demo     bash, passwordless sudo (terminal, files, status, operations, ...)
#   keyuser  sh, for the identities test (its key gets installed by the app)
# The package index fetched here stays in /var/cache/apk while the base
# packages stay at 3.20.0, so the patch center finds pending updates. The
# entrypoint serves /srv/www on 127.0.0.1:8080 (the tunnels test) and appends
# to /var/log/e2e/app.log twice a second (live logs). No systemd: the services
# view says so.
FROM alpine:3.20.0
RUN apk update && apk add openssh bash sudo busybox-extras \
    && ssh-keygen -A \
    && adduser -D -s /bin/bash demo && echo 'demo:demopw' | chpasswd \
    && echo 'demo ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/demo && chmod 0440 /etc/sudoers.d/demo \
    && adduser -D -s /bin/sh keyuser && echo 'keyuser:keypw' | chpasswd \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/; s/^#\?AllowTcpForwarding.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config \
    && printf 'export PS1="\\u@\\h:\\w\\$ "\nexport LANG=C.UTF-8\n' > /home/demo/.bashrc \
    && printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > /home/demo/.bash_profile \
    && mkdir -p /home/demo/projects /srv/www /var/log/e2e \
    && printf 'readme of the e2e host\n' > /home/demo/projects/readme.txt \
    && printf 'name: e2e\nreplicas: 1\n' > /home/demo/projects/config.yaml \
    && chown -R demo:demo /home/demo
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
CMD ["/entrypoint.sh"]

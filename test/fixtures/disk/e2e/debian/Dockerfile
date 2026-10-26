# Disk toolkit end to end (test/e2e/disk-docker.test.ts): a Debian server
# with OpenSSH, sudo, lsof and the systemd journal tools. Users: root
# (rootpw), ops (opspw, passwordless sudo) and plain (plainpw, no sudo).
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server sudo lsof procps systemd \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /var/log/journal \
    && echo 'root:rootpw' | chpasswd \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && useradd -m -s /bin/bash ops && echo 'ops:opspw' | chpasswd \
    && echo 'ops ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ops && chmod 0440 /etc/sudoers.d/ops \
    && useradd -m -s /bin/bash plain && echo 'plain:plainpw' | chpasswd \
    && mkdir -p /root/private && chmod 700 /root
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh
EXPOSE 22
CMD ["/usr/local/bin/start.sh"]

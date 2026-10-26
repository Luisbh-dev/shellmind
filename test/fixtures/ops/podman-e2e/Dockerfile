# Test host for the Podman end-to-end tests (test/e2e/containers-podman.test.ts):
# sshd in front of Podman (run with --privileged) and podman-compose, the
# Podman side of the container shells, Compose projects and images.
FROM quay.io/podman/stable:latest
RUN dnf install -y openssh-server podman-compose procps-ng && dnf clean all \
    && ssh-keygen -A \
    && echo 'root:rootpw' | chpasswd \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/; s/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && rm -f /run/nologin
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]

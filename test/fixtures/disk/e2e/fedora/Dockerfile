# Disk toolkit end to end: a Fedora server with dnf (and its cache) for
# the package-cache cleanup. User: root (rootpw).
FROM fedora:41
RUN dnf install -y --setopt=install_weak_deps=False openssh-server procps-ng findutils \
    && ssh-keygen -A \
    && echo 'root:rootpw' | chpasswd \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]

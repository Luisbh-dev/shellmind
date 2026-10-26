# Test host for the Kubernetes end-to-end test (test/e2e/k8s-k3s.test.ts): a
# real OpenSSH server (a bastion) whose users reach a k3s cluster, another
# container of the test, with the official kubectl. `demo` has a kubeconfig
# in ~/.kube; `ops` has none but may use sudo without a password (root's
# kubeconfig is the cluster's); `nokube` has neither.
FROM alpine:3
ADD --chmod=755 https://dl.k8s.io/release/v1.31.4/bin/linux/amd64/kubectl /usr/local/bin/kubectl
RUN apk add --no-cache openssh sudo \
    && ssh-keygen -A \
    && adduser -D -s /bin/sh demo \
    && adduser -D -s /bin/sh ops \
    && adduser -D -s /bin/sh nokube \
    && echo 'demo:demo' | chpasswd \
    && echo 'ops:ops' | chpasswd \
    && echo 'nokube:nokube' | chpasswd \
    && echo 'ops ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/ops \
    && mkdir -p /home/demo/.kube /root/.kube \
    && chown -R demo:demo /home/demo/.kube \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]

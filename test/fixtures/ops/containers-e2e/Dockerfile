# Test host for the containers end-to-end tests (test/e2e/containers-dind.test.ts):
# a real sshd in front of its OWN Docker engine (Docker in Docker, run with
# --privileged), so container shells, Compose projects and image pruning run
# for real without ever touching the engine of the machine running the tests.
#   ops  is in the docker group (the engine is used directly)
#   dev  is not, but has passwordless sudo (the app goes through sudo -n docker)
FROM alpine:3
RUN apk add --no-cache openssh sudo docker docker-cli-compose bash \
    && ssh-keygen -A \
    && adduser -D -s /bin/sh ops \
    && addgroup ops docker \
    && adduser -D -s /bin/bash dev \
    && echo 'ops:opspw' | chpasswd \
    && echo 'dev:devpw' | chpasswd \
    && echo 'dev ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/dev \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
CMD ["/entrypoint.sh"]

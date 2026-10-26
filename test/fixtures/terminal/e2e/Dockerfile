# Test host for the split panes and broadcast input end-to-end test
# (test/e2e/terminal-broadcast-sshd.test.ts): a real sshd with bash, and sudo
# that asks for the user's password (the password prompt broadcast input
# must never type into). Bash writes each command to its history file at
# the next prompt, so the test sees what every shell really ran.
FROM alpine:3
RUN apk add --no-cache openssh bash sudo \
    && ssh-keygen -A \
    && adduser -D -s /bin/bash demo \
    && echo 'demo:demopw' | chpasswd \
    && echo 'demo ALL=(ALL) ALL' > /etc/sudoers.d/demo \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && printf 'export PS1="\\u@\\h:\\w\\$ "\nPROMPT_COMMAND="history -a"\n' > /home/demo/.bashrc \
    && printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > /home/demo/.bash_profile \
    && chown -R demo:demo /home/demo
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]

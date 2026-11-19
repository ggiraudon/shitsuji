#!/bin/sh
# sandboxd's entrypoint (F08, S46). It runs as root once, so it can make the files writable by the
# command user and put the sandbox token where only the daemon can read it; then it starts the daemon
# as uid 1001, keeping just the capabilities commands and stops need.
#
# Why uid separation: /proc/<pid>/environ keeps a process's startup environment, so a token kept in
# the daemon's environment (or in a file the same uid can read) is readable by anything running as
# that uid. The daemon is 1001, commands are 1000, and the token file is 0400 owned by 1001.
#
# The container needs only these capabilities (compose uses cap_drop: ALL + cap_add):
#   CHOWN   chown the token file and the workspace
#   FOWNER  chmod files in the workspace that core created
#   SETUID  start the daemon as 1001 and each command as 1000
#   SETGID  the same, for the group
#   SETPCAP set the daemon's ambient capabilities and empty each command's bounding set
#   KILL    stop a command that runs as another uid
set -eu

TOKEN_FILE="${SANDBOX_TOKEN_FILE:-/run/sandbox/token}"

mkdir -p "$(dirname "$TOKEN_FILE")"
# Write the token while the folder is root-owned: as root without DAC_OVERRIDE, writing into a
# folder owned by someone else would be denied.
chown root:root "$(dirname "$TOKEN_FILE")"
chmod 0755 "$(dirname "$TOKEN_FILE")"
if [ -n "${SANDBOX_TOKEN:-}" ]; then
  printf '%s' "$SANDBOX_TOKEN" > "$TOKEN_FILE"
fi
unset SANDBOX_TOKEN

if [ ! -s "$TOKEN_FILE" ]; then
  echo "sandbox: SANDBOX_TOKEN (or SANDBOX_TOKEN_FILE) is required; refusing to start without authentication" >&2
  exit 1
fi
chown 1001:1000 "$TOKEN_FILE"
chmod 0400 "$TOKEN_FILE"
chown 1001:1000 "$(dirname "$TOKEN_FILE")"
chmod 0700 "$(dirname "$TOKEN_FILE")"

# The workspace is owned by the command user; group write (and the daemon's umask 0002) lets the
# daemon's files API write there too, and the recursive chmod repairs files core created as 0644.
mkdir -p /workspace /handoff
chown 1000:1000 /workspace /handoff
chmod 2770 /workspace
chmod 2750 /handoff
chmod -R g+rwX /workspace /handoff 2>/dev/null || true

export SANDBOX_TOKEN_FILE="$TOKEN_FILE"
export SANDBOX_COMMAND_UID="${SANDBOX_COMMAND_UID:-1000}"
export SANDBOX_COMMAND_GID="${SANDBOX_COMMAND_GID:-1000}"
export SANDBOX_COMMAND_HOME="${SANDBOX_COMMAND_HOME:-/home/agent}"
export SANDBOX_COMMAND_USER="${SANDBOX_COMMAND_USER:-agent}"

# The daemon keeps SETUID/SETGID (to start commands as 1000), SETPCAP (to empty their bounding set)
# and KILL (to stop them); every command drops all of them through setpriv (see exec.ts).
exec setpriv \
  --reuid=1001 --regid=1000 --init-groups \
  --inh-caps=+setuid,+setgid,+setpcap,+kill \
  --ambient-caps=+setuid,+setgid,+setpcap,+kill \
  node /app/dist/main.js

#!/bin/sh
# sandboxd's entrypoint (F08, S46). It runs as root once, so it can make the files writable by the
# command user and install the sandbox token where only the daemon can read it; then it starts the
# daemon as uid 1001, keeping just the capabilities commands and stops need.
#
# Why uid separation: /proc/<pid>/environ keeps a process's startup environment, so a token kept in
# the daemon's environment (or in a file the same uid can read) is readable by anything running as
# that uid. The daemon is 1001, commands are 1000, and the token is 0400 owned by 1001 inside a 0700
# folder. That folder is a tmpfs in Compose (the root filesystem is read-only).
#
# Two ways to give the daemon its token:
#   - Compose mounts the `sandbox-secret` volume read-only at /run/sandbox-seed. Its root is
#     root:1002 0770 and the token is 0644; only this root entrypoint (the directory's owner) can
#     read it, while commands (uid 1000, no group 1002) cannot even traverse the directory.
#   - CI and development set SANDBOX_TOKEN and this script writes /run/sandbox/token itself.
#
# The container needs only these capabilities (compose uses cap_drop: ALL + cap_add):
#   CHOWN   chown the token file and the workspace
#   FOWNER  chmod files in the workspace that core created, and the token folder
#   SETUID  start the daemon as 1001 and each command as 1000
#   SETGID  the same, for the group
#   SETPCAP set the daemon's ambient capabilities and empty each command's bounding set
#   KILL    stop a command that runs as another uid
#
# It has no DAC_OVERRIDE, so it opens the token folder while it installs the token, then closes it
# before sandboxd (and therefore any command) starts.
set -eu

TOKEN_FILE="${SANDBOX_TOKEN_FILE:-/run/sandbox/token}"
TOKEN_DIR="$(dirname "$TOKEN_FILE")"
SEED_FILE="${SANDBOX_TOKEN_SEED:-/run/sandbox-seed/token}"

# A fresh stack starts the sandbox before core has generated the token; wait instead of looping.
waited=0
while [ ! -s "$SEED_FILE" ] && [ -z "${SANDBOX_TOKEN:-}" ] && [ "$waited" -lt 60 ]; do
  sleep 1
  waited=$((waited + 1))
done

# Open the folder while the token is installed; root here has FOWNER and CHOWN but not DAC_OVERRIDE.
chown root:root "$TOKEN_DIR" 2>/dev/null || true
chmod 0755 "$TOKEN_DIR" 2>/dev/null || true
if [ -s "$SEED_FILE" ]; then
  cp "$SEED_FILE" "$TOKEN_FILE"
elif [ -n "${SANDBOX_TOKEN:-}" ]; then
  printf '%s' "$SANDBOX_TOKEN" > "$TOKEN_FILE"
else
  echo "sandbox: no token: mount one at $SEED_FILE or set SANDBOX_TOKEN; refusing to start without authentication" >&2
  exit 1
fi
unset SANDBOX_TOKEN
chown 1001:1000 "$TOKEN_FILE"
chmod 0400 "$TOKEN_FILE"
chown 1001:1000 "$TOKEN_DIR"
chmod 0700 "$TOKEN_DIR"

# The workspace is owned by the command user; group write (and the daemon's umask 0002) lets the
# daemon's files API write there too. Root here has FOWNER but no DAC_OVERRIDE, so the recursive
# repair runs while the folder is still traversable by root; then it is closed again for commands.
mkdir -p /workspace /handoff
chmod 2775 /workspace 2>/dev/null || true
chmod -R g+rwX /workspace 2>/dev/null || true
chown 1000:1000 /workspace
chmod 2770 /workspace

# Debian marks the system Python as externally managed (PEP 668), so pip installs go into a venv in
# the persistent home volume. Create it once, on first start, and give it back to the command user.
if [ ! -x /home/agent/.venv/bin/python ]; then
  echo "sandbox: creating the Python virtualenv in /home/agent/.venv" >&2
  chown -R root:root /home/agent
  python3 -m venv --clear /home/agent/.venv
  chown -R 1000:1000 /home/agent
fi

# /handoff is mounted read-only in Compose, so its mode cannot change; core-created files are
# world-readable, which is what commands need. chmod failing with EROFS is the signal to leave it.
if chmod 2750 /handoff 2>/dev/null; then
  chown 1000:1000 /handoff 2>/dev/null || true
  chmod -R g+rwX /handoff 2>/dev/null || true
fi

export SANDBOX_TOKEN_FILE="$TOKEN_FILE"
export SANDBOX_COMMAND_UID="${SANDBOX_COMMAND_UID:-1000}"
export SANDBOX_COMMAND_GID="${SANDBOX_COMMAND_GID:-1000}"
export SANDBOX_COMMAND_HOME="${SANDBOX_COMMAND_HOME:-/home/agent}"
export SANDBOX_COMMAND_USER="${SANDBOX_COMMAND_USER:-agent}"

# The daemon keeps SETUID/SETGID (to start commands as 1000), SETPCAP (to empty their bounding set)
# and KILL (to stop them); every command drops all of them through setpriv (see exec.ts).
# The desktop layer replaces this final step with its supervisor; the base image has no such file.
if [ -x /usr/local/bin/sandbox-desktop ]; then
  exec /usr/local/bin/sandbox-desktop
fi
exec setpriv \
  --reuid=1001 --regid=1000 --init-groups \
  --inh-caps=+setuid,+setgid,+setpcap,+kill \
  --ambient-caps=+setuid,+setgid,+setpcap,+kill \
  node /app/dist/main.js

# syntax=docker/dockerfile:1
# Shitsuji's desktop layer (F10, S50). Build after the sandbox image:
#   docker build -f docker/sandbox/Dockerfile -t shitsuji/sandbox .
#   docker build -f docker/sandbox-desktop/Dockerfile -t shitsuji/sandbox-desktop .
#
# Supervisor: supervisord (Debian's `supervisor` package) because one small config can start the
# desktop programs as uid 1000 and sandboxd as uid 1001. s6-overlay would add a tarball and a root
# init for no extra benefit; Compose's `init: true` already reaps zombies. The root entrypoint still
# does the token/workspace/venv repairs first; `sandbox-desktop` only installs the VNC passwords and
# hands over to supervisord.
#
# Xvnc (TigerVNC) serves one password and one mode. The two passwords below (view-only and full
# control) need two VNC servers on one display, so this image uses Xvfb + two x11vnc instances. The
# VNC servers run as uid 1001 so they can read the 0400 password files; commands run as uid 1000
# and cannot read them.

FROM shitsuji/sandbox

ENV DISPLAY=:0 \
    SCREEN=1440x900x24 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-session \
    XDG_RUNTIME_DIR=/tmp/runtime-agent \
    XDG_SESSION_TYPE=x11 \
    XDG_CURRENT_DESKTOP=XFCE \
    GTK_MODULES=gail:atk-bridge \
    NO_AT_BRIDGE=0 \
    QT_ACCESSIBILITY=1 \
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 \
    SAL_USE_VCLPLUGIN=gtk3

# The desktop stack is the explicit package list below (no recommends): it is what a lockfile would
# record, while the base image pins the OS image itself by digest so a rebuild does not change the
# Debian release. Versions are not frozen: Debian's security updates must be allowed in.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    at-spi2-core \
    chromium \
    dbus \
    dbus-x11 \
    desktop-file-utils \
    fonts-dejavu \
    fonts-liberation \
    fonts-noto-color-emoji \
    gir1.2-atspi-2.0 \
    libglib2.0-bin \
    libreoffice \
    libreoffice-calc \
    libreoffice-gtk3 \
    libreoffice-writer \
    python3-gi \
    scrot \
    supervisor \
    thunar \
    websockify \
    wmctrl \
    x11-utils \
    x11vnc \
    xauth \
    xclip \
    xdotool \
    xdg-utils \
    xfce4 \
    xfce4-panel \
    xfce4-session \
    xfce4-settings \
    xfce4-terminal \
    xfwm4 \
    xvfb \
 && rm -rf /var/lib/apt/lists/*

# The desktop packages bring back setuid helpers (Chromium's sandbox, for one). The base image
# strips them; do it again after installing, and never add a capability.
RUN find / -xdev -perm -4000 -exec chmod u-s {} +

RUN mkdir -p /etc/supervisor/conf.d
COPY --chmod=0755 docker/sandbox-desktop/sandbox-desktop /usr/local/bin/sandbox-desktop
COPY --chmod=0755 docker/sandbox-desktop/start-sandboxd /usr/local/bin/start-sandboxd
COPY --chmod=0644 docker/sandbox-desktop/supervisord.conf /etc/supervisor/supervisord.conf

# The sandbox network only: no ports are published. websockify serves the raw WebSocket; core
# serves the viewer page and relays it through sandboxd-gateway (S51).
EXPOSE 6080 6081
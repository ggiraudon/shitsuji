#!/usr/bin/env python3
"""Keep every window inside the virtual screen (F10, S56).

Xvfb has a fixed screen size and XFCE places some dialogs larger than it: on a 1440x900 screen
LibreOffice's Save dialog opened 888 px tall at y=85, so its buttons sat below the bottom edge and a
pixel click could not reach them. The default screen is now 1920x1080, and this watcher is the safety
net for anything an app still opens past an edge: it moves the window back and shrinks it to fit the
work area (the screen minus the XFCE panel). xfwm4 has no setting for "fit an oversized window" (its
wrap options only apply while you drag one), so a small poller is the portable way to do it.

The frame extents matter: xfwm4 keeps the titlebar below the panel, and a client that is as tall as
the work area still hangs its titlebar and bottom border outside it. So the limits are the work area
minus the frame decorations. A window that already fits is never touched, and a window that ignores a
request once (an app's minimum size can be larger than the request) is not asked again until its
geometry changes, so the watcher never spins or fights the app.

It runs as uid 1000 on the display, next to XFCE.
"""

import re
import subprocess
import time

POLL_SECONDS = 1.0


def output(*command):
    return subprocess.run(command, capture_output=True, text=True, timeout=5, check=True).stdout


def number(text, label):
    match = re.search(rf'{label}:\s*(-?\d+)', text)
    if match is None:
        raise ValueError(f'no {label} in xwininfo output')
    return int(match.group(1))


def screen_and_work_area():
    """(screen width, screen height, (x, y, width, height) of the work area)."""
    width, height = output('xdotool', 'getdisplaygeometry').split()
    work = (0, 0, int(width), int(height))
    text = output('xprop', '-root', '_NET_WORKAREA')
    if '=' in text:
        # One group of four per desktop: x, y, width, height.
        values = [int(value.rstrip(',')) for value in text.split('=')[1].split()[:4]]
        if len(values) == 4 and values[2] > 0 and values[3] > 0:
            work = tuple(values)
    return int(width), int(height), work


def windows():
    """Yield (id, x, y, width, height) for every managed window, in client coordinates."""
    for line in output('wmctrl', '-l').splitlines():
        window_id = line.split(None, 1)[0]
        try:
            info = output('xwininfo', '-id', window_id)
            yield (
                window_id,
                number(info, 'Absolute upper-left X'),
                number(info, 'Absolute upper-left Y'),
                number(info, 'Width'),
                number(info, 'Height'),
            )
        except (ValueError, subprocess.SubprocessError):
            continue  # the window vanished between listing it and asking for its geometry


def window_types(window_id):
    """The EWMH types of a window, such as {'NORMAL'} or {'DOCK'}."""
    text = output('xprop', '-id', window_id, '_NET_WM_WINDOW_TYPE')
    if '=' not in text:
        return set()
    return {
        value.removeprefix('_NET_WM_WINDOW_TYPE_')
        for value in text.split('=', 1)[1].split()
    }


def frame_extents(window_id):
    """(left, right, top, bottom) decoration sizes; zeros when the WM publishes none."""
    text = output('xprop', '-id', window_id, '_NET_FRAME_EXTENTS')
    if '=' not in text:
        return 0, 0, 0, 0
    values = [int(value.rstrip(',')) for value in text.split('=')[1].split()[:4]]
    return tuple(values) if len(values) == 4 else (0, 0, 0, 0)


def fit(x, y, width, height, work, extents):
    """The client geometry clamped into the work area; == the input when it already fits."""
    work_x, work_y, work_width, work_height = work
    left, right, top, bottom = extents
    width = min(width, max(1, work_width - left - right))
    height = min(height, max(1, work_height - top - bottom))
    min_x = work_x + left
    min_y = work_y + top
    max_x = max(min_x, work_x + work_width - right - width)
    max_y = max(min_y, work_y + work_height - bottom - height)
    return min(max(x, min_x), max_x), min(max(y, min_y), max_y), width, height


def main():
    # window id -> (the geometry we last saw, the geometry we then asked for)
    asked = {}
    last_error = ''
    while True:
        try:
            _, _, work = screen_and_work_area()
            seen = set()
            for window_id, x, y, width, height in windows():
                seen.add(window_id)
                if width <= 0 or height <= 0:
                    continue
                # The desktop, the panel and tooltips are not windows to move: the desktop window is
                # as large as the screen by design, and the panel can be parked off-screen to hide.
                types = window_types(window_id)
                if types and not types & {'NORMAL', 'DIALOG'}:
                    continue
                target = fit(x, y, width, height, work, frame_extents(window_id))
                current = (x, y, width, height)
                # Skip a window that already fits, and one that ignored the same request last time.
                if target == current or asked.get(window_id) == (current, target):
                    continue
                asked[window_id] = (current, target)
                print(
                    f'fit-windows: {window_id} {current} -> {target}'.replace('(', '').replace(')', ''),
                    flush=True,
                )
                subprocess.run(
                    [
                        'wmctrl', '-i', '-r', window_id, '-e',
                        '0,{},{},{},{}'.format(*target),
                    ],
                    capture_output=True, text=True, timeout=5,
                )
            for window_id in list(asked):
                if window_id not in seen:
                    del asked[window_id]
        except Exception as error:  # X not up yet, or a window vanished mid-read
            if str(error) != last_error:  # one line per distinct problem, not one a second
                print(f'fit-windows: {error}', flush=True)
                last_error = str(error)
        else:
            last_error = ''
        time.sleep(POLL_SECONDS)


if __name__ == '__main__':
    main()

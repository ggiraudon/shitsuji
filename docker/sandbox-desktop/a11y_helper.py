#!/usr/bin/env python3
"""The AT-SPI helper (F10, S54).

`sandboxd` starts one process and talks to it with JSON lines over stdin/stdout:

    {"id": 1, "op": "ping"}
    {"id": 2, "op": "apps"}
    {"id": 3, "op": "tree", "window": "Thunar", "depth": 4}
    {"id": 4, "op": "find", "window": "Thunar", "role": "push button"}
    {"id": 5, "op": "act", "snapshot": "s3", "ref": "e12", "action": "click"}

Every reply carries the same `id`. Refusals are `{"id": n, "error": {"code": ...,
"message": ...}}`; a refusal never contains an AT-SPI object path or a traceback.

It runs as uid 1000, not as the daemon's uid 1001: the session D-Bus accepts clients
of the uid that owns the bus, and the desktop session's bus is uid 1000's. It
therefore also has no access to the daemon's token or the VNC passwords, and every
string it returns is untrusted.

The snapshot table lives here. A ref is `eN` and maps to a private child-index path;
the AT-SPI object path never leaves the helper. A snapshot is bound to the
application's current event generation, so a structural change (a child added or
removed, a window created or destroyed, a changed name) makes an old ref answer
"stale, take a new snapshot". A snapshot also keeps the accessible itself, so an
act checks that element instead of walking back down from the desktop root.

A node whose element is not rendered (`STATE_SHOWING` false) or whose centre lies
past the screen edge (a dialog taller than the display, so its bottom buttons are
cut off) carries the `offscreen` state: a pixel click at its centre cannot reach
it, while the AT-SPI action still can.
"""

import json
import subprocess
import sys

import pyatspi
from gi.repository import GLib

VERSION = 1

# The node and text caps keep one reply inside what sandboxd will accept (S54). A Calc sheet can
# publish tens of thousands of cells; a lower visit cap keeps one window's tree inside the deadline.
MAX_NODES = 1500
MAX_VISITED = 3000
MAX_NAME = 160
MAX_VALUE = 240
MAX_SNAPSHOTS = 32

# Event generation per application: a structural change bumps the app's counter.
GENERATIONS = {}
# A structural event whose application could not be named bumps this; rare (a closed
# window), and it makes every snapshot stale rather than risking a wrong click.
EPOCH = 0

# The latest snapshot per window, for a sub-tree request by ref.
LATEST = {}
# snapshot id -> {app, generation, epoch, window, frame_path, refs}
SNAPSHOTS = {}
NEXT_SNAPSHOT = 0


class HelperError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def children(accessible):
    """The accessible's children, tolerating an app that dies mid-walk."""
    try:
        count = accessible.getChildCount()
    except Exception:
        return
    for index in range(count):
        try:
            yield accessible.getChildAtIndex(index)
        except Exception:
            return


def role_of(accessible):
    try:
        return accessible.getRoleName() or "unknown"
    except Exception:
        return "unknown"


def name_of(accessible):
    try:
        name = accessible.name
        return name if isinstance(name, str) else ""
    except Exception:
        return ""


def app_name_of(accessible):
    try:
        application = accessible.getApplication()
        return application.name if application is not None else None
    except Exception:
        return None


def truncate(text, limit):
    if not isinstance(text, str):
        return ""
    text = text.replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()
    return text[:limit]


def text_value(accessible, role):
    """The element's displayed or editable text, for roles where that is the value."""
    if role not in (
        "text",
        "label",
        "entry",
        "text field",
        "password text",
        "paragraph",
        "heading",
        "link",
        "table cell",
        "cell",
        "document text",
        "static",
    ):
        return ""
    try:
        text = accessible.queryText()
        count = min(text.characterCount, MAX_VALUE)
        return truncate(text.getText(0, count), MAX_VALUE)
    except Exception:
        return ""


def states_of(accessible, actions=()):
    wanted = (
        ("checked", pyatspi.STATE_CHECKED),
        ("focused", pyatspi.STATE_FOCUSED),
        ("selected", pyatspi.STATE_SELECTED),
        ("expanded", pyatspi.STATE_EXPANDED),
        ("editable", pyatspi.STATE_EDITABLE),
    )
    found = []
    try:
        state = accessible.getState()
    except Exception:
        return found
    try:
        if not state.contains(pyatspi.STATE_ENABLED):
            found.append("disabled")
    except Exception:
        pass
    for label, flag in wanted:
        try:
            if state.contains(flag):
                found.append(label)
        except Exception:
            continue
    try:
        showing = state.contains(pyatspi.STATE_SHOWING)
    except Exception:
        showing = None
    # Only an element the agent can act on needs the screen check: it is the one a pixel click
    # would target, and asking LibreOffice for extents is not free. A non-rendered element is
    # known to be off-screen from the state alone.
    actionable = bool(actions) or "editable" in found
    if showing is False or (showing and actionable and outside_screen(accessible)):
        # A pixel click at the element's position cannot land on it: it is scrolled out, or the
        # window extends past the screen (S56). The AT-SPI action still works on it.
        found.append("offscreen")
    return found


def screen_size():
    """The X screen in pixels, once at start; None when it cannot be asked."""
    try:
        width, height = subprocess.run(
            ["/usr/bin/xdotool", "getdisplaygeometry"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout.split()
        return int(width), int(height)
    except Exception:
        return None


SCREEN = screen_size()


def outside_screen(accessible):
    """True when the element has a centre that is not on the screen.

    The centre is what a coordinate click taken from the element's box would target, so a button
    whose bottom half hangs past the edge is not reachable that way, while one that is merely
    clipped at the very edge still is.
    """
    if SCREEN is None:
        return False
    try:
        extents = accessible.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    except Exception:
        return False
    if extents.width <= 0 or extents.height <= 0:
        return False
    width, height = SCREEN
    centre_x = extents.x + extents.width / 2
    centre_y = extents.y + extents.height / 2
    return not (0 <= centre_x < width and 0 <= centre_y < height)


def actions_of(accessible):
    try:
        action = accessible.queryAction()
        names = [truncate(action.getName(index), 80) for index in range(min(action.nActions, 20))]
    except Exception:
        return []
    return [name for name in names if name]


ROLE_KEEP = {
    "application",
    "dialog",
    "file chooser",
    "document",
    "document frame",
    "frame",
    "list",
    "menu",
    "menu bar",
    "page tab",
    "page tab list",
    "scroll pane",
    "status bar",
    "table",
    "terminal",
    "text field",
    "tool bar",
    "toolbar",
    "tree",
    "tree table",
    "window",
}


def make_node(accessible, path, depth):
    """A kept node, or None for a decorative container whose children are spliced up."""
    role = role_of(accessible)
    name = truncate(name_of(accessible), MAX_NAME)
    value = text_value(accessible, role)
    actions = actions_of(accessible)
    if not (name or value or actions or depth == 0 or role in ROLE_KEEP):
        return None
    return {
        "role": role,
        "name": name,
        "value": value,
        "states": states_of(accessible, actions),
        "actions": actions,
        "path": path,
        "accessible": accessible,
        "children": [],
    }


def has_children(accessible):
    try:
        return accessible.getChildCount() > 0
    except Exception:
        return False


def collect_children(accessible, path, depth, max_depth, budget):
    """Nested nodes below `accessible`; a cut by depth or the visit cap is signalled."""
    if max_depth is not None and depth > max_depth:
        return [], has_children(accessible)
    nodes = []
    truncated = False
    for index, child in enumerate(children(accessible)):
        if budget["left"] <= 0:
            return nodes, True
        budget["left"] -= 1
        child_path = path + [index]
        node = make_node(child, child_path, depth)
        if node is None:
            spliced, cut = collect_children(child, child_path, depth, max_depth, budget)
            nodes.extend(spliced)
            truncated = truncated or cut
            continue
        node["children"], cut = collect_children(child, child_path, depth + 1, max_depth, budget)
        truncated = truncated or cut
        nodes.append(node)
    return nodes, truncated


def matches_filter(node, needle):
    return needle in node["role"].casefold() or needle in node["name"].casefold()


def filter_tree(nodes, needle):
    """Keep matching nodes and their ancestors; mark the direct matches."""
    kept = []
    for node in nodes:
        children_kept = filter_tree(node["children"], needle)
        matched = matches_filter(node, needle)
        if matched or children_kept:
            kept.append({**node, "children": children_kept, "matched": matched})
    return kept


def find_nodes(nodes, name, role, exact=False):
    """Flattened matches, each with an empty child list; the caller assigns refs.

    A substring match by default (case-insensitive); `exact` compares the whole name and role.
    `dialog` also matches the dialog-like roles an app actually publishes (`alert`, `file
    chooser`), which is what LibreOffice's popups use.
    """

    def matches(text, needle, family=None):
        if family and text in family:
            return True
        return text == needle if exact else needle in text

    def role_matches(text, needle):
        return matches(text, needle, ROLE_FAMILIES.get(needle))

    found = []
    stack = list(reversed(nodes))
    while stack and len(found) < MAX_NODES:
        node = stack.pop()
        if (not name or matches(node["name"].casefold(), name)) and (
            not role or role_matches(node["role"].casefold(), role)
        ):
            found.append({**node, "children": [], "matched": True})
        stack.extend(reversed(node["children"]))
    return found


def count_nodes(nodes):
    total = 0
    for node in nodes:
        total += 1 + count_nodes(node["children"])
    return total


def flatten(nodes, depth, out, budget):
    for node in nodes:
        if budget["left"] <= 0:
            budget["cut"] = True
            return
        budget["left"] -= 1
        out.append({**node, "depth": depth})
        flatten(node["children"], depth + 1, out, budget)


def assign_refs(out):
    refs = {}
    for index, node in enumerate(out, start=1):
        ref = f"e{index}"
        node["ref"] = ref
        entry = {
            "path": node["path"],
            "role": node["role"],
            "name": node["name"],
            "value": node["value"],
            "accessible": node["accessible"],
        }
        # An app-wide search mixes windows, so each ref remembers its own frame.
        if node.get("_frame") is not None:
            entry["frame"] = node["_frame"]
        if node.get("_frame_path") is not None:
            entry["frame_path"] = node["_frame_path"]
        if node.get("_window"):
            entry["window"] = node["_window"]
        refs[ref] = entry
    return refs


def clean_node(node):
    result = {
        "ref": node["ref"],
        "depth": node["depth"],
        "role": node["role"],
        "states": node["states"],
        "actions": node["actions"],
    }
    if node["name"]:
        result["name"] = node["name"]
    if node.get("window"):
        result["window"] = node["window"]
    if node["value"]:
        result["value"] = node["value"]
    if "matched" in node:
        result["matched"] = node["matched"]
    return result


WINDOW_ROLES = ("frame", "dialog", "window", "file chooser", "color chooser", "alert")
# The roles a GTK/Qt app uses for what a model calls a "dialog"; LibreOffice's popups are `alert`.
DIALOG_ROLES = ("dialog", "alert", "file chooser", "color chooser")
# `role: "dialog"` finds the app's popups whatever role they actually publish.
ROLE_FAMILIES = {"dialog": DIALOG_ROLES}
# A plain click tries these names before falling back to the element's first action (S54).
LEGACY_CLICK_ACTIONS = ("click", "press", "activate", "open", "jump", "toggle")


def windows():
    """The top-level frames of every application, with their private index paths."""
    try:
        desktop = pyatspi.Registry.getDesktop(0)
    except Exception:
        return []
    found = []
    for app_index, application in enumerate(children(desktop)):
        app_name = name_of(application)
        for index, frame in enumerate(children(application)):
            if role_of(frame) not in WINDOW_ROLES:
                continue
            active = False
            try:
                active = frame.getState().contains(pyatspi.STATE_ACTIVE)
            except Exception:
                pass
            found.append(
                {
                    "app": app_name,
                    "frame": frame,
                    "path": [app_index, index],
                    "title": name_of(frame),
                    "role": role_of(frame),
                    "active": active,
                }
            )
    return found


def prefer_topmost(pool):
    """The window a user would mean: the active modal dialog, else the active window.

    xfwm4 publishes its own unnamed frame, and it is often ACTIVE while an app window is focused;
    an empty title is therefore never the answer unless nothing else exists.
    """
    titled = [item for item in pool if item["title"]]
    if titled:
        pool = titled
    active = [item for item in pool if item["active"]]
    if active:
        dialogs = [item for item in active if item["role"] in DIALOG_ROLES]
        return dialogs[-1] if dialogs else active[-1]
    dialogs = [item for item in pool if item["role"] in DIALOG_ROLES]
    return dialogs[-1] if dialogs else pool[-1]


def choose_window(request):
    candidates = windows()
    if not candidates:
        raise HelperError("not_found", "No application publishes an accessibility tree.")
    wanted = truncate(request.get("window") or "", 500).casefold()
    if wanted:
        exact = [item for item in candidates if item["title"].casefold() == wanted]
        if exact:
            return prefer_topmost(exact)
        partial = [
            item
            for item in candidates
            if wanted in item["title"].casefold() or wanted in item["app"].casefold()
        ]
        if partial:
            return prefer_topmost(partial)
        raise HelperError("not_found", f'No window matches "{wanted}".')
    # No window named: the focused app window or dialog, never the window manager's own frame.
    return prefer_topmost(candidates)


def current_generation(app):
    return GENERATIONS.get(app, 0), EPOCH


def remember(snapshot):
    global NEXT_SNAPSHOT
    NEXT_SNAPSHOT += 1
    snapshot_id = f"s{NEXT_SNAPSHOT}"
    SNAPSHOTS[snapshot_id] = snapshot
    LATEST[snapshot["frame_path"]] = snapshot_id
    while len(SNAPSHOTS) > MAX_SNAPSHOTS:
        oldest = next(iter(SNAPSHOTS))
        if LATEST.get(SNAPSHOTS[oldest]["frame_path"]) == oldest:
            break
        del SNAPSHOTS[oldest]
    return snapshot_id


def snapshot_for_ref(ref, frame_path=None):
    """The most recent snapshot holding this ref, for one window when one is named."""
    for snapshot_id, snapshot in reversed(list(SNAPSHOTS.items())):
        if frame_path is not None:
            entry = snapshot["refs"].get(ref)
            entry_path = frame_path_key(entry["frame_path"]) if entry and "frame_path" in entry else None
            if snapshot["frame_path"] != frame_path and entry_path != frame_path:
                continue
        if ref in snapshot["refs"]:
            return snapshot_id, snapshot
    return None, None


def frame_path_key(path):
    return path if isinstance(path, str) else "/".join(str(part) for part in path)


def snapshot_is_stale(snapshot):
    generation, epoch = current_generation(snapshot["app"])
    return generation != snapshot["generation"] or epoch != snapshot["epoch"]


def resolve_path(path):
    try:
        parts = path.split("/") if isinstance(path, str) else path
        current = pyatspi.Registry.getDesktop(0)
        for index in parts:
            index = int(index)
            if index < 0 or index >= current.getChildCount():
                return None
            current = current.getChildAtIndex(index)
        return current
    except Exception:
        return None


def build_tree(request, start, start_path, find):
    """One window's flattened nodes, its total count, and whether a cap cut it."""
    max_depth = request.get("depth")
    if max_depth is not None:
        max_depth = int(max_depth)
    budget = {"left": MAX_VISITED}
    root = make_node(start, start_path, 0)
    if root is None:
        role = role_of(start)
        actions = actions_of(start)
        root = {
            "role": role,
            "name": truncate(name_of(start), MAX_NAME),
            "value": text_value(start, role),
            "states": states_of(start, actions),
            "actions": actions,
            "path": start_path,
            "accessible": start,
            "children": [],
        }
    root["children"], truncated = collect_children(start, start_path, 1, max_depth, budget)
    tree = [root]
    if find:
        name = truncate(request.get("name") or "", 200).casefold()
        role = truncate(request.get("role") or "", 200).casefold()
        tree = find_nodes(tree, name, role, exact=bool(request.get("exact")))
        truncated = truncated or len(tree) >= MAX_NODES
    else:
        needle = truncate(request.get("filter") or "", 200).casefold()
        if needle:
            tree = filter_tree(tree, needle)
    total = count_nodes(tree)
    out = []
    flatten_budget = {"left": MAX_NODES, "cut": False}
    flatten(tree, 0, out, flatten_budget)
    truncated = truncated or flatten_budget["cut"] or total > MAX_NODES
    return out, total, truncated


def make_reply(request, start, start_path, app, frame, frame_path, find):
    out, total, truncated = build_tree(request, start, start_path, find)
    refs = assign_refs(out)
    generation, epoch = current_generation(app)
    snapshot = {
        "app": app,
        "generation": generation,
        "epoch": epoch,
        "window": name_of(frame),
        "frame_path": frame_path_key(frame_path),
        "frame": frame,
        "refs": refs,
    }
    snapshot_id = remember(snapshot)
    return {
        "app": app,
        "window": name_of(frame),
        "snapshot": snapshot_id,
        "nodes": [clean_node(node) for node in out],
        "total": total,
        "truncated": truncated,
    }


def choose_app(request):
    """The app matching the request, and every frame it publishes (dialogs included)."""
    needle = truncate(request.get("app") or "", 200).casefold()
    if not needle:
        raise HelperError("invalid", "An app name is required.")
    frames = windows()
    names = sorted({(item["app"] or "").casefold() for item in frames if item["app"]})
    exact = [name for name in names if name == needle]
    if exact:
        chosen = exact[0]
    else:
        partial = [name for name in names if needle in name]
        if len(partial) == 1:
            chosen = partial[0]
        elif len(partial) > 1:
            raise HelperError(
                "invalid", f'App "{needle}" is ambiguous: {", ".join(partial[:10])}.'
            )
        else:
            # LibreOffice calls itself "soffice" but writes "LibreOffice" in its titles.
            by_title = {
                (item["app"] or "").casefold()
                for item in frames
                if item["app"] and needle in item["title"].casefold()
            }
            if len(by_title) != 1:
                available = ", ".join(names[:20]) or "none"
                raise HelperError(
                    "not_found", f'No app matches "{needle}". Apps with a tree: {available}.'
                )
            chosen = next(iter(by_title))
    return chosen, [item for item in frames if (item["app"] or "").casefold() == chosen]


def find_app_request(request):
    """Search every window of one app; each node names the window it came from."""
    app, selected = choose_app(request)
    out = []
    total = 0
    truncated = False
    covered = []
    for chosen in selected:
        if len(out) >= MAX_NODES:
            truncated = True
            break
        nodes, count, cut = build_tree(request, chosen["frame"], chosen["path"], find=True)
        for node in nodes:
            node["_frame"] = chosen["frame"]
            node["_frame_path"] = chosen["path"]
            node["_window"] = chosen["title"]
            node["window"] = chosen["title"]
        out.extend(nodes)
        total += count
        truncated = truncated or cut
        covered.append(chosen["title"])
    if len(out) > MAX_NODES:
        out = out[:MAX_NODES]
        truncated = True
    refs = assign_refs(out)
    generation, epoch = current_generation(app)
    frame_path = f"app:{app}"
    snapshot = {
        "app": app,
        "generation": generation,
        "epoch": epoch,
        "window": app,
        "frame_path": frame_path,
        "frame": None,
        "refs": refs,
    }
    snapshot_id = remember(snapshot)
    return {
        "app": app,
        "window": app,
        "windows": covered,
        "snapshot": snapshot_id,
        "nodes": [clean_node(node) for node in out],
        "total": total,
        "truncated": truncated,
    }


def tree_request(request):
    ref = request.get("ref")
    if ref:
        window_key = None
        if request.get("window"):
            chosen = choose_window(request)
            window_key = frame_path_key(chosen["path"])
        _, snapshot = snapshot_for_ref(ref, window_key)
        if snapshot is None or snapshot_is_stale(snapshot):
            raise HelperError("stale", "stale, take a new snapshot")
        entry = snapshot["refs"][ref]
        start = resolve_path(entry["path"])
        frame = entry.get("frame") or resolve_path(snapshot["frame_path"])
        frame_path = entry.get("frame_path") or snapshot["frame_path"]
        if start is None or frame is None:
            raise HelperError("stale", "stale, take a new snapshot")
        return make_reply(
            request,
            start,
            entry["path"],
            snapshot["app"],
            frame,
            frame_path,
            find=False,
        )
    chosen = choose_window(request)
    return make_reply(
        request,
        chosen["frame"],
        chosen["path"],
        chosen["app"],
        chosen["frame"],
        chosen["path"],
        find=False,
    )


def find_request(request):
    if request.get("app"):
        return find_app_request(request)
    chosen = choose_window(request)
    return make_reply(
        request,
        chosen["frame"],
        chosen["path"],
        chosen["app"],
        chosen["frame"],
        chosen["path"],
        find=True,
    )


def apps_request():
    grouped = {}
    for item in windows():
        entry = grouped.setdefault(item["app"] or "(unnamed)", {"frames": 0, "nodes": 0})
        entry["frames"] += 1
        try:
            entry["nodes"] += item["frame"].getChildCount()
        except Exception:
            pass
    return [
        {"name": name, "frames": value["frames"], "nodes": value["nodes"]}
        for name, value in grouped.items()
    ]


def is_defunct(accessible):
    try:
        return accessible.getState().contains(pyatspi.STATE_DEFUNCT)
    except Exception:
        return True


def act_request(request):
    snapshot_id = request.get("snapshot")
    ref = request.get("ref")
    snapshot = SNAPSHOTS.get(snapshot_id)
    if snapshot is None or ref not in snapshot["refs"]:
        raise HelperError("stale", "stale, take a new snapshot")
    if snapshot_is_stale(snapshot):
        raise HelperError("stale", "stale, take a new snapshot")
    entry = snapshot["refs"][ref]
    element = entry.get("accessible")
    # An app-wide search mixes windows; each ref kept its own frame.
    frame = entry.get("frame") or snapshot.get("frame")
    window_name = entry.get("window") or snapshot["window"]
    if element is None or is_defunct(element):
        raise HelperError("stale", "stale, take a new snapshot")
    if frame is None or is_defunct(frame) or name_of(frame) != window_name:
        raise HelperError("stale", "stale, take a new snapshot")
    if role_of(element) != entry["role"] or truncate(name_of(element), MAX_NAME) != entry["name"]:
        raise HelperError("stale", "stale, take a new snapshot")
    if truncate(text_value(element, entry["role"]), MAX_VALUE) != entry["value"]:
        raise HelperError("stale", "stale, take a new snapshot")
    action = request.get("action")
    ran = None
    confirmed = False
    if action == "set_text":
        text = request.get("text")
        if not isinstance(text, str):
            raise HelperError("invalid", "set_text needs text.")
        try:
            editable = element.queryEditableText()
        except Exception:
            editable = None
        if editable is None:
            raise HelperError("invalid", "The element is not editable.")
        try:
            element.queryComponent().grabFocus()
        except Exception:
            pass
        try:
            outcome = editable.setTextContents(text[:10000])
            confirmed = outcome is not False
        except Exception:
            raise HelperError("failed", "The text could not be set.")
        ran = "set text"
    elif isinstance(action, str) and action:
        try:
            element.queryComponent().grabFocus()
        except Exception:
            pass
        candidates = [name.strip().casefold() for name in action.split("|") if name.strip()]
        if action == "click":
            # A plain click keeps the permissive search from S54: many apps call it press/activate.
            candidates += [name for name in LEGACY_CLICK_ACTIONS if name not in candidates]
        try:
            actions = element.queryAction()
        except Exception:
            actions = None
        if actions is not None:
            names = [actions.getName(index) or "" for index in range(actions.nActions)]
            folded = [name.casefold() for name in names]
            for candidate in candidates:
                if candidate in folded:
                    index = folded.index(candidate)
                    outcome = actions.doAction(index)
                    ran = names[index] or candidate
                    confirmed = outcome is not False
                    break
            if ran is None and action == "click" and actions.nActions > 0:
                # Last resort for a plain click, as before S56: a role with one unnamed action.
                outcome = actions.doAction(0)
                ran = names[0] or "click"
                confirmed = outcome is not False
        if ran is None:
            ran = "focus"
            confirmed = False
    else:
        raise HelperError("invalid", "Unknown action.")
    result = {
        "ok": True,
        "action": action,
        "ran": ran,
        "confirmed": bool(confirmed),
        "role": entry["role"],
        "window": window_name,
        "app": snapshot["app"],
    }
    if entry["name"]:
        result["name"] = entry["name"]
    return result


def on_event(event):
    """Bumps an application's generation when the structure it publishes changes."""
    global EPOCH
    app = app_name_of(event.source)
    if app is None:
        EPOCH += 1
    else:
        GENERATIONS[app] = GENERATIONS.get(app, 0) + 1
    return True


def handle(line):
    try:
        request = json.loads(line)
    except Exception:
        return {"id": 0, "error": {"code": "invalid", "message": "The request is not JSON."}}
    if not isinstance(request, dict) or not isinstance(request.get("id"), int):
        return {"id": 0, "error": {"code": "invalid", "message": "The request has no id."}}
    request_id = request["id"]
    try:
        op = request.get("op")
        if op == "ping":
            return {"id": request_id, "ok": True, "version": VERSION}
        if op == "apps":
            return {"id": request_id, "ok": True, "apps": apps_request()}
        if op == "tree":
            return {"id": request_id, "ok": True, "tree": tree_request(request)}
        if op == "find":
            return {"id": request_id, "ok": True, "tree": find_request(request)}
        if op == "act":
            return {"id": request_id, "ok": True, "result": act_request(request)}
        return {"id": request_id, "error": {"code": "invalid", "message": "Unknown operation."}}
    except HelperError as error:
        return {"id": request_id, "error": {"code": error.code, "message": error.message}}
    except Exception:
        # The message stays generic because the daemon treats every line as untrusted. The
        # traceback goes to stderr, which sandboxd caps and only logs when the helper exits.
        import traceback

        traceback.print_exc(file=sys.stderr)
        return {
            "id": request_id,
            "error": {"code": "failed", "message": "The accessibility helper failed."},
        }


def on_stdin(_fd, _condition):
    line = sys.stdin.readline()
    if line == "":
        loop.quit()
        return False
    reply = handle(line)
    sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return True


listener = on_event
# Only window identity changes invalidate a snapshot. Content churn (a thumbnail, a status bar)
# must not make every ref stale; the act path re-checks the element's role, name and value at its
# index path, so a target that disappeared or changed is refused then.
for event_name in (
    "window:create",
    "window:destroy",
    "window:property-change:accessible-name",
):
    try:
        pyatspi.Registry.registerEventListener(listener, event_name)
    except Exception:
        # A payload name the local AT-SPI build does not know is not fatal: the other
        # events still invalidate the snapshots.
        pass

loop = GLib.MainLoop()
GLib.unix_fd_add_full(
    GLib.PRIORITY_DEFAULT,
    sys.stdin.fileno(),
    GLib.IO_IN | GLib.IO_HUP,
    on_stdin,
)
loop.run()

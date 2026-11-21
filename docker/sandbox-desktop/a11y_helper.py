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
"stale, take a new snapshot".
"""

import json
import sys

import pyatspi
from gi.repository import GLib

VERSION = 1

# The node and text caps keep one reply inside what sandboxd will accept (S54).
MAX_NODES = 2000
MAX_VISITED = 8000
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


def states_of(accessible):
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
    return found


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
        "states": states_of(accessible),
        "actions": actions,
        "path": path,
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


def find_nodes(nodes, name, role):
    """Flattened matches, each with an empty child list; the caller assigns refs."""
    found = []
    stack = list(reversed(nodes))
    while stack and len(found) < MAX_NODES:
        node = stack.pop()
        if (not name or name in node["name"].casefold()) and (
            not role or role in node["role"].casefold()
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
        refs[ref] = {
            "path": node["path"],
            "role": node["role"],
            "name": node["name"],
            "value": node["value"],
        }
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
    if node["value"]:
        result["value"] = node["value"]
    if "matched" in node:
        result["matched"] = node["matched"]
    return result


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
            if role_of(frame) not in ("frame", "dialog", "window"):
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
                    "active": active,
                }
            )
    return found


def choose_window(request):
    candidates = windows()
    if not candidates:
        raise HelperError("not_found", "No application publishes an accessibility tree.")
    wanted = truncate(request.get("window") or "", 500).casefold()
    if wanted:
        exact = [item for item in candidates if item["title"].casefold() == wanted]
        if exact:
            return exact[0]
        partial = [
            item
            for item in candidates
            if wanted in item["title"].casefold() or wanted in item["app"].casefold()
        ]
        if partial:
            active = [item for item in partial if item["active"]]
            return active[0] if active else partial[0]
        raise HelperError("not_found", f'No window matches "{wanted}".')
    active = [item for item in candidates if item["active"]]
    return active[0] if active else candidates[-1]


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
        if frame_path is not None and snapshot["frame_path"] != frame_path:
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


def make_reply(request, start, start_path, app, frame, frame_path, find):
    max_depth = request.get("depth")
    if max_depth is not None:
        max_depth = int(max_depth)
    budget = {"left": MAX_VISITED}
    root = make_node(start, start_path, 0)
    if root is None:
        role = role_of(start)
        root = {
            "role": role,
            "name": truncate(name_of(start), MAX_NAME),
            "value": text_value(start, role),
            "states": states_of(start),
            "actions": actions_of(start),
            "path": start_path,
            "children": [],
        }
    root["children"], truncated = collect_children(start, start_path, 1, max_depth, budget)
    tree = [root]
    if find:
        name = truncate(request.get("name") or "", 200).casefold()
        role = truncate(request.get("role") or "", 200).casefold()
        tree = find_nodes(tree, name, role)
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
    refs = assign_refs(out)
    generation, epoch = current_generation(app)
    snapshot = {
        "app": app,
        "generation": generation,
        "epoch": epoch,
        "window": name_of(frame),
        "frame_path": frame_path_key(frame_path),
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
        start = resolve_path(snapshot["refs"][ref]["path"])
        frame = resolve_path(snapshot["frame_path"])
        if start is None or frame is None:
            raise HelperError("stale", "stale, take a new snapshot")
        return make_reply(
            request,
            start,
            snapshot["refs"][ref]["path"],
            snapshot["app"],
            frame,
            snapshot["frame_path"],
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


def act_request(request):
    snapshot_id = request.get("snapshot")
    ref = request.get("ref")
    snapshot = SNAPSHOTS.get(snapshot_id)
    if snapshot is None or ref not in snapshot["refs"]:
        raise HelperError("stale", "stale, take a new snapshot")
    if snapshot_is_stale(snapshot):
        raise HelperError("stale", "stale, take a new snapshot")
    entry = snapshot["refs"][ref]
    element = resolve_path(entry["path"])
    frame = resolve_path(snapshot["frame_path"])
    if element is None or frame is None or name_of(frame) != snapshot["window"]:
        raise HelperError("stale", "stale, take a new snapshot")
    if role_of(element) != entry["role"] or truncate(name_of(element), MAX_NAME) != entry["name"]:
        raise HelperError("stale", "stale, take a new snapshot")
    if truncate(text_value(element, entry["role"]), MAX_VALUE) != entry["value"]:
        raise HelperError("stale", "stale, take a new snapshot")
    action = request.get("action")
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
            editable.setTextContents(text[:10000])
        except Exception:
            raise HelperError("failed", "The text could not be set.")
    elif action == "click":
        try:
            element.queryComponent().grabFocus()
        except Exception:
            pass
        clicked = False
        try:
            actions = element.queryAction()
            for index in range(actions.nActions):
                name = (actions.getName(index) or "").casefold()
                if name in ("click", "press", "activate", "open", "jump", "toggle"):
                    actions.doAction(index)
                    clicked = True
                    break
            if not clicked and actions.nActions > 0:
                actions.doAction(0)
                clicked = True
        except Exception:
            clicked = False
        if not clicked:
            try:
                element.queryComponent().grabFocus()
                clicked = True
            except Exception:
                clicked = False
        if not clicked:
            raise HelperError("invalid", "The element has no click action.")
    else:
        raise HelperError("invalid", "Unknown action.")
    result = {
        "ok": True,
        "action": action,
        "role": entry["role"],
        "window": snapshot["window"],
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

"""Nerikone MCP server: lets an AI agent model in the running Nerikone app.

It is a thin proxy over the HTTP API of nerikone/server.py, so everything an agent does shows up live
in the open viewer, lands in the same undoable timeline, and can be edited by hand afterwards.

Start the app first (.venv/bin/python nerikone/server.py), then register this file with your MCP client as a
stdio server: command `.venv/bin/python`, argument `nerikone/mcp_server.py` (see .mcp.json).
Env: NERIKONE_URL (default http://127.0.0.1:8765)
"""
import json
import os
import pathlib
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from mcp.server.mcpserver import MCPServer

URL = os.environ.get("NERIKONE_URL", "http://127.0.0.1:8765")

INSTRUCTIONS = """Nerikone is a direct-modeling NURBS/B-rep CAD (SMLib kernel) with a parametric timeline.
Workflow: list_commands -> run_command to create/modify -> inspect_body to get face/edge reference points ->
run_command with those points (face_ref / edge_refs params) -> update_feature to change any earlier dimension.
Units are model units (set_units says what one is). Z is up. run_command reports the bodies it created and removed.
Name numbers with the var.set command; any later number can then be an expression such as "=W/2 + 0.1".
Sketch planes: x runs along xdir, y along normal x xdir (a plane facing -Y with xdir +X has y pointing up). Faces/edges are referenced by a point on them, never
by index. A failed command changes nothing and returns the kernel's reason; adjust and retry."""

mcp = MCPServer("nerikone", instructions=INSTRUCTIONS)


def _call(method: str, path: str, body: Any = None, raw: bytes | None = None) -> Any:
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(URL + path, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            payload = r.read()
            ctype = r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        payload, ctype = e.read(), "application/json"
    except urllib.error.URLError as e:
        raise RuntimeError(f"Nerikone app is not running at {URL} ({e.reason}). Start: python nerikone/server.py") from None
    if "json" not in ctype:
        return payload
    d = json.loads(payload)
    if isinstance(d, dict) and d.get("error"):
        raise ValueError(d["error"])
    return d


def _doc(d):
    """Strip tessellation from API replies: agents need the model, not triangles."""
    return d.get("doc", d)


@mcp.tool()
def list_commands() -> list[dict]:
    """All modeling commands with their parameter schemas (types, defaults, ranges, docs)."""
    return _call("GET", "/api/commands")


@mcp.tool()
def get_document() -> dict:
    """The feature timeline (id, cmd, params, error, suppressed) and the resulting bodies (kind, bbox, volume)."""
    return _doc(_call("GET", "/api/state?scene=0"))


@mcp.tool()
def run_command(cmd: str, params: dict | None = None) -> dict:
    """Run a command (e.g. 'body.box', 'edge.fillet') and append it to the timeline. Returns the new feature and
    the document. Omitted params take their defaults; creation commands auto-name the body unless `name` is given."""
    d = _call("POST", "/api/exec", {"cmd": cmd, "params": params or {}})
    return {"feature": d["feature"], "created": d.get("created", []), "removed": d.get("removed", []), **_doc(d)}


@mcp.tool()
def update_feature(id: int, params: dict | None = None, suppressed: bool | None = None) -> dict:
    """Change parameters of an existing feature (or suppress it); everything after it rebuilds."""
    return _doc(_call("POST", "/api/feature", {"id": id, "params": params, "suppressed": suppressed}))


@mcp.tool()
def delete_feature(id: int) -> dict:
    """Remove a feature from the timeline; the model rebuilds without it."""
    return _doc(_call("POST", "/api/feature", {"id": id, "delete": True}))


@mcp.tool()
def undo() -> dict:
    """Undo the last timeline change."""
    return _doc(_call("POST", "/api/undo", {}))


@mcp.tool()
def redo() -> dict:
    """Redo the last undone change."""
    return _doc(_call("POST", "/api/redo", {}))


@mcp.tool()
def new_document() -> dict:
    """Start an empty document (undoable)."""
    return _doc(_call("POST", "/api/new", {}))


@mcp.tool()
def get_errors() -> list[dict]:
    """Recent failures recorded by the app (from the UI and from agents): time, endpoint, command, full kernel message."""
    return _call("GET", "/api/errors")


@mcp.tool()
def inspect_body(name: str) -> dict:
    """A body's faces and edges: type, a point on each (use it as face_ref / edge_refs), normal, area, length,
    plus volume and bounding box."""
    return _call("GET", "/api/inspect?body=" + urllib.parse.quote(name))


@mcp.tool()
def measure(kind: str, params: dict | None = None) -> dict:
    """Exact measurements; nothing changes. kind and params:
    body {bodies?}: volume, area, centre of mass and size of each.  distance {a, b}: shortest distance between two
    bodies and its end points.  interference {bodies?}: pairs of solids that overlap, with the shared volume.
    draft {body, direction?, min_angle?}: which faces release from a mold pulled along `direction`.
    angle {a, at_a, b, at_b}: the angle between the faces nearest the two points."""
    return _call("POST", "/api/measure", {"kind": kind, "params": params or {}})


@mcp.tool()
def set_units(units: str) -> dict:
    """What one model unit means, for display and export: mm, cm, m or in."""
    return _doc(_call("POST", "/api/settings", {"units": units}))


@mcp.tool()
def export_file(path: str, format: str = "step", bodies: list[str] | None = None, tolerance: float | None = None) -> str:
    """Write bodies (default: all) to a file. format: step, stl, 3mf, obj, glb, usda, wrl, svg or dxf (a 2D drawing:
    front, top and side views with hidden lines) or nrk (the editable document). `tolerance` (model units) sets
    how finely curved faces are faceted in the mesh formats."""
    q = urllib.parse.urlencode({"fmt": format, "bodies": ",".join(bodies or []), **({"tolerance": tolerance} if tolerance else {})})
    data = _call("GET", "/api/export?" + q)
    p = pathlib.Path(path).expanduser()
    p.write_bytes(data)
    return f"wrote {len(data)} bytes to {p}"


@mcp.tool()
def import_file(path: str, to_solid: bool = False) -> dict:
    """Import a .step/.stp (exact B-rep), .stl (mesh; to_solid converts it) or .nrk (replaces the document)."""
    p = pathlib.Path(path).expanduser()
    q = urllib.parse.urlencode({"filename": p.name, "to_solid": "1" if to_solid else "0"})
    return _doc(_call("POST", "/api/import?" + q, raw=p.read_bytes()))


if __name__ == "__main__":
    mcp.run()

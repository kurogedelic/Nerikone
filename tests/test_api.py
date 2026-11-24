"""The API both front ends talk to: api.handle (the browser build) and server.py over real HTTP."""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest

from conftest import ROOT

import api  # noqa: E402  (conftest put nerikone/ on the path)


def call(method, path, payload=None, **query):
    raw = payload if isinstance(payload, bytes) else json.dumps(payload or {}).encode()
    code, ctype, data, _ = api.handle(method, path, {k: str(v) for k, v in query.items()}, raw)
    return code, (json.loads(data) if ctype == "application/json" else data)


@pytest.fixture(autouse=True)
def fresh():
    call("POST", "/api/new")
    api.errors.clear()


# ---------------------------------------------------------------- api.handle

def test_commands_listed():
    code, cmds = call("GET", "/api/commands")
    assert code == 200 and {c["id"] for c in cmds} >= {"body.box", "file.import"}


def test_exec_inspect_measure():
    code, d = call("POST", "/api/exec", {"cmd": "body.box", "params": {}})
    assert code == 200 and d["feature"]["id"] == 1 and "Box1" in d["scene"]
    code, ins = call("GET", "/api/inspect", body="Box1")
    assert code == 200 and len(ins["face_list"]) == 6
    code, m = call("POST", "/api/measure", {"kind": "body", "params": {"bodies": ["Box1"]}})
    assert m["bodies"]["Box1"]["volume"] == pytest.approx(8)


def test_preview_changes_nothing():
    call("POST", "/api/exec", {"cmd": "body.box", "params": {}})
    v = call("GET", "/api/version")[1]["version"]
    code, d = call("POST", "/api/exec", {"cmd": "body.sphere", "params": {}, "preview": True})
    assert code == 200 and "Sphere1" in d["scene"]
    assert call("GET", "/api/version")[1]["version"] == v
    assert list(call("GET", "/api/state", scene=0)[1]["doc"]["bodies"]) == ["Box1"]


def test_feature_edit_undo_redo():
    call("POST", "/api/exec", {"cmd": "body.box", "params": {}})
    code, d = call("POST", "/api/feature", {"id": 1, "params": {"height": 4}})
    assert d["doc"]["bodies"]["Box1"]["volume"] == pytest.approx(16)
    assert call("POST", "/api/undo")[1]["doc"]["bodies"]["Box1"]["volume"] == pytest.approx(8)
    assert call("POST", "/api/redo")[1]["doc"]["bodies"]["Box1"]["volume"] == pytest.approx(16)
    assert call("POST", "/api/feature", {"id": 1, "delete": True})[1]["doc"]["bodies"] == {}


def test_limits():
    call("POST", "/api/exec", {"cmd": "body.box", "params": {}})
    code, d = call("POST", "/api/limits", {"cmd": "face.move", "params": {"body": "Box1", "at": [0, 0, 1]},
                                            "param": "by", "lo": 0.01, "hi": 5, "direction": [0, 0, -1]})
    assert code == 200 and 1.5 < d["max"] < 2  # the top can come down almost to the bottom


def test_export_and_import_back():
    call("POST", "/api/exec", {"cmd": "body.box", "params": {}})
    code, data = call("GET", "/api/export", fmt="stl")
    assert code == 200 and isinstance(data, bytes)
    code, d = call("POST", "/api/import", data, filename="my part.stl")
    assert code == 200 and "mypart" in d["doc"]["bodies"]
    code, nrk = call("GET", "/api/export", fmt="nrk")
    call("POST", "/api/new")
    code, d = call("POST", "/api/import", nrk, filename="saved.nrk")
    assert sorted(d["doc"]["bodies"]) == ["Box1", "mypart"]


def test_units():
    assert call("POST", "/api/settings", {"units": "cm"})[1]["doc"]["units"] == "cm"
    assert call("POST", "/api/settings", {"units": "parsec"})[0] == 400


@pytest.mark.parametrize("method,path,body,query", [
    ("POST", "/api/exec", b"{not json", {}),
    ("POST", "/api/exec", {"cmd": "body.box", "params": {"length": "x"}}, {}),
    ("POST", "/api/exec", {"params": {}}, {}),
    ("POST", "/api/exec", [1, 2], {}),
    ("POST", "/api/feature", {"id": "seven"}, {}),
    ("POST", "/api/limits", {"cmd": "body.box"}, {}),
    ("GET", "/api/inspect", None, {"body": "Ghost"}),
    ("GET", "/api/export", None, {"fmt": "doc"}),
    ("GET", "/api/export", None, {"fmt": "stl", "tolerance": "fine"}),
    ("POST", "/api/import", b"\x00\x01", {"filename": "x.exe"}),
    ("POST", "/api/import", b"\x00\x01", {"filename": "x.step"}),
    ("POST", "/api/import", b"{", {"filename": "x.nrk"}),
])
def test_bad_requests_are_400_and_logged(method, path, body, query):
    code, d = call(method, path, body, **query)
    assert code == 400 and d["error"]
    assert call("GET", "/api/errors")[1][-1]["path"] == path


def test_unknown_path_is_404():
    assert call("GET", "/api/nothing")[0] == 404
    assert call("POST", "/api/nothing")[0] == 404


# ---------------------------------------------------------------- server.py over HTTP

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server():
    port = free_port()
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    p = subprocess.Popen([sys.executable, str(ROOT / "nerikone" / "server.py"), "--port", str(port)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, cwd=ROOT)
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(url + "/api/version", timeout=1)
            break
        except OSError:
            time.sleep(0.1)
    else:
        p.kill()
        pytest.fail("server did not start")
    yield url
    p.terminate()
    p.wait(5)


def http(url, path, body=None):
    req = urllib.request.Request(url + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def test_server_page_has_build_number(server):
    code, page, _ = http(server, "/")
    assert code == 200 and b'name="nerikone-build"' in page


def test_server_static_files(server):
    for f in ("/app.js", "/style.css", "/keymap.js", "/icons.js", "/i18n.js"):
        assert http(server, f)[0] == 200, f
    assert http(server, "/../kernel.py")[0] in (400, 403, 404)


def test_server_exec_round_trip(server):
    code, data, _ = http(server, "/api/exec", {"cmd": "body.box", "params": {}})
    assert code == 200 and "Box1" in json.loads(data)["doc"]["bodies"]
    code, data, _ = http(server, "/api/exec", {"cmd": "body.box", "params": {"length": -1}})
    assert code == 400 and json.loads(data)["error"]
    assert http(server, "/api/state")[0] == 200


def test_exec_reports_bodies_made_and_used_up():
    call("POST", "/api/exec", {"cmd": "body.box", "params": {}})
    code, d = call("POST", "/api/exec", {"cmd": "body.pattern", "params": {"body": "Box1", "count": 3}})
    made = d["created"]
    assert len(made) == 2 and d["removed"] == [] and all(n in d["doc"]["bodies"] for n in made)
    code, d = call("POST", "/api/exec", {"cmd": "body.boolean", "params": {"kind": "union", "target": "Box1", "tools": made[:1]}})
    assert d["created"] == [] and d["removed"] == made[:1]

"""The viewer's JavaScript: it parses, every Japanese phrase has an English translation, default shortcuts are sound."""
import json
import re
import shutil
import subprocess

import pytest

from conftest import ROOT

WEB = ROOT / "nerikone" / "web"
JS = sorted(WEB.glob("*.js")) + sorted((ROOT / "nerikone" / "web-local").glob("*.js"))
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(not NODE, reason="node is not installed")


@needs_node
@pytest.mark.parametrize("path", JS, ids=lambda p: p.name)
def test_js_parses(path):
    r = subprocess.run([NODE, "--check", str(path)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


@needs_node
def test_every_japanese_phrase_is_translated():
    r = subprocess.run([NODE, "--no-warnings", str(ROOT / "tests" / "js" / "i18n_coverage.mjs"), *map(str, sorted(WEB.glob("*.js")))],
                       capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "", "add these to EN in nerikone/web/i18n.js:\n" + r.stdout


@pytest.fixture(scope="module")
def keymap():
    script = ("globalThis.navigator ??= {}; import('./nerikone/web/keymap.js').then(m => "
              "console.log(JSON.stringify(m.DEFAULT_KEYMAP)))")
    r = subprocess.run([NODE, "--no-warnings", "--input-type=module", "-e", script], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def canon(combo):
    *mods, key = combo.split("+") if combo != "+" else ["+"]
    return "+".join(sorted(mods) + [key])


@needs_node
def test_default_shortcuts_do_not_clash(keymap):
    seen, clashes = {}, []
    for action, combos in keymap.items():
        for c in combos:
            k = canon(c)
            if k in seen and seen[k] != action:
                clashes.append((c, seen[k], action))
            seen.setdefault(k, action)
    assert not clashes


@needs_node
def test_default_shortcuts_name_real_actions(keymap):
    src = (WEB / "app.js").read_text(encoding="utf-8")
    registered = set(re.findall(r"""\bA\(\s*['"]([\w.]+)['"]""", src)) | set(re.findall(r"""register\(\s*['"]([\w.]+)['"]""", src))
    # tools and commands register themselves from tables; accept ids that appear quoted anywhere in app.js
    quoted = set(re.findall(r"""['"]([a-z]+\.[\w.]+)['"]""", src))
    prefixes = tuple(re.findall(r"""\bA\(\s*['"]([\w]+\.)['"]\s*\+""", src))  # A('view.' + v, ...) in a loop
    missing = [a for a in keymap if a not in registered and a not in quoted and not a.startswith(prefixes)]
    assert not missing


def test_index_references_exist():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    for ref in re.findall(r"""(?:src|href)=["']([^"':?#]+)""", html):
        if ref.startswith(("http", "//", "data")):
            continue
        assert (WEB / ref).exists(), ref

# Nerikone

Open-source 3D CAD for designers: direct modeling on an exact NURBS / B-rep kernel, with a parametric timeline
and an MCP server so AI agents can model too. **Beta (v0.1.0-beta): expect rough edges; saved documents may not open in later versions.**

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r nerikone/requirements.txt
.venv/bin/python nerikone/server.py      # http://localhost:8765
```

While changing the code, add `--reload`: the server restarts when the Python files change and keeps the open document
(for the viewer files, reloading the page is enough).

Tests (kernel commands, document, file I/O, API and server, the viewer's JavaScript; the browser build's kernel too
once `tools/build-web-local.py` has fetched its packages):

```bash
.venv/bin/pip install pytest && .venv/bin/python -m pytest      # NERIKONE_FUZZ=1 adds the slow fuzz values
```

Web version (one document per visitor, with upload and size limits):

```bash
docker build -t nerikone . && docker run -p 8080:8080 nerikone      # http://localhost:8080
```

On Render's free plan: sign in with GitHub, New > Blueprint, pick this repository (`render.yaml`). It sleeps when idle.


## Use

`examples/house.nrk` is a small house built on variables (open it, then change W, D, H ... in the inspector with
nothing selected: walls, openings and roof follow).

- `P` push/pull: click a flat face or a sketched shape, move, click (or type a distance); pulling adds, pushing cuts,
  double-click repeats the last distance. Tap Option to toggle `+`: the starting face stays as edges (stack a new segment). In move (`G`), `+` copies instead (right: fillet, left: chamfer) / a body directly.
- `A` add · `G` `R` `S` move / rotate / scale (`X` `Y` `Z` to lock an axis, type a number) · `Alt+R` `Alt+C` `Alt+P` sketch shapes
  · `M` ruler · `D` dimension (two points, then where the line goes; `X` `Y` `Z` measure along one axis; saved in the document) · `O` orbit tool (pan / zoom tools in the toolbar) · `F3` search · `F1` all shortcuts (remappable).
- `L` line: click points (`A` makes the next segment an arc); joining the start closes it into a face. A line from one
  side of a face to the other splits the face; select that line and press `G` (`Z`) to raise it into a roof ridge. The pointer snaps to
  edge ends, midpoints and edges. Offset (`Alt+O`), mirror, pattern, split, sweep, draft, section view (`Alt+X`),
  work planes, measuring and interference checks (`I`) are in the toolbar.
- Click a History item (or select a body) to change its dimensions in the inspector; the model rebuilds.
- The right column stacks three panels: Items (the bodies, `Shift+N`), Info (the inspector, `N`: parameters, size, material and
  measurements of the selection, or the document when nothing is selected) and History (the timeline). Click a title to fold a
  panel away; drag the edges to resize. The document name in the top bar opens file and unit commands; the desktop app also
  has them all in its menu bar.
- English or Japanese: the globe button in the top bar.
- Files: drop STEP / STL / WRL / `.nrk` on the window; export STEP, STL, 3MF, OBJ, GLB, USD, WRL, and 2D drawings (SVG / DXF). The work is autosaved in the browser.

## In the browser, without a server

`python3 tools/build-web-local.py` builds `dist-web/`: the viewer plus the kernel running in your browser (SMLib compiled
to WebAssembly, with Python through Pyodide). Serve it from any static host (`python3 -m http.server -d dist-web`); the
documents never leave the visitor's machine. The first load downloads about 30 MB. Every command and export works the
same as on the server. GitHub Pages builds it from this repository (`.github/workflows/pages.yml`).

## AI agents

With the app running, `.mcp.json` registers `nerikone/mcp_server.py` for MCP clients; their edits show up live.
In browsers that support WebMCP, the page offers the same commands as tools (this is also how an agent reaches the browser build). See [AGENTS.md](AGENTS.md).

## Licence and thanks

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)).

Built on the SMLib kernel that NVIDIA opened up as [USD BRep](https://github.com/NVIDIA-Omniverse/usd-brep), used
through [smlibpy](https://pypi.org/project/smlibpy/) by AWV Informatik. サンキュー革ジャン 🧥
Icons: the [Fukiai](https://github.com/hugelton/Fukiai) icon font and Tabler Icons (both MIT).
Nerikone is independent and not affiliated with or endorsed by either.

### OpenSCAD `.scad` import

Drop a `.scad` file into the viewer or use **Import**. The server and browser/WASM builds use the same bounded Python parser. The original UTF-8 source is stored as a content-addressed blob in the `.nrk` document; importing creates one rebuildable B-rep history feature, with one body per top-level solid. Units follow the document's units (OpenSCAD coordinates have no declared units).

Supported: scalar assignments, arithmetic `+ - * / % ^`, three-element vectors, `cube`, `sphere`, `cylinder` (including frustums), `translate`, Euler `rotate`, uniform `scale`, and `union`, `difference`, `intersection`. `center` works on cubes and cylinders. `$fn`, `$fa`, `$fs` are accepted for round solids, but exact B-rep geometry ignores tessellation settings. The subset limits source to 100 KB, 20,000 tokens, 1,000 nodes per block, 500 solids, and 32 nesting levels. Invalid or unsupported syntax fails the import with an error; it is never silently skipped.

Unsupported: modules, functions, loops, conditional statements, 2D primitives, linear/rotate extrusions, hull/minkowski, includes/uses/imports, color, nonuniform scaling, arbitrary-axis rotation, and OpenSCAD special variables beyond the ignored tessellation settings. Expressions do not call functions or read files. A failed import leaves the document unchanged.

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

Web version (one document per visitor, with upload and size limits):

```bash
docker build -t nerikone . && docker run -p 8080:8080 nerikone      # http://localhost:8080
```

On Render's free plan: sign in with GitHub, New > Blueprint, pick this repository (`render.yaml`). It sleeps when idle.


## Use

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

## AI agents

With the app running, `.mcp.json` registers `nerikone/mcp_server.py` for MCP clients; their edits show up live.
In browsers that support WebMCP, the page offers the same commands as tools. See [AGENTS.md](AGENTS.md).

## Licence and thanks

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)).

Built on the SMLib kernel that NVIDIA opened up as [USD BRep](https://github.com/NVIDIA-Omniverse/usd-brep), used
through [smlibpy](https://pypi.org/project/smlibpy/) by AWV Informatik. サンキュー革ジャン 🧥
Icons: the [Fukiai](https://github.com/hugelton/Fukiai) icon font and Tabler Icons (both MIT).
Nerikone is independent and not affiliated with or endorsed by either.

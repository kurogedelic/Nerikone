# Nerikone

Nerikone is an open-source, designer-oriented 3D CAD application: quick, hands-on direct solid modeling,
NURBS/B-rep geometry, a parametric timeline, and an AI-friendly command API.

**Status:** early prototype. Specifications and behaviour will change.

## Goals
- **Direct modeling feel**: hover, pick a face or edge, drag. Push/pull faces, drag edges into fillets or chamfers,
  drag bodies around.
- **NURBS / B-rep** geometry from NVIDIA's [SMLib kernel](https://github.com/NVIDIA-Omniverse/usd-brep)
  (Apache-2.0), used through the community [`smlibpy`](https://pypi.org/project/smlibpy/) package.
- **Parametric**: every operation is a feature in a timeline; change any dimension and the model rebuilds.
- **Sketch → push/pull**: draw rectangles, circles and polygons on the ground or on a face, then pull them into a
  solid or push them in to cut.
- **Files**: STEP (with names and colours), STL and VRML (.wrl/.wrz) in; STEP, STL, GLB, USD, VRML and the
  editable `.nrk` document out.
- **Materials**: per-body colour and finish (plastic, metal, glass, rubber, clay), per-face colours.
- **Simple renderer**: environment-lit materials (clay, plastic, metal, glass), soft shadows, PNG capture.
- **AI-friendly**: every operation is a typed command shared by the UI, the HTTP API and an MCP server.

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r nerikone/requirements.txt
.venv/bin/python nerikone/server.py      # open http://localhost:8765
```

UI: keyboard-driven, modal operation (floating, draggable panels; icon toolbar, adaptive context bar, floating parameter dialog,
timeline strip, outliner, navigation gizmo with view name / azimuth / elevation). All shortcuts are remappable
(F1 opens the editor; overrides are stored in the browser and can be exported/imported as JSON).

| Input | Action |
| --- | --- |
| `2` / `3` / `4` | Edge / face / body selection mode |
| LMB drag on geometry | Face: push/pull · edge: right = fillet, left = chamfer · body: move |
| MMB or Alt+LMB / Shift+drag / wheel | Orbit / pan / zoom |
| `G` `R` `S` (+ `X` `Y` `Z`, typed numbers, Enter / Esc) | Move / rotate / scale modally |
| `E`, `Ctrl+B` (`F`), `Shift+Ctrl+B`, `Shift+S` | Push face, fillet, chamfer, shell (modal, typed values) |
| `Shift+D`, `X` / `Delete`, `H` / `Alt+H`, `Cmd/Ctrl+A` | Duplicate, delete, hide / unhide, select all |
| Numpad `1` `3` `7` (`Ctrl` = opposite), `5`, `0`, `Home` | Front / right / top, ortho toggle, iso, frame |
| `Z` / `Shift+Z` | Shading (solid, wire, X-ray) / render view |
| `A` (or `+` button) | Add menu (new body under the mouse) |
| `Alt+R` / `Alt+C` / `Alt+P` | Sketch a rectangle / circle / polygon (type sizes, Enter) |
| `M` | Ruler (snaps to vertices; Delete or × removes a measurement) |
| `` ` `` | Console (operations and full kernel messages) |
| `F3`, Space or `/` | Command search |
| RMB | Context menu |
| Timeline chip | Edit its parameters (the model rebuilds) |
| NURBS surface feature | Drag its blue control points (Shift: in the XY plane) |

## AI agents (MCP)

With the app running, `.mcp.json` registers `nerikone/mcp_server.py` for MCP clients. Agents
use the same commands as the UI, and their edits appear live in the viewer and in the undoable timeline.
See [AGENTS.md](AGENTS.md).

## Licence

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Dependencies keep their own licences and are
not vendored here: smlibpy (MIT) with USD BRep / SMLib (Apache-2.0), three.js (MIT) and Tabler Icons (MIT).

## Acknowledgements

Nerikone stands on the SMLib solid modeling kernel, which NVIDIA opened up as
[USD BRep](https://github.com/NVIDIA-Omniverse/usd-brep) under Apache-2.0, and on
[smlibpy](https://pypi.org/project/smlibpy/) by AWV Informatik, which makes it a pleasure to use from Python.
An open, production-grade B-rep kernel is what made this project possible. サンキュー革ジャン 🧥

Nerikone is an independent project, not affiliated with or endorsed by NVIDIA, AWV Informatik or anyone else
named here; their names are their trademarks.

## Known limits
- Faces and edges are referenced by a point on them; a large upstream change can make a reference pick a
  different face or edge.
- STL imports are display meshes unless converted to a solid.
- No 2D sketch constraints yet.

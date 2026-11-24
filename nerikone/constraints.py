"""Sketch constraints: move the corner points of an outline as little as possible so that every constraint holds.

An outline is points p0 .. pn-1 in plane coordinates; segment i runs from point i to point i + 1 (wrapping round to
p0 when the outline is closed). A constraint is a list [kind, *indices, value?]:

    horizontal s | vertical s                 segment s runs along the plane's X / Y
    length s L                                segment s is L long (for an arc: its chord)
    radius s R                                arc segment s has radius R (its bulge stays as drawn)
    parallel s t | perpendicular s t          the two segments' directions
    equal s t                                 the two segments are as long as each other
    angle s t A                               segment t turns A degrees from segment s (counter-clockwise)
    distance i j D                            points i and j are D apart
    x i X | y i Y                             point i sits at that plane coordinate
    fix i                                     point i stays where it was drawn

Solved by Gauss-Newton from the drawn points with minimum-norm steps, so what the constraints leave free stays as
drawn. Standard library only (it also runs in the browser build).
"""
import math

KINDS = {  # kind -> (segment indices, point indices, has a value)
    "horizontal": (1, 0, False), "vertical": (1, 0, False), "length": (1, 0, True), "radius": (1, 0, True),
    "parallel": (2, 0, False), "perpendicular": (2, 0, False), "equal": (2, 0, False), "angle": (2, 0, True),
    "distance": (0, 2, True), "x": (0, 1, True), "y": (0, 1, True), "fix": (0, 1, False),
}


class ConstraintError(ValueError):
    pass


def normalise(raw):
    """Check the shape of a constraints list (hostile input: ConstraintError, never anything else)."""
    if not isinstance(raw, (list, tuple)):
        raise ConstraintError("constraints must be a list of [kind, index..., value?]")
    out = []
    for c in raw:
        if not isinstance(c, (list, tuple)) or not c or c[0] not in KINDS:
            raise ConstraintError(f"unknown constraint {c!r}: kinds are {sorted(KINDS)}")
        nseg, npt, val = KINDS[c[0]]
        n = nseg + npt
        if len(c) != 1 + n + (1 if val else 0):
            raise ConstraintError(f"{c[0]} takes {n} index(es){' and a value' if val else ''}: {c!r}")
        idx = []
        for x in c[1:1 + n]:
            if isinstance(x, bool) or not isinstance(x, (int, float)) or x != int(x) or x < 0:
                raise ConstraintError(f"{c[0]}: indices are whole numbers >= 0: {c!r}")
            idx.append(int(x))
        item = [c[0], *idx]
        if val:
            v = c[-1]
            if isinstance(v, str) and v.strip().startswith("=") and len(v) <= 400:  # an expression (expr.py): worked out when the step runs
                item.append(v.strip())
                out.append(item)
                continue
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                raise ConstraintError(f"{c[0]}: the value must be a number: {c!r}")
            if c[0] in ("length", "radius", "distance") and v <= 0:
                raise ConstraintError(f"{c[0]} must be above 0: {c!r}")
            item.append(float(v))
        out.append(item)
    return out


def _segments(n, closed):
    return [(i, (i + 1) % n) for i in range(n if closed else n - 1)]


def _residuals(x, cons, segs, bulges, x0):
    P = lambda i: (x[2 * i], x[2 * i + 1])  # noqa: E731
    r = []
    for c in cons:
        k = c[0]
        if KINDS[k][0]:
            d = []
            for s in c[1:1 + KINDS[k][0]]:
                a, b = P(segs[s][0]), P(segs[s][1])
                d.append((b[0] - a[0], b[1] - a[1]))
        if k == "horizontal":
            r.append(d[0][1])
        elif k == "vertical":
            r.append(d[0][0])
        elif k == "length":
            r.append(math.hypot(*d[0]) - c[2])
        elif k == "radius":  # chord = 2 R sin(half angle); with bulge k fixed, R = chord (1 + k^2) / (4 |k|)
            kb = abs(bulges[c[1]]) if c[1] < len(bulges) else 0.0
            r.append(math.hypot(*d[0]) * (1 + kb * kb) / (4 * kb) - c[2])
        elif k in ("parallel", "perpendicular", "angle"):
            la, lb = math.hypot(*d[0]), math.hypot(*d[1])
            if la < 1e-12 or lb < 1e-12:
                r.append(0.0)
                continue
            u, v = (d[0][0] / la, d[0][1] / la), (d[1][0] / lb, d[1][1] / lb)
            cross, dot = u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]
            if k == "parallel":
                r.append(cross)
            elif k == "perpendicular":
                r.append(dot)
            else:
                d_ang = math.atan2(cross, dot) - math.radians(c[3])
                r.append((d_ang + math.pi) % (2 * math.pi) - math.pi)  # how far v is from u turned by the angle
        elif k == "equal":
            r.append(math.hypot(*d[0]) - math.hypot(*d[1]))
        elif k == "distance":
            a, b = P(c[1]), P(c[2])
            r.append(math.hypot(b[0] - a[0], b[1] - a[1]) - c[3])
        elif k == "x":
            r.append(x[2 * c[1]] - c[2])
        elif k == "y":
            r.append(x[2 * c[1] + 1] - c[2])
        elif k == "fix":
            r.extend([x[2 * c[1]] - x0[2 * c[1]], x[2 * c[1] + 1] - x0[2 * c[1] + 1]])
    return r


def _jacobian(x, f, r0):
    h = 1e-7
    cols = []
    for j in range(len(x)):
        xp = list(x)
        step = h * max(1.0, abs(x[j]))
        xp[j] += step
        cols.append([(a - b) / step for a, b in zip(f(xp), r0)])
    return [[cols[j][i] for j in range(len(x))] for i in range(len(r0))]  # rows = residuals


PIVOT = 1e-8  # a pivot this small (relative) is a constraint that repeats others: it adds nothing and must not blow the step up


def _min_norm_step(J, r, lam=1e-4):
    """dx = -J^T (J J^T + lam I)^-1 r: the smallest step that zeroes the linearised residuals."""
    m, n = len(J), len(J[0]) if J else 0
    A = [[sum(J[i][k] * J[j][k] for k in range(n)) + (lam if i == j else 0.0) for j in range(m)] for i in range(m)]
    y = _solve(A, [-v for v in r])
    return [sum(J[i][k] * y[i] for i in range(m)) for k in range(n)]


def _solve(A, b):
    """Gaussian elimination with partial pivoting; near-singular pivots (redundant constraints) give 0."""
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    scale = max((abs(v) for row in A for v in row), default=1.0) or 1.0
    for c in range(n):
        p = max(range(c, n), key=lambda i: abs(M[i][c]))
        M[c], M[p] = M[p], M[c]
        if abs(M[c][c]) < PIVOT * scale:
            continue
        for i in range(c + 1, n):
            f = M[i][c] / M[c][c]
            if f:
                for k in range(c, n + 1):
                    M[i][k] -= f * M[c][k]
    y = [0.0] * n
    for c in range(n - 1, -1, -1):
        if abs(M[c][c]) < PIVOT * scale:
            continue
        y[c] = (M[c][n] - sum(M[c][k] * y[k] for k in range(c + 1, n))) / M[c][c]
    return y


def _rank(J, tol=1e-8):
    rows = [r[:] for r in J]
    rank, ncol = 0, len(rows[0]) if rows else 0
    for c in range(ncol):
        p = max(range(rank, len(rows)), key=lambda i: abs(rows[i][c]), default=None)
        if p is None or abs(rows[p][c]) < tol:
            continue
        rows[rank], rows[p] = rows[p], rows[rank]
        for i in range(len(rows)):
            if i != rank and rows[i][c]:
                f = rows[i][c] / rows[rank][c]
                rows[i] = [a - f * b for a, b in zip(rows[i], rows[rank])]
        rank += 1
    return rank


def solve(points, constraints, closed=True, bulges=()):
    """-> (solved points, degrees of freedom left). Raises ConstraintError naming a constraint that cannot hold."""
    pts = [(float(p[0]), float(p[1])) for p in points]
    n = len(pts)
    cons = normalise(constraints)
    if not cons:
        return pts, 2 * n
    segs = _segments(n, closed)
    for c in cons:
        nseg, npt, _ = KINDS[c[0]]
        for s in c[1:1 + nseg]:
            if s >= len(segs):
                raise ConstraintError(f"{c[0]}: there is no segment {s} (this outline has {len(segs)})")
        for i in c[1 + nseg:1 + nseg + npt]:
            if i >= n:
                raise ConstraintError(f"{c[0]}: there is no point {i} (this outline has {n})")
        if c[0] == "radius" and not (c[1] < len(bulges) and abs(bulges[c[1]]) > 1e-9):
            raise ConstraintError(f"radius: segment {c[1]} is not an arc")
    x0 = [v for p in pts for v in p]
    size = max(1.0, max(abs(v) for v in x0))
    f = lambda x: _residuals(x, cons, segs, bulges, x0)  # noqa: E731
    x = list(x0)
    r = f(x)
    err = lambda r: math.sqrt(sum(v * v for v in r))  # noqa: E731
    for _ in range(200):
        if err(r) < 1e-10 * size:
            break
        J = _jacobian(x, f, r)
        dx = _min_norm_step(J, r)
        t, e0 = 1.0, err(r)
        while t > 1e-4:  # backtrack when the full step makes things worse
            xn = [a + t * b for a, b in zip(x, dx)]
            rn = f(xn)
            if err(rn) < e0:
                break
            t /= 2
        else:
            break
        x, r = xn, rn
    if err(r) > 1e-7 * size:
        worst, k = 0.0, 0
        rr = iter(r)
        for i, c in enumerate(cons):
            m = 2 if c[0] == "fix" else 1
            v = max(abs(next(rr)) for _ in range(m))
            if v > worst:
                worst, k = v, i
        raise ConstraintError(f"the constraints cannot all hold (they conflict at {cons[k]!r}): remove or change one")
    dof = 2 * n - _rank(_jacobian(x, f, r))
    return [(x[2 * i], x[2 * i + 1]) for i in range(n)], dof

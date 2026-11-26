"""A bounded interpreter for a subset of the .scad solid-script language, written from the public language description.

It never evaluates Python, never touches the file system and never falls back silently: anything it does not support is
refused with a reason. Work is bounded (source size, tokens, steps, loop iterations, solids, nesting).

Supported: numbers, booleans, strings, vectors, ranges, list comprehensions, the usual operators, user functions and
modules (default and named arguments, children()), for / if / let, include and use (from a bundle of files, see below),
cube sphere cylinder, circle square polygon, translate rotate scale mirror multmatrix color, union difference
intersection, hull (2D, and 3D for upright cylinders of one height), offset, linear_extrude, rotate_extrude.
Several files travel together as a bundle: a first line `//@nerikone-bundle` followed by JSON {"main": name, "files": {name: source}}.
"""
import json
import math
import re
import time

import smlibpy as sm


class ScadError(ValueError):
    pass


MAX_SOURCE = 100_000      # bytes per file
MAX_BUNDLE = 1_000_000
MAX_FILES = 50
MAX_TOKENS = 60_000
MAX_STEPS = 600_000       # expression / statement evaluations
MAX_LOOPS = 20_000        # loop iterations in all
MAX_SOLIDS = 1200
MAX_SECONDS = 120.0       # wall-clock time for one import
MAX_LIST = 100_000
MAX_STRING = 100_000
MAX_DEPTH = 48
BUNDLE_MAGIC = "//@nerikone-bundle"

_TOKEN = re.compile(r'''\s+|//[^\n]*|/\*[\s\S]*?\*/|(?P<num>(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(?P<id>[A-Za-z_$][A-Za-z0-9_$]*)|(?P<str>"(?:[^"\\\n]|\\.)*")|(?P<op>==|!=|<=|>=|&&|\|\||\*\*|[-+*/%^!<>=?:;,.()\[\]{}#])''', re.ASCII)
_PATH = re.compile(r'\s*<([^>\n]*)>')


def tokenize(source):
    if len(source) > MAX_SOURCE:
        raise ScadError("SCAD source exceeds 100 KB")
    out, pos, n = [], 0, len(source)
    while pos < n:
        m = _TOKEN.match(source, pos)
        if not m:
            raise ScadError(f"invalid syntax at offset {pos}")
        pos = m.end()
        if m.lastgroup == "num":
            out.append(("num", float(m.group())))
        elif m.lastgroup == "id":
            out.append(("id", m.group()))
            if m.group() in ("include", "use"):
                p = _PATH.match(source, pos)
                if p:
                    out.append(("path", p.group(1).strip()))
                    pos = p.end()
        elif m.lastgroup == "str":
            try:
                out.append(("str", json.loads(m.group())))
            except ValueError:
                raise ScadError("bad string") from None
        elif m.lastgroup == "op":
            out.append(("op", m.group()))
        if len(out) > MAX_TOKENS:
            raise ScadError("too many tokens")
    out.append(("end", ""))
    return out


# ---------------------------------------------------------------- parser (source -> tuples)

class Parser:
    def __init__(self, source):
        self.t = tokenize(source)
        self.i = 0
        self.depth = 0

    def peek(self, k=0):
        return self.t[min(self.i + k, len(self.t) - 1)]

    def next(self):
        v = self.t[self.i]
        self.i += 1
        return v

    def is_op(self, v, k=0):
        t = self.peek(k)
        return t[0] == "op" and t[1] == v

    def is_id(self, v, k=0):
        t = self.peek(k)
        return t[0] == "id" and t[1] == v

    def eat_op(self, v):
        if self.is_op(v):
            self.i += 1
            return True
        return False

    def need(self, v):
        if not self.eat_op(v):
            raise ScadError(f"expected {v!r}, got {self.peek()[1]!r}")

    def ident(self):
        t = self.next()
        if t[0] != "id":
            raise ScadError(f"expected a name, got {t[1]!r}")
        return t[1]

    def nest(self):
        self.depth += 1
        if self.depth > MAX_DEPTH * 2:
            raise ScadError("nesting limit exceeded")

    # ---- expressions
    def expr(self):
        self.nest()
        try:
            return self.ternary()
        finally:
            self.depth -= 1

    def ternary(self):
        c = self.binary(0)
        if self.eat_op("?"):
            a = self.expr()
            self.need(":")
            b = self.expr()
            return ("cond", c, a, b)
        return c

    LEVELS = [("||",), ("&&",), ("==", "!="), ("<", ">", "<=", ">="), ("+", "-"), ("*", "/", "%")]

    def binary(self, lvl):
        if lvl == len(self.LEVELS):
            return self.unary()
        left = self.binary(lvl + 1)
        while self.peek()[0] == "op" and self.peek()[1] in self.LEVELS[lvl]:
            op = self.next()[1]
            left = ("bin", op, left, self.binary(lvl + 1))
        return left

    def unary(self):
        if self.peek()[0] == "op" and self.peek()[1] in ("!", "-", "+"):
            op = self.next()[1]
            self.nest()
            try:
                return ("un", op, self.unary())
            finally:
                self.depth -= 1
        return self.power()

    def power(self):
        base = self.postfix()
        if self.peek()[0] == "op" and self.peek()[1] in ("^", "**"):
            self.next()
            return ("bin", "^", base, self.unary())
        return base

    def postfix(self):
        e = self.primary()
        while True:
            if self.is_op("("):
                if e[0] != "var":
                    raise ScadError("only named functions can be called")
                e = ("call", e[1], self.call_args())
            elif self.is_op("["):
                self.next()
                idx = self.expr()
                self.need("]")
                e = ("index", e, idx)
            elif self.is_op(".") and self.peek(1)[0] == "id":
                self.next()
                e = ("member", e, self.next()[1])
            else:
                return e

    def call_args(self):
        self.need("(")
        args = []
        if not self.eat_op(")"):
            while True:
                if self.peek()[0] == "id" and self.is_op("=", 1):
                    name = self.next()[1]
                    self.next()
                    args.append((name, self.expr()))
                else:
                    args.append((None, self.expr()))
                if self.eat_op(")"):
                    break
                self.need(",")
        return args

    def primary(self):
        t = self.next()
        if t[0] == "num":
            return ("const", t[1])
        if t[0] == "str":
            return ("const", t[1])
        if t[0] == "id":
            if t[1] == "true":
                return ("const", True)
            if t[1] == "false":
                return ("const", False)
            if t[1] == "undef":
                return ("const", None)
            if t[1] == "let" and self.is_op("("):
                binds = self.assigns()
                return ("let", binds, self.expr())
            return ("var", t[1])
        if t == ("op", "("):
            e = self.expr()
            self.need(")")
            return e
        if t == ("op", "["):
            return self.list_literal()
        raise ScadError(f"unexpected {t[1]!r}")

    def assigns(self):
        self.need("(")
        out = []
        if not self.eat_op(")"):
            while True:
                name = self.ident()
                self.need("=")
                out.append((name, self.expr()))
                if self.eat_op(")"):
                    break
                self.need(",")
        return out

    def list_literal(self):
        if self.eat_op("]"):
            return ("list", [])
        first = self.list_elem()
        if self.is_op(":") and not isinstance(first, tuple) or (self.is_op(":") and first[0] not in ("lcfor", "lcif", "lclet", "each")):
            self.next()
            second = self.expr()
            if self.eat_op(":"):
                third = self.expr()
                self.need("]")
                return ("range", first, second, third)  # start : step : end
            self.need("]")
            return ("range", first, None, second)
        items = [first]
        while self.eat_op(","):
            if self.is_op("]"):
                break
            items.append(self.list_elem())
        self.need("]")
        return ("list", items)

    def list_elem(self):
        self.nest()
        try:
            if self.is_id("for") and self.is_op("(", 1):
                self.next()
                binds = self.assigns()
                return ("lcfor", binds, self.list_elem())
            if self.is_id("if") and self.is_op("(", 1):
                self.next()
                self.need("(")
                cond = self.expr()
                self.need(")")
                yes = self.list_elem()
                no = None
                if self.is_id("else"):
                    self.next()
                    no = self.list_elem()
                return ("lcif", cond, yes, no)
            if self.is_id("let") and self.is_op("(", 1):
                self.next()
                binds = self.assigns()
                return ("lclet", binds, self.list_elem())
            if self.is_id("each"):
                self.next()
                return ("each", self.expr())
            return self.expr()
        finally:
            self.depth -= 1

    # ---- statements
    def params(self):
        self.need("(")
        out = []
        if not self.eat_op(")"):
            while True:
                name = self.ident()
                default = self.expr() if self.eat_op("=") else None
                out.append((name, default))
                if self.eat_op(")"):
                    break
                self.need(",")
        return out

    def program(self):
        out = []
        while self.peek()[0] != "end":
            if self.is_op("}"):
                raise ScadError("unexpected }")
            out.append(self.stmt())
        return out

    def stmt(self):
        self.nest()
        try:
            return self._stmt()
        finally:
            self.depth -= 1

    def _stmt(self):
        t = self.peek()
        if t == ("op", ";"):
            self.next()
            return ("empty",)
        if t == ("op", "{"):
            self.next()
            body = []
            while not self.is_op("}"):
                if self.peek()[0] == "end":
                    raise ScadError("unclosed block")
                body.append(self.stmt())
            self.next()
            return ("block", body)
        if t[0] == "op" and t[1] in ("*", "!", "#", "%"):
            self.next()
            s = self.stmt()
            return ("empty",) if t[1] == "*" else s
        if t[0] != "id":
            raise ScadError(f"unexpected {t[1]!r}")
        name = t[1]
        if name == "module":
            self.next()
            mname = self.ident()
            params = self.params()
            return ("module", mname, params, self.stmt())
        if name == "function":
            self.next()
            fname = self.ident()
            params = self.params()
            self.need("=")
            body = self.expr()
            self.need(";")
            return ("function", fname, params, body)
        if name in ("include", "use"):
            self.next()
            p = self.next()
            if p[0] != "path":
                raise ScadError(f"{name} needs <file>")
            self.eat_op(";")
            return (name, p[1])
        if name in ("for", "intersection_for") and self.is_op("(", 1):
            self.next()
            binds = self.assigns()
            return ("for", binds, self.stmt(), name == "intersection_for")
        if name == "if" and self.is_op("(", 1):
            self.next()
            self.need("(")
            cond = self.expr()
            self.need(")")
            yes = self.stmt()
            no = None
            if self.is_id("else"):
                self.next()
                no = self.stmt()
            return ("if", cond, yes, no)
        if name == "let" and self.is_op("(", 1):
            self.next()
            binds = self.assigns()
            return ("letstmt", binds, self.stmt())
        if self.is_op("=", 1):
            self.next()
            self.next()
            value = self.expr()
            self.need(";")
            return ("assign", name, value)
        self.next()
        args = self.call_args()
        child = self.stmt()
        return ("inst", name, args, child)


# ---------------------------------------------------------------- values and expressions

class Range:
    pass


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) or isinstance(v, bool)


def truth(v):
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, (str, list)):
        return len(v) > 0
    return True


def vec_op(op, a, b):
    if isinstance(a, list) and isinstance(b, list):
        if op in ("+", "-"):
            if len(a) != len(b):
                return None
            return [vec_op(op, x, y) for x, y in zip(a, b)]
        if op == "*":
            if a and b and all(is_num(x) for x in a) and all(is_num(y) for y in b):
                if len(a) != len(b):
                    return None
                return sum(x * y for x, y in zip(a, b))
            if a and all(isinstance(r, list) for r in a):  # matrix * vector / matrix
                if b and all(is_num(y) for y in b):
                    return [vec_op("*", r, b) for r in a]
                cols = list(zip(*b))
                return [[vec_op("*", r, list(c)) for c in cols] for r in a]
            return None
    if isinstance(a, list) and is_num(b):
        return [bin_op(op, x, b) for x in a] if op in ("*", "/", "+", "-") else None
    if is_num(a) and isinstance(b, list):
        return [bin_op(op, a, y) for y in b] if op in ("*", "+", "-") else None
    return None


def bin_op(op, a, b):
    if op == "&&":
        return truth(a) and truth(b)
    if op == "||":
        return truth(a) or truth(b)
    if op == "==":
        return a == b
    if op == "!=":
        return a != b
    if isinstance(a, (list,)) or isinstance(b, (list,)):
        return vec_op(op, a, b)
    if op in ("<", ">", "<=", ">="):
        if (is_num(a) and is_num(b)) or (isinstance(a, str) and isinstance(b, str)):
            return {"<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op]
        return False
    if not (is_num(a) and is_num(b)):
        if op == "+" and isinstance(a, str) and isinstance(b, str):
            return _bounded_str(a + b)
        return None
    a, b = float(a), float(b)
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        if b == 0:
            return math.nan if a == 0 else math.copysign(math.inf, a) * (1 if math.copysign(1, b) > 0 else -1)
        return a / b
    if op == "%":
        if b == 0:
            return math.nan
        return math.fmod(a, b)
    if op == "^":
        if abs(a) > 1e6 or abs(b) > 64:
            raise ScadError("exponent exceeds limit")
        try:
            r = a ** b
        except (ZeroDivisionError, OverflowError):
            raise ScadError("invalid power") from None
        if isinstance(r, complex):
            return None
        return r
    return None


def _deg(f):
    return lambda x: f(math.radians(x))


def _num1(f):
    def g(x):
        if not is_num(x):
            return None
        try:
            return f(float(x))
        except (ValueError, OverflowError):
            raise ScadError("math domain error") from None
    return g


def _minmax(f):
    def g(*a):
        vals = a[0] if len(a) == 1 and isinstance(a[0], list) else list(a)
        if not vals or not all(is_num(v) for v in vals):
            return None
        return f(float(v) for v in vals)
    return g


def _round(x):
    return float(math.floor(x + 0.5)) if x >= 0 else -float(math.floor(-x + 0.5))


def _len(x):
    return float(len(x)) if isinstance(x, (list, str)) else None


def _concat(*a):
    out = []
    for x in a:
        out.extend(x) if isinstance(x, list) else out.append(x)
    if len(out) > MAX_LIST:
        raise ScadError("list too long")
    return out


def _bounded_str(s):
    if len(s) > MAX_STRING:
        raise ScadError("string too long")
    return s


def _fmt(v):
    if isinstance(v, float):
        return str(int(v)) if v == int(v) and abs(v) < 1e15 else f"{v:.6g}"
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "undef"
    if isinstance(v, list):
        return "[" + ", ".join(_fmt(x) for x in v) + "]"
    return str(v)


def _norm(v):
    return math.sqrt(sum(float(x) ** 2 for x in v)) if isinstance(v, list) and all(is_num(x) for x in v) else None


def _cross(a, b):
    if isinstance(a, list) and isinstance(b, list) and len(a) == 3 == len(b):
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    return None


def _search(needle, haystack, *rest):
    """search(x, list): the indices where x occurs (first match; lists of needles give lists)."""
    if not isinstance(haystack, (list, str)):
        return []

    def find(x):
        for i, h in enumerate(haystack):
            if h == x or (is_num(h) and is_num(x) and float(h) == float(x)):
                return [float(i)]
        return []
    if isinstance(needle, str) and isinstance(haystack, str):
        return [float(haystack.index(c)) for c in needle if c in haystack]
    if isinstance(needle, list):
        return [(find(x)[0] if find(x) else []) for x in needle]
    return find(needle)


def _lookup(key, table):
    if not (isinstance(table, list) and table and is_num(key)):
        return None
    rows = sorted((float(r[0]), float(r[1])) for r in table)
    if key <= rows[0][0]:
        return rows[0][1]
    for (x0, y0), (x1, y1) in zip(rows, rows[1:]):
        if key <= x1:
            return y0 if x1 == x0 else y0 + (y1 - y0) * (key - x0) / (x1 - x0)
    return rows[-1][1]


FUNCS = {
    "search": _search, "lookup": _lookup,
    "sin": _num1(_deg(math.sin)), "cos": _num1(_deg(math.cos)), "tan": _num1(_deg(math.tan)),
    "asin": _num1(lambda x: math.degrees(math.asin(x))), "acos": _num1(lambda x: math.degrees(math.acos(x))),
    "atan": _num1(lambda x: math.degrees(math.atan(x))),
    "atan2": lambda y, x: math.degrees(math.atan2(y, x)) if is_num(x) and is_num(y) else None,
    "sqrt": _num1(math.sqrt), "abs": _num1(abs), "floor": _num1(lambda x: float(math.floor(x))), "ceil": _num1(lambda x: float(math.ceil(x))),
    "round": _num1(_round), "exp": _num1(math.exp), "ln": _num1(math.log), "log": _num1(math.log10),
    "sign": _num1(lambda x: float((x > 0) - (x < 0))), "pow": lambda a, b: bin_op("^", a, b),
    "min": _minmax(min), "max": _minmax(max), "len": _len, "concat": _concat, "norm": _norm, "cross": _cross,
    "str": lambda *a: _bounded_str("".join(x if isinstance(x, str) else _fmt(x) for x in a)),
    "is_num": lambda x: is_num(x) and not isinstance(x, bool), "is_list": lambda x: isinstance(x, list),
    "is_string": lambda x: isinstance(x, str), "is_bool": lambda x: isinstance(x, bool), "is_undef": lambda x: x is None,
}


class Scope:
    def __init__(self, parent=None):
        self.vars = {}
        self.defs = {}       # ("m" | "f", name) -> (params, body, closure scope)
        self.parent = parent
        self.children = None  # (child statements, caller scope) inside a module body

    def get(self, name):
        s = self
        while s is not None:
            if name in s.vars:
                return s.vars[name]
            s = s.parent
        if name == "PI":
            return math.pi
        return None

    def find_def(self, kind, name):
        s = self
        while s is not None:
            if (kind, name) in s.defs:
                return s.defs[(kind, name)]
            s = s.parent
        return None

    def find_children(self):
        s = self
        while s is not None:
            if s.children is not None:
                return s.children
            s = s.parent
        return None


# ---------------------------------------------------------------- geometry

def hull3d(points):
    """Triangles (index triples, outward, counter-clockwise) of the convex hull of 3D points: an incremental construction."""
    pts = []
    seen = set()
    for q in points:
        key = (round(q[0], 7), round(q[1], 7), round(q[2], 7))
        if key not in seen:
            seen.add(key)
            pts.append(key)
    # a tiny fixed pseudo-random nudge (1e-9 of the size) keeps points out of exact coplanarity, so the hull is closed and simplicial
    big = max((max(abs(c) for c in q) for q in pts), default=1.0) or 1.0
    state = 12345
    nudged = []
    for q in pts:
        v = []
        for c in q:
            state = (state * 1103515245 + 12345) & 0x7FFFFFFF
            v.append(c + ((state / 0x7FFFFFFF) - 0.5) * 2e-9 * big)
        nudged.append(tuple(v))
    pts = nudged
    if len(pts) < 4:
        raise ScadError("hull: needs a solid shape")
    if len(pts) > 4000:
        raise ScadError("hull: too many points")

    def sub(a, b):
        return (a[0] - b[0], a[1] - b[1], a[2] - b[2])

    def cross(a, b):
        return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])

    def dot(a, b):
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    size = max(max(abs(c) for c in q) for q in pts) or 1.0
    eps = 1e-9 * size * size
    # a first tetrahedron that is not flat
    i0 = 0
    i1 = max(range(len(pts)), key=lambda i: sum(c * c for c in sub(pts[i], pts[i0])))
    if sum(c * c for c in sub(pts[i1], pts[i0])) < eps:
        raise ScadError("hull: the shapes are a single point")
    d01 = sub(pts[i1], pts[i0])
    i2 = max(range(len(pts)), key=lambda i: sum(c * c for c in cross(d01, sub(pts[i], pts[i0]))))
    n012 = cross(d01, sub(pts[i2], pts[i0]))
    if dot(n012, n012) < eps * size:
        raise ScadError("hull: the shapes lie on a line")
    i3 = max(range(len(pts)), key=lambda i: abs(dot(n012, sub(pts[i], pts[i0]))))
    if abs(dot(n012, sub(pts[i3], pts[i0]))) < eps * size:
        raise ScadError("hull: the shapes are flat (no volume)")
    faces = []

    def add(a, b, c, inside):
        n = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a]))
        faces.append((a, c, b) if dot(n, sub(inside, pts[a])) > 0 else (a, b, c))
    centre = tuple(sum(pts[i][k] for i in (i0, i1, i2, i3)) / 4 for k in range(3))
    for tri in ((i0, i1, i2), (i0, i1, i3), (i0, i2, i3), (i1, i2, i3)):
        add(*tri, centre)
    for pi, q in enumerate(pts):
        if pi in (i0, i1, i2, i3):
            continue
        visible = []
        for f in faces:
            n = cross(sub(pts[f[1]], pts[f[0]]), sub(pts[f[2]], pts[f[0]]))
            ln = math.sqrt(dot(n, n))
            if ln > 0 and dot(n, sub(q, pts[f[0]])) > 1e-12 * size * ln:  # distance above the plane, not area times distance
                visible.append(f)
        if not visible:
            continue
        edges = {}
        for f in visible:
            for a, b in ((f[0], f[1]), (f[1], f[2]), (f[2], f[0])):
                edges[(a, b)] = True
        horizon = [(a, b) for (a, b) in edges if (b, a) not in edges]
        faces = [f for f in faces if f not in visible]
        for a, b in horizon:
            faces.append((a, b, pi))
    used = sorted({i for f in faces for i in f})
    index = {old: new for new, old in enumerate(used)}
    return [pts[i] for i in used], [(index[a], index[b], index[c]) for a, b, c in faces]


# ---------------------------------------------------------------- text(): a small built-in font
# Our own 5 x 7 pixel letters (capitals, digits, punctuation; lower case draws as capitals). Rows run top to bottom.
_F = {}
for _k, _v in {
    "A": ".###. #...# #...# ##### #...# #...# #...#", "B": "####. #...# #...# ####. #...# #...# ####.",
    "C": ".#### #.... #.... #.... #.... #.... .####", "D": "####. #...# #...# #...# #...# #...# ####.",
    "E": "##### #.... #.... ####. #.... #.... #####", "F": "##### #.... #.... ####. #.... #.... #....",
    "G": ".#### #.... #.... #.### #...# #...# .###.", "H": "#...# #...# #...# ##### #...# #...# #...#",
    "I": "##### ..#.. ..#.. ..#.. ..#.. ..#.. #####", "J": "..### ...#. ...#. ...#. ...#. #..#. .##..",
    "K": "#...# #..#. #.#.. ##... #.#.. #..#. #...#", "L": "#.... #.... #.... #.... #.... #.... #####",
    "M": "#...# ##.## #.#.# #.#.# #...# #...# #...#", "N": "#...# ##..# #.#.# #..## #...# #...# #...#",
    "O": ".###. #...# #...# #...# #...# #...# .###.", "P": "####. #...# #...# ####. #.... #.... #....",
    "Q": ".###. #...# #...# #...# #.#.# #..#. .##.#", "R": "####. #...# #...# ####. #.#.. #..#. #...#",
    "S": ".#### #.... #.... .###. ....# ....# ####.", "T": "##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
    "U": "#...# #...# #...# #...# #...# #...# .###.", "V": "#...# #...# #...# #...# #...# .#.#. ..#..",
    "W": "#...# #...# #...# #.#.# #.#.# ##.## #...#", "X": "#...# #...# .#.#. ..#.. .#.#. #...# #...#",
    "Y": "#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..", "Z": "##### ....# ...#. ..#.. .#... #.... #####",
    "0": ".###. #...# #..## #.#.# ##..# #...# .###.", "1": "..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.",
    "2": ".###. #...# ....# ...#. ..#.. .#... #####", "3": "####. ....# ....# .###. ....# ....# ####.",
    "4": "...#. ..##. .#.#. #..#. ##### ...#. ...#.", "5": "##### #.... ####. ....# ....# #...# .###.",
    "6": "..##. .#... #.... ####. #...# #...# .###.", "7": "##### ....# ...#. ..#.. .#... .#... .#...",
    "8": ".###. #...# #...# .###. #...# #...# .###.", "9": ".###. #...# #...# .#### ....# ...#. .##..",
    ".": "..... ..... ..... ..... ..... ..... ..#..", ",": "..... ..... ..... ..... ..#.. ..#.. .#...",
    "-": "..... ..... ..... ##### ..... ..... .....", "_": "..... ..... ..... ..... ..... ..... #####",
    "+": "..... ..... ..#.. ##### ..#.. ..... .....", "=": "..... ..... ##### ..... ##### ..... .....",
    "!": "..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..", "?": ".###. #...# ....# ...#. ..#.. ..... ..#..",
    ":": "..... ..#.. ..... ..... ..#.. ..... .....", ";": "..... ..#.. ..... ..... ..#.. ..#.. .#...",
    "/": "....# ....# ...#. ..#.. .#... #.... #....", "\\": "#.... #.... .#... ..#.. ...#. ....# ....#",
    "(": "...#. ..#.. .#... .#... .#... ..#.. ...#.", ")": ".#... ..#.. ...#. ...#. ...#. ..#.. .#...",
    "[": ".###. .#... .#... .#... .#... .#... .###.", "]": ".###. ...#. ...#. ...#. ...#. ...#. .###.",
    "{": "..##. ..#.. ..#.. .#... ..#.. ..#.. ..##.", "}": ".##.. ..#.. ..#.. ...#. ..#.. ..#.. .##..",
    "<": "...#. ..#.. .#... #.... .#... ..#.. ...#.", ">": ".#... ..#.. ...#. ....# ...#. ..#.. .#...",
    "*": "..... #.#.# .###. ..#.. .###. #.#.# .....", "#": "..... .#.#. ##### .#.#. ##### .#.#. .....",
    "'": "..#.. ..#.. ..... ..... ..... ..... .....", '"': ".#.#. .#.#. ..... ..... ..... ..... .....",
    "%": "##..# ##..# ...#. ..#.. .#... #..## #..##", "&": ".##.. #..#. #.#.. .#... #.#.# #..#. .##.#",
    "@": ".###. #...# #.### #.#.# #.### #.... .###.", "$": "..#.. .#### #.#.. .###. ..#.# ####. ..#..",
    "|": "..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..", "~": "..... ..... .#... #.#.# ...#. ..... .....",
    "^": "..#.. .#.#. #...# ..... ..... ..... .....", "`": ".#... ..#.. ..... ..... ..... ..... .....",
    " ": ". . . . . . .",
}.items():
    _F[_k] = _v.split()
_GLYPH_LOOPS = {}


def _glyph_loops(ch):
    """The outline loops (lists of corners, y up, in cell units) of one letter: [(outer, [holes])...]."""
    if ch in _GLYPH_LOOPS:
        return _GLYPH_LOOPS[ch]
    rows = _F.get(ch.upper()) or _F["?"]
    cells = {(x, 6 - r) for r, row in enumerate(rows) for x, c in enumerate(row) if c == "#"}
    # two squares meeting only at a corner would split the letter: fill in the outer one of the two squares between them
    for _ in range(12):
        fixed = False
        for (x, y) in sorted(cells):
            for dx in (1, -1):
                if (x + dx, y + 1) in cells and (x + dx, y) not in cells and (x, y + 1) not in cells:
                    fill = max(((x + dx, y), (x, y + 1)), key=lambda c: (c[0] - 2) ** 2 + (c[1] - 3) ** 2)
                    cells.add(fill)
                    fixed = True
        if not fixed:
            break
    edges = {}

    def add(a, b):
        if a in edges.get(b, ()):  # the neighbouring cell's opposite edge cancels it
            edges[b].remove(a)
        else:
            edges.setdefault(a, []).append(b)
    for x, y in sorted(cells):
        add((x, y), (x + 1, y)); add((x + 1, y), (x + 1, y + 1)); add((x + 1, y + 1), (x, y + 1)); add((x, y + 1), (x, y))
    loops = []
    while True:
        start = next(((a, bs[0]) for a, bs in edges.items() if bs), None)
        if not start:
            break
        a, b = start
        edges[a].remove(b)
        loop = [a]
        while b != loop[0]:
            loop.append(b)
            dx, dy = b[0] - a[0], b[1] - a[1]
            outs = edges.get(b, [])
            # turn right first, then straight, then left: a corner touch splits into two shapes
            pref = {(dy, -dx): 0, (dx, dy): 1, (-dy, dx): 2}
            nxt = min(outs, key=lambda o: pref.get((o[0] - b[0], o[1] - b[1]), 3))
            edges[b].remove(nxt)
            a, b = b, nxt
        # drop corners that lie on a straight run
        clean = [q for i, q in enumerate(loop) if (q[0] - loop[i - 1][0]) * (loop[(i + 1) % len(loop)][1] - q[1]) != (q[1] - loop[i - 1][1]) * (loop[(i + 1) % len(loop)][0] - q[0])]
        loops.append(clean)

    def area(lp):
        return sum(lp[i][0] * lp[(i + 1) % len(lp)][1] - lp[(i + 1) % len(lp)][0] * lp[i][1] for i in range(len(lp))) / 2

    def inside(pt, lp):
        n, c = len(lp), False
        for i in range(n):
            (x1, y1), (x2, y2) = lp[i], lp[(i + 1) % n]
            if (y1 > pt[1]) != (y2 > pt[1]) and pt[0] < (x2 - x1) * (pt[1] - y1) / (y2 - y1) + x1:
                c = not c
        return c
    outers = [[lp, []] for lp in loops if area(lp) > 0]
    for lp in loops:
        if area(lp) < 0:
            mid = ((lp[0][0] + lp[1][0]) / 2 + 1e-3, (lp[0][1] + lp[1][1]) / 2 + 1e-3)
            for o in outers:
                if inside(mid, o[0]):
                    o[1].append(lp)
                    break
    _GLYPH_LOOPS[ch] = [(o, h) for o, h in outers]
    return _GLYPH_LOOPS[ch]


class G:
    """One shape: dim 3 (a Part / Shell) or 2 (a Sketch in the XY plane); `meta` remembers upright cylinders for hull."""
    __slots__ = ("dim", "shape", "meta")

    def __init__(self, dim, shape, meta=None):
        self.dim, self.shape, self.meta = dim, shape, meta


def _guard(fn, what):
    try:
        return fn()
    except ScadError:
        raise
    except (sm.ModelingError, ValueError, TypeError, ArithmeticError) as e:
        raise ScadError(f"{what}: {e}") from None


class Interp:
    def __init__(self, files, main):
        self.files = files
        self.main = main
        self.steps = 0
        self.loops = 0
        self.solids = 0
        self.depth = 0
        self.file_count = 0
        self.parsed = {}
        self.started = time.monotonic()

    # ---- budgets
    def tick(self, n=1):
        self.steps += n
        if self.steps > MAX_STEPS:
            raise ScadError("the script is too long to evaluate (step limit)")
        if self.steps % 500 == 0:
            self.check_time()

    def check_time(self):
        if time.monotonic() - self.started > MAX_SECONDS:
            raise ScadError(f"the script takes more than {int(MAX_SECONDS)} s to build: simplify it or split it")

    def loop_tick(self):
        self.loops += 1
        if self.loops > MAX_LOOPS:
            raise ScadError("loop iteration limit exceeded")

    def count_solid(self):
        self.solids += 1
        if self.solids > MAX_SOLIDS:
            raise ScadError("too many solids")
        self.check_time()

    # ---- files
    def load(self, name):
        key = name.replace("\\", "/").rsplit("/", 1)[-1]
        if key not in self.files:
            raise ScadError(f"file '{name}' is not part of the import (import the files together)")
        if key not in self.parsed:
            self.file_count += 1
            if self.file_count > MAX_FILES:
                raise ScadError("too many files")
            self.parsed[key] = Parser(self.files[key]).program()
        return self.parsed[key]

    # ---- expressions
    def ev(self, e, sc):
        self.tick()
        k = e[0]
        if k == "const":
            return e[1]
        if k == "var":
            return sc.get(e[1])
        if k == "bin":
            op = e[1]
            if op == "&&":
                return truth(self.ev(e[2], sc)) and truth(self.ev(e[3], sc))
            if op == "||":
                return truth(self.ev(e[2], sc)) or truth(self.ev(e[3], sc))
            return bin_op(op, self.ev(e[2], sc), self.ev(e[3], sc))
        if k == "un":
            v = self.ev(e[2], sc)
            if e[1] == "!":
                return not truth(v)
            if e[1] == "-":
                if is_num(v):
                    return -float(v)
                if isinstance(v, list):
                    return [(-x if is_num(x) else None) for x in v]
                return None
            return v
        if k == "cond":
            return self.ev(e[2], sc) if truth(self.ev(e[1], sc)) else self.ev(e[3], sc)
        if k == "index":
            v, i = self.ev(e[1], sc), self.ev(e[2], sc)
            if isinstance(v, (list, str)) and is_num(i) and 0 <= int(i) < len(v):
                return v[int(i)]
            return None
        if k == "member":
            v = self.ev(e[1], sc)
            idx = {"x": 0, "y": 1, "z": 2}.get(e[2])
            return v[idx] if isinstance(v, list) and idx is not None and idx < len(v) else None
        if k == "list":
            out = []
            for item in e[1]:
                self.emit(item, sc, out)
                if len(out) > MAX_LIST:
                    raise ScadError("list too long")
            return out
        if k == "range":
            a = self.ev(e[1], sc)
            s = self.ev(e[2], sc) if e[2] is not None else 1.0
            b = self.ev(e[3], sc)
            return self.expand_range(a, s, b)
        if k == "let":
            inner = Scope(sc)
            for name, v in e[1]:
                inner.vars[name] = self.ev(v, inner)
            return self.ev(e[2], inner)
        if k == "call":
            return self.call(e[1], e[2], sc)
        raise ScadError("unsupported expression")

    def expand_range(self, a, s, b):
        if not (is_num(a) and is_num(s) and is_num(b)):
            raise ScadError("a range needs numbers")
        a, s, b = float(a), float(s), float(b)
        if s == 0:
            raise ScadError("a range step cannot be 0")
        n = math.floor((b - a) / s + 1e-9) + 1 if (b - a) / s >= -1e-9 else 0
        if n > MAX_LIST:
            raise ScadError("range too long")
        return [a + i * s for i in range(max(0, n))]

    def emit(self, item, sc, out):
        self.tick()
        k = item[0]
        if k == "lcfor":
            for scope in self.bindings(item[1], sc):
                self.loop_tick()
                self.emit(item[2], scope, out)
                if len(out) > MAX_LIST:
                    raise ScadError("list too long")
        elif k == "lcif":
            if truth(self.ev(item[1], sc)):
                self.emit(item[2], sc, out)
            elif item[3] is not None:
                self.emit(item[3], sc, out)
        elif k == "lclet":
            inner = Scope(sc)
            for name, v in item[1]:
                inner.vars[name] = self.ev(v, inner)
            self.emit(item[2], inner, out)
        elif k == "each":
            v = self.ev(item[1], sc)
            if isinstance(v, list):
                out.extend(v)
            elif v is not None:
                out.append(v)
        else:
            out.append(self.ev(item, sc))

    def bindings(self, binds, sc):
        """Scopes for the cartesian product of `name = list` bindings (the last name varies fastest)."""
        def rec(i, scope):
            if i == len(binds):
                yield scope
                return
            name, e = binds[i]
            vals = self.ev(e, scope)
            if not isinstance(vals, list):
                vals = [] if vals is None else [vals]
            for v in vals:
                inner = Scope(scope)
                inner.vars[name] = v
                yield from rec(i + 1, inner)
        return rec(0, sc)

    def call(self, name, args, sc):
        d = sc.find_def("f", name)
        vals = [(n, self.ev(a, sc)) for n, a in args]
        if d is not None:
            params, body, closure = d
            self.depth += 1
            try:
                if self.depth > MAX_DEPTH:
                    raise ScadError("function nesting too deep")
                inner = Scope(closure)
                self.bind(inner, params, vals, name)
                return self.ev(body, inner)
            finally:
                self.depth -= 1
        f = FUNCS.get(name)
        if f is None:
            raise ScadError(f"unknown function {name}")
        if any(n is not None for n, _ in vals):
            raise ScadError(f"{name}: named arguments are not supported")
        try:
            return f(*[v for _, v in vals])
        except TypeError:
            raise ScadError(f"{name}: wrong arguments") from None

    def bind(self, scope, params, vals, what):
        names = [p for p, _ in params]
        pos = [v for n, v in vals if n is None]
        if len(pos) > len(names):
            raise ScadError(f"{what}: too many arguments")
        for n, v in zip(names, pos):
            scope.vars[n] = v
        for n, v in vals:
            if n is not None:
                if n.startswith("$"):
                    scope.vars[n] = v
                elif n in names:
                    scope.vars[n] = v
                else:
                    raise ScadError(f"{what}: no parameter {n}")
        for n, default in params:
            if n not in scope.vars:
                scope.vars[n] = self.ev(default, scope) if default is not None else None

    # ---- statements -> list of G
    def run_block(self, stmts, sc):
        # definitions and plain assignments first (a scope's modules, functions and values are visible throughout it)
        for s in stmts:
            if s[0] == "module":
                sc.defs[("m", s[1])] = (s[2], s[3], sc)
            elif s[0] == "function":
                sc.defs[("f", s[1])] = (s[2], s[3], sc)
        out = []
        for s in stmts:
            k = s[0]
            if k == "assign":
                self.tick()
                sc.vars[s[1]] = self.ev(s[2], sc)
            elif k in ("module", "function", "empty"):
                continue
            else:
                out.extend(self.exec(s, sc))
        return out

    def exec(self, s, sc):
        self.tick()
        k = s[0]
        if k == "empty":
            return []
        if k == "block":
            return self.run_block(s[1], Scope(sc))
        if k == "assign":
            sc.vars[s[1]] = self.ev(s[2], sc)
            return []
        if k in ("module", "function"):
            sc.defs[("m" if k == "module" else "f", s[1])] = (s[2], s[3], sc)
            return []
        if k == "include":
            self.depth += 1
            try:
                if self.depth > 8:
                    raise ScadError("includes nested too deep")
                return self.run_block(self.load(s[1]), sc)
            finally:
                self.depth -= 1
        if k == "use":
            self.depth += 1
            try:
                if self.depth > 8:
                    raise ScadError("includes nested too deep")
                inner = Scope(None)
                prog = self.load(s[1])
                for t in prog:  # only what the file defines; its own geometry is not wanted
                    if t[0] in ("module", "function"):
                        inner.defs[("m" if t[0] == "module" else "f", t[1])] = (t[2], t[3], inner)
                for t in prog:
                    if t[0] == "assign":
                        inner.vars[t[1]] = self.ev(t[2], inner)
                    elif t[0] == "include":
                        self.run_block([t], inner)
                for key, val in inner.defs.items():
                    sc.defs[key] = val
                return []
            finally:
                self.depth -= 1
        if k == "if":
            if truth(self.ev(s[1], sc)):
                return self.exec(s[2], sc)
            return self.exec(s[3], sc) if s[3] is not None else []
        if k == "letstmt":
            inner = Scope(sc)
            for name, v in s[1]:
                inner.vars[name] = self.ev(v, inner)
            return self.exec(s[2], inner)
        if k == "for":
            results = []
            for scope in self.bindings(s[1], sc):
                self.loop_tick()
                results.append(self.exec(s[2], scope))
            if s[3]:  # intersection_for
                return self.boolean("intersection", [r for r in results if r])
            return [g for r in results for g in r]
        if k == "inst":
            return self.inst(s, sc)
        raise ScadError("unsupported statement")

    def child_groups(self, child, sc):
        """The child statements of an instantiation, one group of shapes each."""
        stmts = child[1] if child[0] == "block" else [child]
        scope = Scope(sc) if child[0] == "block" else sc
        for t in stmts:
            if t[0] in ("module", "function"):
                scope.defs[("m" if t[0] == "module" else "f", t[1])] = (t[2], t[3], scope)
        groups = []
        for t in stmts:
            if t[0] == "assign":
                scope.vars[t[1]] = self.ev(t[2], scope)
            elif t[0] in ("empty", "module", "function"):
                continue
            else:
                groups.append(self.exec(t, scope))
        return groups

    def inst(self, s, sc):
        _, name, args, child = s
        d = sc.find_def("m", name)
        if d is not None:
            params, body, closure = d
            self.depth += 1
            try:
                if self.depth > MAX_DEPTH:
                    raise ScadError("module nesting too deep")
                inner = Scope(closure)
                vals = [(n, self.ev(a, sc)) for n, a in args]
                self.bind(inner, params, vals, name)
                inner.children = ([] if child[0] == "empty" else (child[1] if child[0] == "block" else [child]), sc)
                inner.vars["$children"] = float(len(inner.children[0]))
                return self.exec(body, inner)
            finally:
                self.depth -= 1
        if name == "children":
            held = sc.find_children()
            if held is None:
                return []
            stmts, caller = held
            vals = [self.ev(a, sc) for _, a in args]
            if vals and is_num(vals[0]):
                i = int(vals[0])
                stmts = [stmts[i]] if 0 <= i < len(stmts) else []
            out = []
            for t in stmts:
                out.extend(self.exec(t, caller))
            return out
        vals = [(n, self.ev(a, sc)) for n, a in args]
        return self.builtin(name, vals, child, sc)

    # ---- built-in modules
    def builtin(self, name, vals, child, sc):
        pos = [v for n, v in vals if n is None]
        kw = {n: v for n, v in vals if n is not None}

        def arg(names, defaults=None):
            if len(pos) > len(names):
                raise ScadError(f"{name}: too many arguments")
            a = dict(zip(names, pos))
            for k_, v in kw.items():
                if k_.startswith("$"):
                    continue
                if k_ not in names:
                    raise ScadError(f"{name}: unknown argument {k_}")
                a[k_] = v
            return a

        def num(v, what, positive=False):
            if not is_num(v) or isinstance(v, bool) or not math.isfinite(v) or abs(v) > 1e9:
                raise ScadError(f"{name}: {what} must be a finite number")
            if positive and v <= 0:
                raise ScadError(f"{name}: {what} must be positive")
            return float(v)

        def vec(v, n, what):
            if not isinstance(v, list) or len(v) not in n:
                raise ScadError(f"{name}: {what} must be a list of {'/'.join(map(str, n))} numbers")
            return [num(x, what) for x in v] + [0.0] * (3 - len(v))

        leaf = name in ("cube", "sphere", "cylinder", "circle", "square", "polygon", "polyhedron", "text")
        if leaf:
            if child[0] != "empty":
                raise ScadError(f"{name}: takes no children")
            return self.primitive(name, arg, num, vec)
        if name in ("echo", "assert"):
            return self.exec(child, sc) if child[0] != "empty" else []
        groups = self.child_groups(child, sc) if child[0] != "empty" else []
        flat = [g for grp in groups for g in grp]
        if name in ("color", "render", "group", "union"):
            if name == "union":
                return self.boolean("union", groups) if flat else []
            return flat
        if name in ("difference", "intersection"):
            return self.boolean(name, groups)
        if name == "translate":
            a = arg(["v"])
            v = vec(a.get("v", [0, 0, 0]), (2, 3), "v")
            return [self.move(g, lambda sh: sh.translate(*v), ("t", v)) for g in flat]
        if name == "rotate":
            a = arg(["a", "v"])
            return [self.rotate(g, a.get("a", 0), a.get("v"), num, vec) for g in flat]
        if name == "scale":
            a = arg(["v"])
            v = a.get("v", 1)
            v = [num(v, "v")] * 3 if is_num(v) and not isinstance(v, bool) else vec(v, (2, 3), "v")
            if len(a.get("v", [0, 0, 0])) == 2 if isinstance(a.get("v"), list) else False:
                v[2] = 1.0
            return [self.scale(g, v) for g in flat]
        if name == "mirror":
            a = arg(["v"])
            return [self.mirror(g, vec(a.get("v", [1, 0, 0]), (2, 3), "v")) for g in flat]
        if name == "multmatrix":
            a = arg(["m"])
            return [self.multmatrix(g, a.get("m"), num) for g in flat]
        if name == "hull":
            return self.hull(flat)
        if name == "offset":
            a = arg(["r", "delta", "chamfer"])
            return self.offset(flat, a, num)
        if name == "linear_extrude":
            a = arg(["height", "center", "convexity", "twist", "slices", "scale"])
            return self.linear_extrude(flat, a, num)
        if name == "rotate_extrude":
            a = arg(["angle", "convexity"])
            return self.rotate_extrude(flat, a, num)
        if name in ("minkowski", "import", "surface", "projection", "resize", "intersection_for", "render"):
            raise ScadError(f"{name} is not supported yet")
        raise ScadError(f"unknown module {name}")

    def primitive(self, name, arg, num, vec):
        self.count_solid()
        if name == "cube":
            a = arg(["size", "center"])
            size = a.get("size", 1)
            size = [num(size, "size", True)] * 3 if is_num(size) and not isinstance(size, bool) else vec(size, (3,), "size")
            if any(x <= 0 for x in size):
                raise ScadError("cube: size must be positive")
            c = a.get("center", False)
            part = _guard(lambda: sm.Box(*size), "cube")
            if not c:
                part = part.translate(size[0] / 2, size[1] / 2, size[2] / 2)
            return [G(3, part)]
        if name == "sphere":
            a = arg(["r", "d"])
            r = num(a["r"], "r", True) if "r" in a else (num(a["d"], "d", True) / 2 if "d" in a else 1.0)
            return [G(3, _guard(lambda: sm.Sphere(r), "sphere"))]
        if name == "cylinder":
            a = arg(["h", "r1", "r2", "center", "r", "d", "d1", "d2"])
            h = num(a.get("h", 1), "h", True)

            def radius(*keys, default):
                for k_, scale in keys:
                    if k_ in a:
                        return num(a[k_], k_, False) * scale
                return default
            r = radius(("r", 1), ("d", 0.5), default=1.0)
            r1 = radius(("r1", 1), ("d1", 0.5), default=r)
            r2 = radius(("r2", 1), ("d2", 0.5), default=r)
            if r1 < 0 or r2 < 0 or (r1 == 0 and r2 == 0):
                raise ScadError("cylinder: radius must be positive")
            z0 = -h / 2 if a.get("center", False) else 0.0
            if abs(r1 - r2) < 1e-12:
                part = _guard(lambda: sm.Cylinder(r1, h), "cylinder").translate(0, 0, z0 + h / 2)
                return [G(3, part, ("cyl", r1, 0.0, 0.0, z0, z0 + h))]
            part = _guard(lambda: sm.Cone(r1, r2, h), "cylinder").translate(0, 0, z0 + h / 2)
            return [G(3, part)]
        if name == "polyhedron":
            return [G(3, self.polyhedron(arg, num))]
        self.solids -= 1  # 2D shapes are not solids
        if name == "text":
            return self.text(arg, num)
        if name == "circle":
            a = arg(["r", "d"])
            r = num(a["r"], "r", True) if "r" in a else (num(a["d"], "d", True) / 2 if "d" in a else 1.0)
            return [G(2, _guard(lambda: sm.Circle(r), "circle"))]
        if name == "square":
            a = arg(["size", "center"])
            size = a.get("size", 1)
            w, h = ([num(size, "size", True)] * 2) if is_num(size) and not isinstance(size, bool) else vec(size, (2,), "size")[:2]
            if w <= 0 or h <= 0:
                raise ScadError("square: size must be positive")
            x0, y0 = (-w / 2, -h / 2) if a.get("center", False) else (0.0, 0.0)
            return [G(2, _guard(lambda: sm.Polygon((x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)), "square"))]
        a = arg(["points", "paths", "convexity"])
        pts = a.get("points")
        if not isinstance(pts, list) or len(pts) < 3 or len(pts) > 5000 or any(not isinstance(q, list) or len(q) != 2 for q in pts):
            raise ScadError("polygon: needs 3 to 5000 points [x, y]")
        pts = [(num(x, "point"), num(y, "point")) for x, y in pts]
        paths = a.get("paths")
        loops = [[int(i) for i in p] for p in paths] if isinstance(paths, list) and paths and all(isinstance(p, list) for p in paths) else [list(range(len(pts)))]
        if any(i < 0 or i >= len(pts) for p in loops for i in p) or any(len(p) < 3 for p in loops):
            raise ScadError("polygon: bad paths")

        def build(p):
            return _guard(lambda: sm.Polygon(*[pts[i] for i in p]), "polygon")
        shape = build(loops[0])
        for hole in loops[1:]:
            shape = _guard(lambda: shape.cut(build(hole)), "polygon")
        return [G(2, shape)]

    def text(self, arg, num):
        a = arg(["text", "size", "font", "halign", "valign", "spacing", "direction", "language", "script"])
        t = a.get("text", "")
        t = t if isinstance(t, str) else _fmt(t)
        if len(t) > 500:
            raise ScadError("text: at most 500 characters")
        size = num(a.get("size", 10), "size", True)
        spacing = num(a.get("spacing", 1), "spacing", True)
        if a.get("direction", "ltr") not in ("ltr", "rtl", "ttb", "btt"):
            raise ScadError("text: unknown direction")
        cell = size / 7.0
        width = (6 * spacing * (len(t) - 1) + 5) * cell if t else 0.0
        ox = {"left": 0.0, "center": -width / 2, "right": -width}.get(a.get("halign", "left"))
        oy = {"baseline": 0.0, "bottom": 0.0, "top": -size, "center": -size / 2}.get(a.get("valign", "baseline"))
        if ox is None or oy is None:
            raise ScadError("text: unknown halign / valign")
        out = []
        for i, ch in enumerate(t):
            x0 = ox + 6 * spacing * i * cell
            for outer, holes in _glyph_loops(ch):
                def poly(lp):
                    return _guard(lambda: sm.Polygon(*[(x0 + x * cell, oy + y * cell) for x, y in lp]), "text")
                shape = poly(outer)
                for h in holes:
                    shape = _guard(lambda: shape.cut(poly(h)), "text")
                out.append(G(2, shape))
        if len(out) > 400:
            raise ScadError("text: too many letters")
        return out

    def polyhedron(self, arg, num):
        a = arg(["points", "faces", "triangles", "convexity"])
        pts, faces = a.get("points"), a.get("faces", a.get("triangles"))
        if not isinstance(pts, list) or not 4 <= len(pts) <= 20000 or any(not isinstance(q, list) or len(q) != 3 for q in pts):
            raise ScadError("polyhedron: needs 4 to 20000 points [x, y, z]")
        if not isinstance(faces, list) or not faces or len(faces) > 40000 or any(not isinstance(f, list) or len(f) < 3 for f in faces):
            raise ScadError("polyhedron: needs faces (lists of point indices)")
        pts = [[num(c, "point") for c in q] for q in pts]
        tris = []
        for f in faces:
            idx = []
            for i in f:
                if not is_num(i) or isinstance(i, bool) or int(i) != i or not 0 <= int(i) < len(pts):
                    raise ScadError("polyhedron: bad point index in a face")
                idx.append(int(i))
            for k in range(1, len(idx) - 1):  # faces run clockwise seen from outside: reverse them for the kernel
                tris.append((idx[0], idx[k + 1], idx[k]))
        import numpy as np
        mesh = sm.Mesh(np.array(pts, dtype=float), np.array(tris, dtype=np.int64))
        return _guard(lambda: mesh.to_part(20000), "polyhedron")

    # ---- operations on shapes
    def move(self, g, fn, kind=None):
        sh = _guard(lambda: fn(g.shape), "transform")
        meta = g.meta
        if meta and kind and kind[0] == "t":
            v = kind[1]
            meta = ("cyl", meta[1], meta[2] + v[0], meta[3] + v[1], meta[4] + v[2], meta[5] + v[2])
        else:
            meta = None
        return G(g.dim, sh, meta)

    def rotate(self, g, a, v, num, vec):
        if is_num(a) and not isinstance(a, bool):
            ang = num(a, "a")
            if v is not None:
                axis = vec(v, (3,), "v")
                if not any(axis):
                    raise ScadError("rotate: the axis cannot be zero")
                return self.move(g, lambda sh: sh.rotate(sm.Axis((0, 0, 0), tuple(axis)), ang))
            steps = [(2, ang)]
        else:
            x, y, z = vec(a, (2, 3), "a")
            steps = [(0, x), (1, y), (2, z)]
        axes = [(1, 0, 0), (0, 1, 0), (0, 0, 1)]
        if g.dim == 2 and any(i != 2 and ang for i, ang in steps):
            raise ScadError("rotate: a 2D shape turns about Z only")
        out = g
        for i, ang in steps:
            if ang:
                out = self.move(out, lambda sh, i=i, ang=ang: sh.rotate(sm.Axis((0, 0, 0), axes[i]), ang))
        return out

    def scale(self, g, v):
        if any(abs(x) < 1e-12 for x in v):
            raise ScadError("scale: a factor cannot be 0")
        out = g
        for i, x in enumerate(v):
            if x < 0:
                n = [0, 0, 0]
                n[i] = 1
                out = self.mirror(out, n)
        f = tuple(abs(x) for x in v)
        if g.dim == 2:
            return self.move(out, lambda sh: sh.scale((f[0], f[1], 1.0)))
        return self.move(out, lambda sh: sh.scale(f))

    def mirror(self, g, n):
        if not any(n):
            raise ScadError("mirror: the normal cannot be zero")
        l = math.sqrt(sum(x * x for x in n))
        n = [x / l for x in n]
        ref = [1.0, 0.0, 0.0] if abs(n[0]) < 0.9 else [0.0, 1.0, 0.0]
        xdir = _cross(n, ref)
        lx = math.sqrt(sum(x * x for x in xdir))
        plane = sm.Plane((0, 0, 0), tuple(x / lx for x in xdir), tuple(n))
        return self.move(g, lambda sh: sh.mirror(plane))

    def multmatrix(self, g, m, num):
        if not (isinstance(m, list) and len(m) in (3, 4) and all(isinstance(r, list) and len(r) == 4 for r in m)):
            raise ScadError("multmatrix: needs a 4x4 matrix")
        R = [[num(m[r][c], "m") for c in range(3)] for r in range(3)]
        t = [num(m[r][3], "m") for r in range(3)]
        for i in range(3):
            for j in range(3):
                dot = sum(R[k][i] * R[k][j] for k in range(3))
                if abs(dot - (1.0 if i == j else 0.0)) > 1e-6:
                    raise ScadError("multmatrix: only rotations and moves are supported")
        det = (R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0])
               + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]))
        if det < 0:
            raise ScadError("multmatrix: mirroring matrices are not supported (use mirror)")
        tr = R[0][0] + R[1][1] + R[2][2]
        angle = math.degrees(math.acos(max(-1.0, min(1.0, (tr - 1) / 2))))
        out = g
        if angle > 1e-9:
            if abs(angle - 180) < 1e-6:  # half a turn: the axis is the dominant direction of R + I
                col = max(range(3), key=lambda c: R[c][c])
                axis = [R[r][col] + (1.0 if r == col else 0.0) for r in range(3)]
            else:
                axis = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]]
            l = math.sqrt(sum(x * x for x in axis))
            axis = [x / l for x in axis]
            out = self.move(out, lambda sh: sh.rotate(sm.Axis((0, 0, 0), tuple(axis)), angle))
        if any(t):
            out = self.move(out, lambda sh: sh.translate(*t), ("t", t))
        return out

    def combine(self, kind, shapes):
        base = shapes[0]
        for other in shapes[1:]:
            base = _guard(lambda: getattr(base, kind)(other), kind)
        return base

    def boolean(self, name, groups):
        groups = [g for g in groups if g]
        if not groups:
            return []
        if name == "union":
            flat = [g for grp in groups for g in grp]
            dims = {g.dim for g in flat}
            if len(dims) > 1:
                raise ScadError("union: cannot mix 2D and 3D shapes")
            if len(flat) == 1:
                return flat
            acc, apart = flat[0].shape, []
            for g in flat[1:]:
                try:
                    acc = acc.fuse(g.shape)
                except (sm.ModelingError, ValueError, TypeError, ArithmeticError):
                    apart.append(g)  # touching only along an edge or a point: it stays a body of its own
            return [G(flat[0].dim, acc)] + apart
        bases = [self.boolean("union", [grp])[0] for grp in groups]
        if len({b.dim for b in bases}) > 1:
            raise ScadError(f"{name}: cannot mix 2D and 3D shapes")
        if len(bases) == 1:
            return bases
        kind = "cut" if name == "difference" else "intersect"
        return [G(bases[0].dim, self.combine(kind, [b.shape for b in bases]))]

    def hull(self, flat):
        if not flat:
            return []
        if all(g.dim == 2 for g in flat):
            return [G(2, _guard(lambda: sm.Hull(*[g.shape for g in flat]), "hull"))]
        if all(g.dim == 3 and g.meta and g.meta[0] == "cyl" for g in flat):
            z0s = {round(g.meta[4], 9) for g in flat}
            z1s = {round(g.meta[5], 9) for g in flat}
            if len(z0s) == 1 and len(z1s) == 1:
                z0, z1 = flat[0].meta[4], flat[0].meta[5]
                circles = [sm.Circle(g.meta[1]).translate(g.meta[2], g.meta[3], 0) for g in flat]
                outline = _guard(lambda: sm.Hull(*circles), "hull")
                part = _guard(lambda: sm.extrude(outline, z1 - z0), "hull").translate(0, 0, z0)
                return [G(3, part)]
        if any(g.dim != 3 for g in flat):
            raise ScadError("hull: cannot mix 2D and 3D shapes")
        # any other 3D shapes: the convex hull of their tessellations (curved faces become facets)
        pts = []
        for g in flat:
            m = _guard(lambda: g.shape.mesh(), "hull")
            pts.extend(tuple(float(c) for c in v) for v in m.vertices.tolist())
        vertices, tris = hull3d(pts)
        import numpy as np
        mesh = sm.Mesh(np.array(vertices, dtype=float), np.array(tris, dtype=np.int64))
        self.count_solid()
        return [G(3, _guard(lambda: mesh.to_part(), "hull"))]

    def offset(self, flat, a, num):
        if not flat:
            return []
        if any(g.dim != 2 for g in flat):
            raise ScadError("offset: needs 2D shapes")
        sk = self.boolean("union", [flat])[0].shape
        if "r" in a:
            d, corners = num(a["r"], "r"), "round"
        elif "delta" in a:
            d, corners = num(a["delta"], "delta"), "chamfer" if a.get("chamfer") else "sharp"
        else:
            raise ScadError("offset: needs r or delta")
        if d == 0:
            return [G(2, sk)]
        return [G(2, _guard(lambda: sk.offset(d, corners=corners), "offset"))]

    def linear_extrude(self, flat, a, num):
        if not flat:
            return []
        if any(g.dim != 2 for g in flat):
            raise ScadError("linear_extrude: needs 2D shapes")
        h = num(a.get("height", 1), "height", True)
        if a.get("twist", 0) not in (0, 0.0, None) or a.get("scale", 1) not in (1, 1.0, None):
            raise ScadError("linear_extrude: twist and scale are not supported yet")
        sk = self.boolean("union", [flat])[0].shape
        self.count_solid()
        part = _guard(lambda: sm.extrude(sk, h), "linear_extrude")
        if a.get("center", False):
            part = part.translate(0, 0, -h / 2)
        return [G(3, part)]

    def rotate_extrude(self, flat, a, num):
        if not flat:
            return []
        if any(g.dim != 2 for g in flat):
            raise ScadError("rotate_extrude: needs 2D shapes")
        angle = num(a.get("angle", 360), "angle")
        sk = self.boolean("union", [flat])[0].shape
        bb = sk.bbox()
        if list(bb.min)[0] < -1e-9:
            raise ScadError("rotate_extrude: the shape must lie at x >= 0")
        self.count_solid()
        # the profile's x becomes the radius and its y the height: revolve about Y, then stand Y up as Z
        part = _guard(lambda: sm.revolve(sk, sm.Axis((0, 0, 0), (0, 1, 0)), angle), "rotate_extrude")
        return [G(3, part.rotate(sm.Axis((0, 0, 0), (1, 0, 0)), 90))]


# ---------------------------------------------------------------- entry points

def read_files(source):
    """-> (files {name: source}, main name) from one script or a bundle."""
    if source.startswith(BUNDLE_MAGIC):
        if len(source) > MAX_BUNDLE:
            raise ScadError("bundle too large")
        try:
            data = json.loads(source[len(BUNDLE_MAGIC):])
            files, main = data["files"], data["main"]
        except (ValueError, KeyError, TypeError):
            raise ScadError("bad bundle") from None
        if not isinstance(files, dict) or not files or len(files) > MAX_FILES or not all(isinstance(k, str) and isinstance(v, str) for k, v in files.items()):
            raise ScadError("bad bundle")
        files = {k.replace("\\", "/").rsplit("/", 1)[-1]: v for k, v in files.items()}
        main = str(main).replace("\\", "/").rsplit("/", 1)[-1]
        if main not in files:
            raise ScadError("bundle: the main file is missing")
        return files, main
    return {"main.scad": source}, "main.scad"


def evaluate(source, commands=None, prefix="S"):
    """The shapes a script (or a bundle of scripts) makes: a list of Parts / Shells, one per top-level solid."""
    try:
        files, main = read_files(source)
        it = Interp(files, main)
        shapes = it.run_block(it.load(main), Scope(None))
    except RecursionError:
        raise ScadError("nesting limit exceeded") from None
    if not shapes:
        raise ScadError("SCAD contains no solids")
    if any(g.dim != 3 for g in shapes):
        raise ScadError("2D shapes need linear_extrude (or rotate_extrude) to become solids")
    if len(shapes) > MAX_SOLIDS:
        raise ScadError("too many solids")
    return [g.shape for g in shapes]

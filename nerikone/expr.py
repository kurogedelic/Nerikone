"""Expressions in parameters: a number can be written "=wall_h + 0.2", naming variables set by earlier var.set steps.

Only arithmetic is allowed (numbers, variable names, + - * / // % **, parentheses, a few functions); anything else is
refused. Angles for sin / cos / tan are in degrees. Standard library only (it also runs in the browser build).
"""
import ast
import math
import re

FUNCS = {
    "sqrt": math.sqrt, "abs": abs, "min": min, "max": max, "round": round, "floor": math.floor, "ceil": math.ceil,
    "sin": lambda d: math.sin(math.radians(d)), "cos": lambda d: math.cos(math.radians(d)), "tan": lambda d: math.tan(math.radians(d)),
    "asin": lambda x: math.degrees(math.asin(x)), "acos": lambda x: math.degrees(math.acos(x)), "atan": lambda x: math.degrees(math.atan(x)),
    "atan2": lambda y, x: math.degrees(math.atan2(y, x)), "hypot": math.hypot,
}
CONSTS = {"pi": math.pi, "e": math.e}
NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,40}$")
_OPS = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b, ast.Div: lambda a, b: a / b,
        ast.FloorDiv: lambda a, b: a // b, ast.Mod: lambda a, b: a % b, ast.Pow: lambda a, b: a ** b}


class ExprError(ValueError):
    pass


def is_expr(v):
    return isinstance(v, str) and v.strip().startswith("=")


def valid_name(n):
    return isinstance(n, str) and bool(NAME.match(n)) and n not in FUNCS and n not in CONSTS


def _parse(text):
    src = text.strip()[1:] if is_expr(text) else str(text)
    if len(src) > 400:
        raise ExprError("expression too long")
    try:
        tree = ast.parse(src.strip(), mode="eval")
    except SyntaxError:
        raise ExprError(f"cannot read the expression '{src.strip()}'") from None
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Name, ast.Load, ast.Call,
                                 ast.UAdd, ast.USub, *_OPS)):
            raise ExprError(f"only arithmetic is allowed in '{src.strip()}'")
        if isinstance(node, ast.Constant) and (isinstance(node.value, bool) or not isinstance(node.value, (int, float))):
            raise ExprError("only numbers are allowed")
        if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.func.id not in FUNCS or node.keywords):
            raise ExprError(f"functions are {', '.join(sorted(FUNCS))}")
    return tree


def names(text):
    """The variable names an expression uses."""
    tree = _parse(text)
    called = {n.func.id for n in ast.walk(tree) if isinstance(n, ast.Call)}
    return sorted({n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} - called - set(CONSTS))


def check(text):
    _parse(text)
    return text.strip()


def evaluate(text, variables):
    tree = _parse(text)

    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant):
            return n.value
        if isinstance(n, ast.Name):
            if n.id in CONSTS:
                return CONSTS[n.id]
            if n.id not in variables:
                raise ExprError(f"no variable '{n.id}' (set it with var.set before this step)")
            return variables[n.id]
        if isinstance(n, ast.UnaryOp):
            v = ev(n.operand)
            return -v if isinstance(n.op, ast.USub) else v
        if isinstance(n, ast.BinOp):
            a, b = ev(n.left), ev(n.right)
            if isinstance(n.op, ast.Pow) and (abs(b) > 64 or abs(a) > 1e6):
                raise ExprError("power too large")
            return _OPS[type(n.op)](a, b)
        if isinstance(n, ast.Call):
            return FUNCS[n.func.id](*[ev(a) for a in n.args])
        raise ExprError("only arithmetic is allowed")

    try:
        v = float(ev(tree))
    except ExprError:
        raise
    except (ArithmeticError, ValueError, TypeError) as e:
        raise ExprError(f"'{text.strip()}': {e}") from None
    if not math.isfinite(v):
        raise ExprError(f"'{text.strip()}' is not a finite number")
    return v

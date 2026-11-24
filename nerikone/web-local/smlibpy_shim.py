"""smlibpy for Pyodide (the browser build):  the same names, backed by smlibwasm (JavaScript). Generic: snake_case -> camelCase, JS objects wrapped."""
import re, sys, types
import smjs
import numpy as np
from pyodide.ffi import JsProxy, to_js
from pyodide.code import run_js

def _raise(e):
    m = str(e)
    if 'ModelingError' in m or 'KernelError' in m:
        raise ModelingError(m.split(':', 1)[-1].strip()) from None
    # JavaScript's built-in errors are Python's built-ins in smlibpy: the kernel code catches ValueError / TypeError
    last = [ln for ln in m.strip().splitlines() if ln.strip()][-1]
    for js, py in (('RangeError', ValueError), ('TypeError', TypeError)):
        if js + ':' in last:
            raise py(last.split(js + ':', 1)[1].strip()) from None
    raise e

def _camel(n):
    return re.sub(r'_([a-z0-9])', lambda m: m.group(1).upper(), n)

def _unwrap(x):
    if isinstance(x, W): return x._js
    if isinstance(x, (bytes, bytearray, memoryview)): return to_js(bytes(x))  # file contents: a Uint8Array, not a PyProxy
    if isinstance(x, np.ndarray):  # vertices / triangle indices: one flat typed array (what Mesh(vertices, triangles) takes)
        return to_js(np.ascontiguousarray(x.ravel().astype(np.float64 if x.dtype.kind == 'f' else np.uint32)))
    if isinstance(x, (list, tuple)): return to_js([_unwrap(i) for i in x], depth=1)
    if isinstance(x, dict): return to_js({k: _unwrap(v) for k, v in x.items()}, dict_converter=run_js("Object.fromEntries"))
    return x

_TYPED = {'Float64Array': np.float64, 'Float32Array': np.float32, 'Uint32Array': np.uint32, 'Int32Array': np.int32, 'Uint16Array': np.uint16}

def _wrap(x):
    if isinstance(x, JsProxy):
        cn = getattr(x, 'constructor', None)
        cn = cn.name if cn is not None else ''
        if cn == 'Uint8Array': return bytes(x.to_py())
        if cn in _TYPED: return np.asarray(x.to_py(), dtype=_TYPED[cn]).reshape(-1, 3) if len(x) % 3 == 0 else np.asarray(x.to_py(), dtype=_TYPED[cn])
        if x.typeof == 'function': return Fn(x)
        if hasattr(x, 'length') and not hasattr(x, 'faces') and x.typeof == 'object' and x.constructor.name == 'Array':
            return [_wrap(i) for i in x]
        return _cls(cn or 'W')(x)
    return x

class Fn:
    def __init__(self, f, this=None): self._f, self._this = f, this
    def __call__(self, *a, **kw):
        args = [_unwrap(i) for i in a]
        if kw: args.append(_unwrap({_camel(k): v for k, v in kw.items()}))
        try: return _wrap(self._f(*args))
        except Exception as e:
            _raise(e)

_CLASSES = {}
def _cls(name):  # a Python class per JS class, so type(x).__name__ is 'Part', 'Sketch', 'Shell' ... as in smlibpy
    c = _CLASSES.get(name)
    if c is None: c = _CLASSES[name] = type(name, (W,), {})
    return c

class _Meta(type):
    def __instancecheck__(cls, obj):
        if type.__instancecheck__(cls, obj): return True
        return type.__instancecheck__(W, obj) and obj._js.constructor.name == cls.__name__

class W(metaclass=_Meta):
    def __init__(self, js): object.__setattr__(self, '_js', js)
    def __getattr__(self, name):
        js = object.__getattribute__(self, '_js')
        v = getattr(js, _camel(name), None) if hasattr(js, _camel(name)) else getattr(js, name)
        return _wrap(v)
    def _vec(self):
        js = object.__getattribute__(self, '_js')
        if js.constructor.name == 'Vector': return tuple(js.toArray().to_py())
        return None
    def _op(self, o, f):
        a = self._vec()
        if a is None: return NotImplemented
        b = o._vec() if isinstance(o, W) else o
        if isinstance(b, (tuple, list)): r = tuple(f(x, y) for x, y in zip(a, b))
        else: r = tuple(f(x, b) for x in a)
        return _wrap(smjs.Vector.new(*r))
    def __add__(self, o): return self._op(o, lambda x, y: x + y)
    def __sub__(self, o): return self._op(o, lambda x, y: x - y)
    def __mul__(self, o): return self._op(o, lambda x, y: x * y)
    __rmul__ = __mul__
    def __truediv__(self, o): return self._op(o, lambda x, y: x / y)
    def __neg__(self): return _wrap(smjs.Vector.new(*[-x for x in self._vec()]))
    def __float__(self): return float(self._js)
    def __iter__(self):
        js = self._js
        if hasattr(js, 'toArray'): return iter(list(js.toArray().to_py()))
        return iter([_wrap(i) for i in js])
    def __len__(self): return self._js.length
    def __getitem__(self, i): return _wrap(self._js[i])
    def __repr__(self): return repr(self._js)

def _ctor(name):
    c = getattr(smjs, name)
    def make(*a, **kw): return _wrap(c.new(*[_unwrap(i) for i in a], *([_unwrap(kw)] if kw else [])))
    make.__name__ = name
    return make

mod = types.ModuleType('smlibpy')
class ModelingError(Exception): pass
mod.ModelingError = ModelingError
def export_usd(shapes, path):
    data = smjs.toUsd(_unwrap(list(shapes)))
    if hasattr(data, 'to_py'): data = data.to_py()
    open(path, 'wb').write(data.encode() if isinstance(data, str) else bytes(data))
mod.export_usd = export_usd
def __getattr__(name):
    if name.startswith('__'): raise AttributeError(name)
    v = getattr(smjs, _camel(name))
    if v.typeof == 'function':
        n = v.name
        if n and n[0].isupper():
            return _Class(name, v)
        return Fn(v)
    return _wrap(v)
class _Class(type):
    pass
def _Class(name, v):  # a constructor usable both as sm.Box(...) and in isinstance(x, sm.Part)
    class C(metaclass=_Meta):
        def __new__(cls, *a, **kw):
            if name == 'Plane' and kw:  # Plane(origin, x_dir, z_dir) takes positionals in JS
                a = list(a) + [None] * (3 - len(a)); a[1] = kw.get('x_dir', a[1]); a[2] = kw.get('z_dir', a[2]); kw = {}
            args = [_unwrap(i) for i in a] + ([_unwrap(kw)] if kw else [])
            try: return _wrap(v(*args))
            except Exception as e:
                if 'without' in str(e) and 'new' in str(e): return _wrap(v.new(*args))
                raise
    C.__name__ = name; C._v = v
    return C
mod.__getattr__ = __getattr__
sys.modules['smlibpy'] = mod

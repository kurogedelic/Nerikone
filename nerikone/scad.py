"""Bounded subset of the .scad solid-script format. No Python evaluation, file access, or implicit fallback."""
import ast
import math
import re

class ScadError(ValueError):
    pass

TOKEN = re.compile(r'\s+|//[^\n]*|/\*[\s\S]*?\*/|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_$][\w$]*|==|!=|<=|>=|&&|\|\||[^\s]', re.ASCII)

def number(node, env):
    if isinstance(node, ast.Constant) and type(node.value) in (int, float, bool): return node.value
    if isinstance(node, ast.Name) and node.id in env: return env[node.id]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and len(node.args)==1 and not node.keywords:
        if node.func.id in ('sin','cos','tan'):
            return getattr(math,node.func.id)(math.radians(number(node.args[0],env)))
    if isinstance(node, ast.Compare) and len(node.ops)==1 and len(node.comparators)==1:
        a,b=number(node.left,env),number(node.comparators[0],env)
        ops={ast.Gt:a>b,ast.Lt:a<b,ast.GtE:a>=b,ast.LtE:a<=b,ast.Eq:a==b,ast.NotEq:a!=b}
        if type(node.ops[0]) in ops: return ops[type(node.ops[0])]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        v = number(node.operand, env); return v if isinstance(node.op, ast.UAdd) else -v
    if isinstance(node, ast.BinOp):
        a, b = number(node.left, env), number(node.right, env)
        ops = {ast.Add: lambda: a+b, ast.Sub: lambda: a-b, ast.Mult: lambda: a*b,
               ast.Div: lambda: a/b, ast.Mod: lambda: a%b, ast.Pow: lambda: a**b}
        if type(node.op) is ast.Pow and (abs(a)>1e6 or abs(b)>16): raise ScadError('exponent exceeds limit')
        if type(node.op) in ops: return ops[type(node.op)]()
    raise ScadError('unsupported expression')

class Parser:
    def __init__(self, source):
        if len(source) > 100_000: raise ScadError('SCAD source exceeds 100 KB')
        self.t = []; pos = 0
        for m in TOKEN.finditer(source):
            if m.start() != pos: raise ScadError(f'invalid syntax at offset {pos}')
            pos = m.end(); s = m.group()
            if not s.isspace() and not s.startswith(('//','/*')): self.t.append(s)
        if pos != len(source): raise ScadError(f'invalid syntax at offset {pos}')
        if len(self.t) > 20_000: raise ScadError('too many tokens')
        self.t.append('<end>'); self.i = 0
    def peek(self): return self.t[self.i]
    def pop(self):
        v = self.peek(); self.i += 1; return v
    def eat(self, v):
        if self.peek() == v: self.pop(); return True
        return False
    def need(self, v):
        if not self.eat(v): raise ScadError(f'expected {v}, got {self.peek()}')
    def ident(self):
        v = self.pop()
        if not re.fullmatch(r'[A-Za-z_$][\w$]*', v, re.ASCII): raise ScadError(f'expected identifier, got {v}')
        return v
    def expr(self, stops):
        out=[]; depth=0
        while self.peek() != '<end>':
            v=self.peek()
            if depth == 0 and v in stops: break
            if v in ('(', '['): depth+=1
            if v in (')', ']'): depth-=1
            if depth < 0: break
            out.append(self.pop())
        if not out: raise ScadError('expected expression')
        return out
    def value(self, env, stops):
        if self.eat('['):
            v=[]
            if not self.eat(']'):
                while True:
                    v.append(self.value(env, {',', ']'}))
                    if self.eat(']'): break
                    self.need(',')
            return v
        toks=self.expr(stops)
        if toks == ['true']: return True
        if toks == ['false']: return False
        if toks == ['undef']: raise ScadError('undef is unsupported')
        if len(toks)==1 and toks[0] in env and isinstance(env[toks[0]], list): return env[toks[0]]
        try:
            tree=ast.parse(' '.join(toks), mode='eval')
            v=number(tree.body, env)
            if not isinstance(v, (int,float,bool)) or not math.isfinite(v) or abs(v)>1e9: raise ScadError('non-finite or excessive value')
            return v
        except (SyntaxError, ZeroDivisionError, OverflowError) as e: raise ScadError(f'invalid expression: {e}') from None
    def args(self, env):
        self.need('('); pos=[]; kw={}
        if not self.eat(')'):
            while True:
                if re.fullmatch(r'[A-Za-z_$][\w$]*', self.peek(), re.ASCII) and self.t[self.i+1]=='=':
                    k=self.pop(); self.pop()
                    if k in kw: raise ScadError(f'duplicate argument {k}')
                    kw[k]=self.value(env, {',',')'})
                else: pos.append(self.value(env, {',',')'}))
                if self.eat(')'): break
                self.need(',')
        return pos,kw
    def statements(self, env, depth=0, block=False):
        if depth>32: raise ScadError('nesting limit exceeded')
        result=[]
        while self.peek() not in ('<end>', '}'):
            name=self.ident()
            if name=='if':
                pos,kw=self.args(env)
                if len(pos)!=1 or kw: raise ScadError('if expects one condition')
                yes=self.statements_one(env.copy(),depth+1)
                no=[]
                if self.eat('else'): no=self.statements_one(env.copy(),depth+1)
                result.extend(yes if pos[0] else no); continue
            if self.eat('='):
                env[name]=self.value(env, {';'}); self.need(';'); continue
            pos,kw=self.args(env)
            children=[]
            if self.eat('{'):
                children=self.statements(env.copy(),depth+1,True); self.need('}')
            elif self.peek()!=';':
                children=self.statements_one(env.copy(),depth+1)
            else: self.pop()
            result.append((name,pos,kw,children))
            if len(result)>1000: raise ScadError('too many operations')
        if block and self.peek()=='<end>': raise ScadError('unclosed block')
        if not block and self.peek()=='}': raise ScadError('unexpected }')
        return result
    def statements_one(self,env,depth):
        # Parse one child using a bounded token slice ending at its semicolon or matching block.
        start=self.i; level=0
        while self.peek()!='<end>':
            v=self.pop()
            if v=='{': level+=1
            elif v=='}':
                level-=1
                if level==0: break
            elif v==';' and level==0: break
        sub=Parser(' '.join(self.t[start:self.i])); return sub.statements(env,depth)

def expand_modules(source):
    """Expand only local, nonrecursive module definitions; no include/use or code execution."""
    parser=Parser(source); tokens=parser.t[:-1]; modules={}; kept=[]; i=0
    def matching(t,start,left,right):
        depth=0
        for j in range(start,len(t)):
            if t[j]==left: depth+=1
            elif t[j]==right:
                depth-=1
                if depth==0: return j
        raise ScadError(f'unclosed {left}')
    def split_args(seq):
        out=[]; start=0; depth=0
        for i,v in enumerate(seq):
            if v in ('(', '['): depth+=1
            elif v in (')', ']'): depth-=1
            elif v==',' and depth==0: out.append(seq[start:i]); start=i+1
        if seq[start:]: out.append(seq[start:])
        return out
    while i<len(tokens):
        if tokens[i]!='module': kept.append(tokens[i]); i+=1; continue
        if i+2>=len(tokens) or tokens[i+2]!='(': raise ScadError('invalid module definition')
        name=tokens[i+1]; end=matching(tokens,i+2,'(',')')
        params=[]
        for part in split_args(tokens[i+3:end]):
            if len(part)!=1 or not re.fullmatch(r'[A-Za-z_$][\w$]*',part[0],re.ASCII): raise ScadError('module defaults unsupported')
            params.append(part[0])
        if end+1>=len(tokens) or tokens[end+1]!='{': raise ScadError('module requires block')
        close=matching(tokens,end+1,'{','}')
        if name in modules: raise ScadError(f'duplicate module {name}')
        modules[name]=(params,tokens[end+2:close]); i=close+1
    count=0
    def expand(seq, stack=()):
        nonlocal count
        out=[]; i=0
        while i<len(seq):
            v=seq[i]
            if v in modules and i+1<len(seq) and seq[i+1]=='(':
                if v in stack or len(stack)>16: raise ScadError('recursive module')
                end=matching(seq,i+1,'(',')'); params,body=modules[v]; values=split_args(seq[i+2:end])
                if len(params)!=len(values): raise ScadError(f'{v}: expected {len(params)} arguments')
                if end+1>=len(seq) or seq[end+1]!=';': raise ScadError('module call requires semicolon')
                mapping=dict(zip(params,values))
                sub=[]
                for k,tok in enumerate(body):
                    sub.extend(['(',*mapping[tok],')'] if tok in mapping and (k+1==len(body) or body[k+1]!='=') else [tok])
                count+=1
                if count>100: raise ScadError('module expansion limit exceeded')
                out.extend(['union','(',')','{',*expand(sub,stack+(v,)),'}']); i=end+2
            else: out.append(v); i+=1
            if len(out)>20000: raise ScadError('expanded SCAD too large')
        return out
    return ' '.join(expand(kept))

def evaluate(source, commands, prefix):
    source=expand_modules(source)
    nodes=Parser(source).statements({}); bodies={}; serial=0
    def create(cmd, params):
        nonlocal serial
        serial+=1
        if serial>500: raise ScadError('solid operation limit exceeded')
        name=f'{prefix}.{serial}'; params={**params,'name':name}
        params = {**params, **{p.name: p.default for p in commands[cmd].params if p.name not in params}}
        for key in ('length','width','height','radius'):
            if key in params and params[key] <= 0: raise ScadError(f'{cmd}: {key} must be positive')
        commands[cmd].run(bodies,params)
        return [name]
    def extrude_2d(shape, height):
        if isinstance(shape,str): raise ScadError('cannot extrude a 3D solid')
        if shape['type']=='csg':
            names=[]
            for child in shape['children']: names.extend(extrude_2d(child,height))
            if names and isinstance(names[0],dict):
                return [{'type':'csg','kind':{'union':'union','difference':'cut','intersection':'intersect'}[kind], 'children':names}]
            if len(names)>1:
                commands['body.boolean'].run(bodies,{'kind':shape['kind'],'target':names[0],'tools':names[1:],'keep_tools':False})
            return names[:1]
        if shape['type']=='circle':
            # A circle is represented by a regular outline at the declared $fn-independent resolution.
            x,y,r=shape['x'],shape['y'],shape['r']
            pts=[[x+r*math.cos(2*math.pi*i/96),y+r*math.sin(2*math.pi*i/96)] for i in range(96)]
            fillet=0
        elif shape['type']=='poly': pts=shape['points']; fillet=shape.get('fillet',0)
        else: raise ScadError('unsupported 2D shape in linear_extrude')
        return create('sketch.extrude',{'points':pts,'height':height,'z':0,'fillet':fillet,'taper':0})

    def one(node,depth=0):
        if depth>32: raise ScadError('nesting limit exceeded')
        kind,pos,kw,children=node
        def args(names):
            if len(pos)>len(names) or any(k not in names for k in kw): raise ScadError(f'{kind}: unsupported arguments')
            a=dict(zip(names,pos)); a.update(kw); return a
        def scalar(v):
            if type(v) not in (int,float) or not math.isfinite(v): raise ScadError(f'{kind}: expected finite number')
            return float(v)
        def vec(v):
            if type(v) not in (list,tuple) or len(v)!=3: raise ScadError(f'{kind}: expected 3-vector')
            return [scalar(x) for x in v]
        if kind=='circle':
            if children: raise ScadError('circle: unexpected child')
            a=args(['r','d','$fn','$fa','$fs']); r=scalar(a.get('r',a.get('d',2)/2))
            if r<=0: raise ScadError('circle radius must be positive')
            return [{'type':'circle','x':0,'y':0,'r':r}]
        if kind=='polygon':
            if children: raise ScadError('polygon: unexpected child')
            a=args(['points']); pts=a.get('points')
            if not isinstance(pts,list) or len(pts)<3 or len(pts)>500 or any(not isinstance(q,list) or len(q)!=2 for q in pts): raise ScadError('polygon needs 3-500 2D points')
            return [{'type':'poly','points':[[scalar(x),scalar(y)] for x,y in pts],'fillet':0}]
        if kind in ('cube','cylinder','sphere'):
            if children: raise ScadError(f'{kind}: unexpected child')
            if kind=='cube':
                a=args(['size','center']); size=a.get('size',1); size=[size]*3 if type(size) in (int,float) else size
                size=vec(size); center=a.get('center',False)
                if type(center)!=bool: raise ScadError('cube: center must be boolean')
                return create('body.box',dict(zip(('length','width','height'),size),at=[0,0,0] if center else [x/2 for x in size]))
            if kind=='sphere':
                a=args(['r','d','$fn','$fa','$fs']); r=a.get('r', a.get('d',2)/2)
                return create('body.sphere',{'radius':scalar(r)})
            a=args(['h','r1','r2','center','r','d','d1','d2','$fn','$fa','$fs']); h=scalar(a.get('h',1))
            r1=scalar(a.get('r1',a.get('r',a.get('d1',a.get('d',2))/2)))
            r2=scalar(a.get('r2',a.get('r',a.get('d2',a.get('d',2))/2)))
            at=[0,0,0] if a.get('center',False) else [0,0,h/2]
            if r1==r2: return create('body.cylinder',{'height':h,'radius':r1,'at':at})
            return create('body.cone',{'height':h,'bottom_radius':r1,'top_radius':r2,'at':at})
        names=[]
        for child in children: names.extend(one(child,depth+1))
        if kind=='hull':
            if pos or kw or not children: raise ScadError('hull requires children')
            if any(q['type']!='circle' for q in names): raise ScadError('hull currently supports circles only')
            radii={q['r'] for q in names}
            xs={q['x'] for q in names}; ys={q['y'] for q in names}
            if len(radii)!=1 or len(xs)!=2 or len(ys)!=2 or len(names)!=4 or {(q['x'],q['y']) for q in names}!={(x,y) for x in xs for y in ys}: raise ScadError('hull currently supports four equal circles at rectangle corners')
            r=next(iter(radii)); x0,x1=min(xs)-r,max(xs)+r; y0,y1=min(ys)-r,max(ys)+r
            return [{'type':'poly','points':[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],'fillet':r}]
        if kind=='offset':
            a=args(['r','delta']); d=scalar(a.get('r',a.get('delta',0)))
            if len(names)!=1 or names[0]['type'] not in ('poly','offset'): raise ScadError('offset supports one polygon')
            child=names[0]
            if child['type']=='offset' and child['distance']<0 and d>0 and abs(child['distance']+d)<1e-9:
                return [{**child['child'],'fillet':d}]
            return [{'type':'offset','child':child,'distance':d}]
        if kind=='linear_extrude':
            a=args(['height','center','convexity','twist','slices','scale']); h=scalar(a.get('height',1))
            if h<=0 or a.get('center',False) or a.get('twist',0) or a.get('scale',1)!=1: raise ScadError('linear_extrude: unsupported options')
            result=[]
            for q in names: result.extend(extrude_2d(q,h))
            return result
        if kind in ('translate','rotate','scale'):
            a=args(['v' if kind!='rotate' else 'a']); v=a.get('v',a.get('a'))
            if kind=='rotate' and type(v) in (int,float): v=[0,0,v]
            if kind=='scale':
                if isinstance(v,list) and (len(v)!=3 or len(set(v))!=1): raise ScadError('nonuniform scale unsupported')
                v=v[0] if isinstance(v,list) else v
            if names and isinstance(names[0],dict):
                if kind!='translate' or not isinstance(v,list) or len(v) not in (2,3): raise ScadError('2D transform supports translation only')
                dx,dy=scalar(v[0]),scalar(v[1])
                def shift(q):
                    if q['type']=='circle': q['x']+=dx; q['y']+=dy
                    elif q['type']=='poly': q['points']=[[x+dx,y+dy] for x,y in q['points']]
                    elif q['type']=='csg':
                        for child in q['children']: shift(child)
                    else: raise ScadError('unsupported 2D transform')
                for q in names: shift(q)
                return names
            for n in names: commands['body.transform'].run(bodies,{'body':n,'translate':vec(v) if kind=='translate' else [0,0,0], 'rotate':vec(v) if kind=='rotate' else [0,0,0], 'scale':scalar(v) if kind=='scale' else 1,'pivot':[0,0,0]})
            return names
        if kind in ('union','difference','intersection'):
            if pos or kw: raise ScadError(f'{kind}: arguments unsupported')
            if not names: raise ScadError(f'{kind}: requires children')
            if names and isinstance(names[0],dict):
                return [{'type':'csg','kind':{'union':'union','difference':'cut','intersection':'intersect'}[kind], 'children':names}]
            if len(names)>1:
                commands['body.boolean'].run(bodies,{'kind':{'union':'union','difference':'cut','intersection':'intersect'}[kind], 'target':names[0], 'tools':names[1:], 'keep_tools':False})
            return names[:1]
        raise ScadError(f'unsupported SCAD operation: {kind}')
    result=[]
    for node in nodes: result.extend(one(node))
    if not result: raise ScadError('SCAD contains no solids')
    if any(not isinstance(n,str) for n in result): raise ScadError('2D shapes require linear_extrude')
    return [bodies[n] for n in result]

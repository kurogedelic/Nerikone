// Browser build: api/... requests go to the kernel running in this page's Web Worker (worker.js) instead of a server.
const worker = new Worker(new URL('./worker.js?v=__BUILD__', import.meta.url), {type: 'module'});
const pending = new Map();
let nextId = 1, ready;
const readyP = new Promise(r => { ready = r; });

const box = Object.assign(document.createElement('div'), {id: 'kernelload'});
box.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;background:#17181a;color:#e6e8ec;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;transition:opacity .4s';
box.innerHTML = '<div style="text-align:center;width:min(280px,70vw)"><div style="font-size:14px;margin-bottom:10px">Nerikone</div>' +
  '<div style="height:4px;border-radius:2px;background:#ffffff1c;overflow:hidden"><div id="kernelbar" style="height:100%;width:8%;border-radius:2px;background:#ffc933;transition:width .6s cubic-bezier(.2,.8,.2,1)"></div></div>' +
  '<div id="kernelmsg" style="color:#8f959e;margin-top:8px">カーネルを読み込み中…</div></div>';
// until the first real step is reported, the bar creeps forward so it never looks stuck (the kernel's own download and compile come first)
let creep = 8; const creeper = setInterval(() => { creep = Math.min(creep + 1.5, 30); const b = document.getElementById('kernelbar'); if (b && parseFloat(b.style.width) < creep) b.style.width = creep + '%'; }, 700);
document.addEventListener('DOMContentLoaded', () => document.body.append(box));
if (document.body) document.body.append(box);

worker.onmessage = ev => {
  const m = ev.data;
  if (m.progress) { clearInterval(creeper); const e = document.getElementById('kernelmsg'); if (e) e.textContent = m.progress; const b = document.getElementById('kernelbar'); if (b && m.pct) b.style.width = m.pct + '%'; return; }
  if (m.fatal) { const e = document.getElementById('kernelmsg'); if (e) e.textContent = 'カーネルを読み込めませんでした: ' + m.fatal; return; }
  if (m.ready) { clearInterval(creeper); ready(); box.style.opacity = '0'; setTimeout(() => box.remove(), 500); return; }
  const done = pending.get(m.id); if (done) { pending.delete(m.id); done(m); }
};

// offline cache + installable app (see sw.js); only on https or localhost
if ('serviceWorker' in navigator && !location.search.includes('nosw') && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* the page works without it */ });
}

const realFetch = window.fetch.bind(window);
window.fetch = async (url, init = {}) => {
  const u = new URL(typeof url === 'string' ? url : url.url, location.href);
  const i = u.pathname.indexOf('/api/');
  if (i < 0) return realFetch(url, init);
  await readyP;
  let body = init.body ?? null;
  if (typeof body === 'string') body = new TextEncoder().encode(body).buffer;
  else if (body instanceof Blob) body = await body.arrayBuffer();
  else if (body && body.buffer) body = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const id = nextId++;
  const query = Object.fromEntries(u.searchParams.entries());
  const m = await new Promise(res => { pending.set(id, res); worker.postMessage({id, method: (init.method || 'GET').toUpperCase(), path: u.pathname.slice(i), query, body}, body ? [body] : []); });
  return new Response(m.data, {status: m.status, headers: {'Content-Type': m.ctype, ...(m.headers || {})}});
};

"""
app.py — Single-file Darkmode Proxy Browser (FastAPI)

Dependencies:
    pip install fastapi uvicorn httpx beautifulsoup4 html5lib

Run locally:
    uvicorn app:app --host 0.0.0.0 --port 8000

Notes for deployment:
- Locally it serves frontend at http://localhost:8000/
- To deploy to Vercel as a single serverless function, rename to api/index.py
  and make sure Vercel's Python runtime is used. You may need to provide
  dependencies in requirements.txt in that case.

Use responsibly. Proxying third-party sites may be subject to terms-of-service,
robots.txt, and copyright. This is a basic educational example.
"""
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse, PlainTextResponse
import httpx
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse, quote_plus, unquote_plus
import re

app = FastAPI(title="Darkmode Proxy Browser (Single File)")

# Simple user agent for upstream requests
USER_AGENT = "DarkProxy/1.0 (+https://example.local/)"

# ==== Frontend HTML (embedded) ====
FRONTEND_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Dark Proxy Browser</title>
<style>
:root{--bg:#07080a;--panel:#0b0d0f;--muted:#9aa8bf;--accent:#8ab4ff;--text:#e6eef8}
html,body{height:100%;margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial}
.app{display:flex;flex-direction:column;height:100vh}
.topbar{height:56px;background:linear-gradient(180deg,#0f1113,#0b0d0f);display:flex;align-items:center;padding:8px 12px;gap:8px}
.urlbar{flex:1;background:#0e1114;border:1px solid #1a1d22;padding:6px;border-radius:8px;color:var(--muted);display:flex;align-items:center;gap:8px}
.urlbar input{flex:1;background:transparent;border:0;color:var(--text);outline:none;font-size:14px}
.btn{background:#151718;border:none;padding:8px 10px;border-radius:8px;color:var(--muted);cursor:pointer}
.controls{display:flex;gap:8px;align-items:center}
.framewrap{flex:1;padding:8px}
.card{background:var(--panel);height:100%;border-radius:12px;overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,0.6)}
.iframe{width:100%;height:100%;border:0;background:white}
.tabs{display:flex;gap:6px;margin-right:8px}
.tab{padding:6px 10px;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;font-size:13px}
.tab.active{background:rgba(255,255,255,0.04);color:var(--text)}
.small{font-size:12px;color:var(--muted)}
.footer{height:28px;display:flex;align-items:center;padding:6px 12px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="tabs" id="tabs">
      <div class="tab active" data-id="1">Tab 1</div>
      <div class="tab" id="newtab">+</div>
    </div>
    <div class="urlbar">
      <form id="navform" style="display:flex;flex:1">
        <input id="urlinput" placeholder="Enter URL or paste link (e.g. example.com)" autocomplete="off"/>
        <button class="btn" type="submit" id="gobutton">Go</button>
      </form>
    </div>
    <div class="controls">
      <button class="btn" id="reload">Reload</button>
      <button class="btn" id="back">◀</button>
      <button class="btn" id="forward">▶</button>
    </div>
  </div>

  <div class="framewrap">
    <div class="card">
      <!-- iframe loads proxied pages; sandbox allows scripts and forms but same-origin is required for some features -->
      <iframe id="proxyframe" class="iframe" src="/proxy?url=https%3A%2F%2Fexample.com" sandbox="allow-scripts allow-forms allow-same-origin allow-popups"></iframe>
    </div>
  </div>

  <div class="footer small">Dark Proxy Browser — navigation stays inside the proxy. Use responsibly.</div>
</div>

<script>
(() => {
  const iframe = document.getElementById('proxyframe');
  const urlInput = document.getElementById('urlinput');
  const navForm = document.getElementById('navform');
  const reloadBtn = document.getElementById('reload');
  const backBtn = document.getElementById('back');
  const fwdBtn = document.getElementById('forward');
  const newTabBtn = document.getElementById('newtab');
  const tabsEl = document.getElementById('tabs');

  // Simple tab state
  let tabs = [{id:1, title:'Tab 1', url: iframe.src}];
  let active = 1;

  function setIFrameSrc(proxyUrl) {
    iframe.src = proxyUrl;
  }

  navForm.addEventListener('submit', (e) => {
    e.preventDefault();
    let val = urlInput.value.trim();
    if(!val) return;
    if(!/^https?:\/\//i.test(val)) val = 'https://' + val;
    const prox = '/proxy?url=' + encodeURIComponent(val);
    // navigate
    setIFrameSrc(prox);
    // update active tab
    tabs = tabs.map(t => t.id===active ? {...t, url: prox, title: val} : t);
    renderTabs();
  });

  reloadBtn.addEventListener('click', () => {
    iframe.src = iframe.src;
  });

  // Basic back/forward using history within iframe not accessible because of cross-origin.
  // We implement a micro history stack in the parent to emulate basic back/forward.
  const historyStack = {};
  historyStack[1] = {back:[], forward:[]};

  // When iframe changes location (e.g., user clicks proxied link), the proxy rewrites hrefs to point to /proxy.
  // We listen for navigation by intercepting messages posted from within proxied pages (we inject a small script server-side).
  window.addEventListener('message', (ev) => {
    if(!ev.data || typeof ev.data !== 'object') return;
    if(ev.data.__darkproxy_navigate) {
      const proxyUrl = ev.data.__darkproxy_navigate;
      // push current to back, clear forward
      const h = historyStack[active] || {back:[], forward:[]};
      h.back.push(iframe.src);
      h.forward = [];
      historyStack[active] = h;
      setIFrameSrc(proxyUrl);
      tabs = tabs.map(t=> t.id===active ? {...t, url: proxyUrl} : t);
      renderTabs();
    }
  }, false);

  backBtn.addEventListener('click', () => {
    const h = historyStack[active] || {back:[], forward:[]};
    if(h.back.length===0) return;
    const prev = h.back.pop();
    h.forward.push(iframe.src);
    historyStack[active] = h;
    setIFrameSrc(prev);
    tabs = tabs.map(t=> t.id===active ? {...t, url: prev} : t);
    renderTabs();
  });
  fwdBtn.addEventListener('click', () => {
    const h = historyStack[active] || {back:[], forward:[]};
    if(h.forward.length===0) return;
    const next = h.forward.pop();
    h.back.push(iframe.src);
    historyStack[active] = h;
    setIFrameSrc(next);
    tabs = tabs.map(t=> t.id===active ? {...t, url: next} : t);
    renderTabs();
  });

  newTabBtn.addEventListener('click', () => {
    const id = Date.now();
    tabs.unshift({id, title:'New Tab', url:'/proxy?url=' + encodeURIComponent('about:blank')});
    active = id;
    historyStack[id] = {back:[], forward:[]};
    renderTabs();
    setIFrameSrc(tabs[0].url);
  });

  function renderTabs(){
    // re-render tab elements except the plus
    // keep first child(s) up to the plus element
    // Simple approach: rebuild the tabs DOM (except the + button)
    // remove all current tabs DOM nodes except the last child (+)
    while(tabsEl.firstChild && tabsEl.children.length>1) tabsEl.removeChild(tabsEl.firstChild);
    for(let i=tabs.length-1;i>=0;i--){
      const t = tabs[i];
      const d = document.createElement('div');
      d.className = 'tab' + (t.id===active ? ' active' : '');
      d.textContent = t.title.length>18 ? t.title.slice(0,16)+'..' : t.title;
      d.dataset.id = t.id;
      d.addEventListener('click', () => {
        active = t.id;
        setIFrameSrc(t.url);
        renderTabs();
      });
      tabsEl.insertBefore(d, newTabBtn);
    }
  }

  // initial render
  renderTabs();

  // quick paste-handler (middle-click) to paste link into URL bar
  urlInput.addEventListener('paste', (e) => {
    // no special handling right now
  });

  // expose a small api for proxied pages to call parent navigation (injected by server)
  window.darkproxy = {
    navigate: (proxyUrl) => {
      window.postMessage({__darkproxy_navigate: proxyUrl}, location.origin);
    }
  };
})();
</script>
</body>
</html>
"""

# ==== Helpers for proxying & rewriting ====

async def fetch_target(url: str):
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers=headers) as client:
        resp = await client.get(url)
        return resp

def should_skip_rewrite(val: str) -> bool:
    if not val: 
        return True
    val = val.strip()
    if val.startswith(("javascript:", "mailto:", "data:")):
        return True
    return False

def proxy_url_for(abs_url: str) -> str:
    return f"/proxy?url={quote_plus(abs_url)}"

def rewrite_html(original_url: str, html_text: str) -> str:
    # Parse using html5lib parser for robustness
    soup = BeautifulSoup(html_text, "html5lib")

    def rewrite_attr(tag, attr, is_srcset=False):
        if not tag.has_attr(attr):
            return
        val = tag.get(attr)
        if not val:
            return
        if is_srcset:
            parts = val.split(',')
            new_parts = []
            for part in parts:
                sub = part.strip()
                if ' ' in sub:
                    url_part, descriptor = sub.split(' ', 1)
                else:
                    url_part, descriptor = sub, ''
                if should_skip_rewrite(url_part):
                    new_parts.append(sub)
                    continue
                abs_url = urljoin(original_url, url_part)
                new_parts.append(f"{proxy_url_for(abs_url)} {descriptor}".strip())
            tag[attr] = ', '.join(new_parts)
            return
        # normal attr
        val = val.strip()
        if should_skip_rewrite(val):
            return
        abs_url = urljoin(original_url, val)
        tag[attr] = proxy_url_for(abs_url)

    # rewrite anchors, links, images, scripts, forms, sources, iframes
    for a in soup.find_all('a'):
        if a.has_attr('href'):
            rewrite_attr(a, 'href')
            a['target'] = '_self'
    for link in soup.find_all('link'):
        if link.has_attr('href'):
            rewrite_attr(link, 'href')
    for img in soup.find_all('img'):
        rewrite_attr(img, 'src')
        rewrite_attr(img, 'srcset', is_srcset=True)
    for script in soup.find_all('script'):
        rewrite_attr(script, 'src')
    for form in soup.find_all('form'):
        rewrite_attr(form, 'action')
    for iframe in soup.find_all('iframe'):
        rewrite_attr(iframe, 'src')
    for source in soup.find_all('source'):
        rewrite_attr(source, 'src')
        rewrite_attr(source, 'srcset', is_srcset=True)

    # meta refresh
    for meta in soup.find_all('meta'):
        if meta.has_attr('http-equiv') and meta['http-equiv'].lower() == 'refresh' and meta.has_attr('content'):
            content = meta['content']
            match = re.search(r'url=\\s*(.+)', content, flags=re.IGNORECASE)
            if match:
                part = match.group(1).strip().strip('\"\'')
                abs_url = urljoin(original_url, part)
                meta['content'] = re.sub(r'url=\\s*.+', f'URL={proxy_url_for(abs_url)}', content, flags=re.IGNORECASE)

    # insert <base> so relative URLs inside CSS etc. that rely on base will resolve to proxied page
    head = soup.head
    if head:
        base_tag = soup.new_tag('base', href=proxy_url_for(original_url))
        head.insert(0, base_tag)

    # inject dark-mode CSS and a small script to intercept clicks and postMessage to parent for history
    inject_css = soup.new_tag('style')
    inject_css.string = """
/* simple dark override (non-exhaustive) */
html,body { background: #0b0d0f !important; color: #e6eef8 !important; }
a { color: #8ab4ff !important; }
"""
    if soup.head:
        soup.head.append(inject_css)
    else:
        soup.insert(0, inject_css)

    inject_script = soup.new_tag('script')
    inject_script.string = r"""
// DarkProxy injected script: intercept clicks to keep inside proxy and notify parent for history handling.
(function(){
  try {
    document.addEventListener('click', function(e){
      var a = e.target.closest && e.target.closest('a');
      if(!a) return;
      var href = a.getAttribute('href');
      if(!href) return;
      if(href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('data:')) return;
      // allow new-tab or ctrl/meta clicks
      if(a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      // if href already proxied (starts with /proxy) let it go (it will navigate)
      if(href.startsWith('/proxy')) {
        // use postMessage to parent so parent can maintain history stack and update UI
        if(window.parent && window.parent !== window) {
          try { window.parent.postMessage({__darkproxy_navigate: href}, '*'); } catch(e) {}
        }
        location.href = href;
        return;
      }
      // else the backend should have rewritten everything; but fallback: build proxied url and navigate
      var prox = '/proxy?url=' + encodeURIComponent(href);
      if(window.parent && window.parent !== window) {
        try { window.parent.postMessage({__darkproxy_navigate: prox}, '*'); } catch(e) {}
      }
      location.href = prox;
    }, true);

    // intercept form submits to route through proxy
    document.addEventListener('submit', function(e){
      var f = e.target;
      if(!f) return;
      var action = f.getAttribute('action') || location.href;
      if(action.startsWith('/proxy')) return; // already proxied
      var prox = '/proxy?url=' + encodeURIComponent(action);
      f.setAttribute('action', prox);
    }, true);
  } catch(err) {
    // swallow
  }
})();
"""
    # append script at end of body to ensure DOM is ready
    if soup.body:
        soup.body.append(inject_script)
    else:
        soup.append(inject_script)

    return str(soup)

# ==== FastAPI endpoints ====

@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse(content=FRONTEND_HTML, status_code=200)

@app.get("/proxy")
async def proxy(request: Request, url: str = None):
    if not url:
        return PlainTextResponse("Usage: /proxy?url=<ENCODED_URL>", status_code=400)
    try:
        target = unquote_plus(url)
    except:
        target = url

    parsed = urlparse(target)
    if not parsed.scheme or parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Target URL must include http:// or https://")

    # Fetch target
    try:
        resp = await fetch_target(target)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Error fetching target: {e}")

    content_type = resp.headers.get("Content-Type","")
    # If content is HTML-like, rewrite
    if "text/html" in content_type.lower():
        # If resp has explicit encoding, use resp.text which decodes properly
        text = resp.text
        rewritten = rewrite_html(target, text)
        return HTMLResponse(content=rewritten, status_code=resp.status_code)
    else:
        # stream other assets through
        headers = dict(resp.headers)
        # remove hop-by-hop headers that are not appropriate
        for h in ("transfer-encoding", "content-encoding", "connection"):
            headers.pop(h, None)
        return Response(content=resp.content, status_code=resp.status_code, media_type=headers.get("Content-Type"))

# small health endpoint
@app.get("/_health")
async def health():
    return PlainTextResponse("ok", status_code=200)

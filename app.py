"""
Darkmode Proxy Browser — Single File for Vercel (multi-tabs + bookmarks)

Run locally:
    uvicorn app:app --reload

Deploy on Vercel:
    push repo with app.py, requirements.txt, vercel.json

Notes:
- Frontend is embedded in FRONTEND_HTML.
- Backend provides /proxy which fetches targets and rewrites links so navigation stays inside the proxy.
- Bookmarks are client-side via localStorage.
"""
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import HTMLResponse, PlainTextResponse
import httpx
from bs4 import BeautifulSoup
from urllib.parse import urljoin, quote_plus, unquote_plus, urlparse
import re

app = FastAPI(title="Darkmode Proxy Browser")

USER_AGENT = "DarkProxy/1.0 (+https://example.local/)"

# === Frontend UI (dark mode) with multi-tabs + bookmarks ===
FRONTEND_HTML = """<!DOCTYPE html>
<html lang='en'>
<head>
<meta charset='UTF-8'/>
<meta name='viewport' content='width=device-width,initial-scale=1'/>
<title>Dark Proxy Browser</title>
<style>
:root{
  --bg:#07080a; --panel:#0b0d0f; --muted:#9aa8bf; --accent:#8ab4ff; --text:#e6eef8;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial}
.app{display:flex;flex-direction:column;height:100vh}
.topbar{height:56px;background:#0b0d0f;display:flex;align-items:center;padding:8px 12px;gap:8px;flex-shrink:0}
.tabs{display:flex;gap:6px;align-items:center}
.tab{padding:6px 10px;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;font-size:13px;display:flex;gap:8px;align-items:center}
.tab.active{background:rgba(255,255,255,0.04);color:var(--text)}
.tab .close{font-size:12px;color:#888;cursor:pointer;padding-left:6px}
.urlbar{flex:1;background:#0e1114;border:1px solid #1a1d22;padding:6px;border-radius:8px;display:flex;align-items:center;gap:8px}
.urlbar input{flex:1;background:transparent;border:0;color:var(--text);outline:none;font-size:14px}
.btn{background:#151718;border:none;padding:8px 10px;border-radius:8px;color:var(--muted);cursor:pointer}
.controls{display:flex;gap:8px;align-items:center}
.sidepanel{position:fixed;right:12px;top:72px;width:300px;max-height:70vh;background:#0e1114;border-radius:10px;padding:10px;box-shadow:0 10px 30px rgba(0,0,0,0.6);overflow:auto;display:none;z-index:999}
.sidepanel.visible{display:block}
.sidepanel h4{margin:6px 0 10px 0;color:var(--muted)}
.bookmark{display:flex;justify-content:space-between;gap:8px;padding:6px;border-radius:6px;background:transparent;margin-bottom:6px}
.bookmark a{color:var(--text);text-decoration:none;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.frame{flex:1;padding:12px;min-height:0}
.card{background:var(--panel);height:100%;border-radius:12px;overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,0.6)}
iframe{width:100%;height:100%;border:0;background:white}
.footer{height:28px;display:flex;align-items:center;padding:6px 12px;color:var(--muted);font-size:12px}
.small{font-size:12px;color:var(--muted)}
.search{display:flex;gap:6px}
.icon{width:18px;height:18px;display:inline-block;opacity:0.9}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="tabs" id="tabs"></div>
    <div style="width:8px"></div>
    <div class="urlbar">
      <form id="navform" style="display:flex;flex:1">
        <input id="urlinput" placeholder="Enter URL or paste link (e.g. example.com)" autocomplete="off"/>
        <button class="btn" type="submit" id="gobutton">Go</button>
      </form>
    </div>
    <div class="controls">
      <button class="btn" id="back">◀</button>
      <button class="btn" id="forward">▶</button>
      <button class="btn" id="reload">⟳</button>
      <button class="btn" id="bookmark">★</button>
      <button class="btn" id="toggleBookmarks">Bookmarks</button>
      <button class="btn" id="newtab">+</button>
    </div>
  </div>

  <div class="frame">
    <div class="card">
      <iframe id="proxyframe" src="/proxy?url=https%3A%2F%2Fexample.com" sandbox="allow-scripts allow-forms allow-same-origin allow-popups"></iframe>
    </div>
  </div>

  <div class="footer small">Dark Proxy Browser — navigation stays inside the proxy. Bookmarks are stored locally.</div>
</div>

<!-- Bookmarks side panel -->
<div class="sidepanel" id="bookmarkPanel">
  <h4>Bookmarks</h4>
  <div id="bookmarksList"></div>
  <div style="height:10px"></div>
  <div style="display:flex;gap:6px">
    <input id="bmName" placeholder="Name" style="flex:1;padding:6px;border-radius:6px;background:#0b0d0f;border:1px solid #1a1d22;color:var(--text)"/>
    <input id="bmUrl" placeholder="URL" style="flex:2;padding:6px;border-radius:6px;background:#0b0d0f;border:1px solid #1a1d22;color:var(--text)"/>
    <button class="btn" id="addBookmarkBtn">Save</button>
  </div>
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
  const bookmarkBtn = document.getElementById('bookmark');
  const toggleBookmarksBtn = document.getElementById('toggleBookmarks');
  const bookmarkPanel = document.getElementById('bookmarkPanel');
  const bookmarksList = document.getElementById('bookmarksList');
  const addBookmarkBtn = document.getElementById('addBookmarkBtn');
  const bmNameInput = document.getElementById('bmName');
  const bmUrlInput = document.getElementById('bmUrl');
  const tabsContainer = document.getElementById('tabs');

  // tab state: array of {id, title, url}
  let tabs = [];
  let activeId = null;
  // per-tab history stacks (simple)
  const historyStacks = {};

  // Bookmarks storage key
  const BM_KEY = 'darkproxy_bookmarks';

  // Helpers
  function makeTabTitleFromUrl(u) {
    try {
      const parsed = new URL(decodeURIComponent(u.split('url=')[1] || u));
      return parsed.hostname + parsed.pathname;
    } catch (e) {
      return u.length>20?u.slice(0,18)+'..':u;
    }
  }

  function saveBookmarks(bms) {
    localStorage.setItem(BM_KEY, JSON.stringify(bms||[]));
  }
  function loadBookmarks() {
    try {
      return JSON.parse(localStorage.getItem(BM_KEY) || '[]');
    } catch(e){ return []; }
  }

  function renderBookmarks() {
    const bms = loadBookmarks();
    bookmarksList.innerHTML = '';
    if(bms.length===0){
      bookmarksList.innerHTML = '<div class="small">No bookmarks yet.</div>';
      return;
    }
    bms.forEach((b, i) => {
      const div = document.createElement('div');
      div.className = 'bookmark';
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = b.name || b.url;
      a.title = b.url;
      a.addEventListener('click', (e) => { e.preventDefault(); openInActiveTab('/proxy?url=' + encodeURIComponent(b.url)); });
      const right = document.createElement('div');
      const openBtn = document.createElement('button'); openBtn.className='btn'; openBtn.textContent='Open'; openBtn.addEventListener('click', ()=>openInActiveTab('/proxy?url='+encodeURIComponent(b.url)));
      const delBtn = document.createElement('button'); delBtn.className='btn'; delBtn.textContent='Del'; delBtn.addEventListener('click', ()=>{ bms.splice(i,1); saveBookmarks(bms); renderBookmarks(); });
      right.appendChild(openBtn); right.appendChild(delBtn);
      div.appendChild(a); div.appendChild(right);
      bookmarksList.appendChild(div);
    });
  }

  function renderTabs() {
    // rebuild tabs DOM left-to-right
    tabsContainer.innerHTML = '';
    tabs.forEach(t => {
      const d = document.createElement('div');
      d.className = 'tab' + (t.id===activeId ? ' active' : '');
      d.dataset.id = t.id;
      d.title = t.title;
      const titleSpan = document.createElement('span');
      titleSpan.textContent = t.title.length>18 ? t.title.slice(0,16)+'..' : t.title;
      d.appendChild(titleSpan);
      const close = document.createElement('span');
      close.className = 'close';
      close.textContent = '✕';
      close.addEventListener('click', (ev) => { ev.stopPropagation(); closeTab(t.id); });
      d.appendChild(close);
      d.addEventListener('click', () => { switchTab(t.id); });
      tabsContainer.appendChild(d);
    });
  }

  function newTab(initialUrl='/proxy?url=' + encodeURIComponent('about:blank')) {
    const id = Date.now() + Math.floor(Math.random()*1000);
    const title = 'New';
    tabs.push({id, title, url: initialUrl});
    historyStacks[id] = {back:[], forward:[]};
    activeId = id;
    navigateTo(initialUrl, true);
    renderTabs();
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t=>t.id===id);
    if(idx===-1) return;
    tabs.splice(idx,1);
    delete historyStacks[id];
    if(id===activeId) {
      if(tabs.length>0) {
        const next = tabs[Math.max(0, idx-1)];
        activeId = next.id;
        navigateTo(next.url, true);
      } else {
        newTab('/proxy?url=' + encodeURIComponent('about:blank'));
      }
    }
    renderTabs();
  }

  function switchTab(id) {
    const t = tabs.find(x=>x.id===id);
    if(!t) return;
    activeId = id;
    navigateTo(t.url, true);
    renderTabs();
  }

  function navigateTo(proxyUrl, replace=false) {
    // update iframe src and the active tab's url
    iframe.src = proxyUrl;
    if(activeId) {
      const t = tabs.find(x=>x.id===activeId);
      if(t) {
        if(!replace) {
          // push prev to back stack
          historyStacks[activeId].back.push(t.url);
          historyStacks[activeId].forward = [];
        }
        t.url = proxyUrl;
        t.title = makeTabTitleFromUrl(proxyUrl);
      }
    }
    urlInput.value = decodeURIComponent((proxyUrl.split('url=')[1]||''));
  }

  function openInActiveTab(proxyUrl) {
    if(!activeId) newTab();
    navigateTo(proxyUrl);
    renderTabs();
  }

  // basic back / forward
  backBtn.addEventListener('click', () => {
    if(!activeId) return;
    const h = historyStacks[activeId];
    if(!h || h.back.length===0) return;
    const prev = h.back.pop();
    h.forward.push(tabs.find(t=>t.id===activeId).url);
    navigateTo(prev, true);
    renderTabs();
  });
  fwdBtn.addEventListener('click', () => {
    if(!activeId) return;
    const h = historyStacks[activeId];
    if(!h || h.forward.length===0) return;
    const next = h.forward.pop();
    h.back.push(tabs.find(t=>t.id===activeId).url);
    navigateTo(next, true);
    renderTabs();
  });

  // form nav
  navForm.addEventListener('submit', (e) => {
    e.preventDefault();
    let v = urlInput.value.trim();
    if(!v) return;
    if(!/^https?:\\/\\//i.test(v)) v = 'https://' + v;
    const prox = '/proxy?url=' + encodeURIComponent(v);
    openInActiveTab(prox);
  });

  reloadBtn.addEventListener('click', () => {
    iframe.src = iframe.src;
  });

  newTabBtn.addEventListener('click', () => newTab('/proxy?url=' + encodeURIComponent('about:blank')));

  // bookmarks
  toggleBookmarksBtn.addEventListener('click', () => {
    bookmarkPanel.classList.toggle('visible');
    renderBookmarks();
  });

  addBookmarkBtn.addEventListener('click', () => {
    let name = bmNameInput.value.trim();
    let url = bmUrlInput.value.trim();
    if(!url) {
      // default to current tab URL
      const t = tabs.find(x=>x.id===activeId);
      if(t) url = decodeURIComponent(t.url.split('url=')[1]||'');
    }
    if(!url) return alert('No URL to bookmark');
    if(!/^https?:\\/\\//i.test(url)) url = 'https://' + url;
    const bms = loadBookmarks();
    bms.push({name: name || url, url});
    saveBookmarks(bms);
    bmNameInput.value = ''; bmUrlInput.value = '';
    renderBookmarks();
  });

  bookmarkBtn.addEventListener('click', () => {
    // bookmark current tab quickly
    const t = tabs.find(x=>x.id===activeId);
    if(!t) return;
    const currentUrl = decodeURIComponent(t.url.split('url=')[1]||'');
    const bms = loadBookmarks();
    bms.push({name: makeTabTitleFromUrl(t.url), url: currentUrl});
    saveBookmarks(bms);
    renderBookmarks();
    if(!bookmarkPanel.classList.contains('visible')) bookmarkPanel.classList.add('visible');
  });

  // Listen for navigation messages from proxied pages (injected by server)
  window.addEventListener('message', (ev) => {
    if(!ev.data || typeof ev.data !== 'object') return;
    if(ev.data.__darkproxy_navigate) {
      const proxyUrl = ev.data.__darkproxy_navigate;
      // push current to back, clear forward
      if(activeId) {
        const t = tabs.find(x=>x.id===activeId);
        if(t) {
          historyStacks[activeId].back.push(t.url);
          historyStacks[activeId].forward = [];
        }
      }
      openInActiveTab(proxyUrl);
    }
  }, false);

  // Initialize with one tab
  function init() {
    const startUrl = '/proxy?url=' + encodeURIComponent('https://example.com');
    tabs = [{id: 1, title: 'example.com', url: startUrl}];
    historyStacks[1] = {back:[], forward:[]};
    activeId = 1;
    navigateTo(startUrl, true);
    renderTabs();
    renderBookmarks();
  }

  init();

  // expose for debugging
  window.darkproxy_internal = {tabs, historyStacks, openInActiveTab};
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

def should_skip(val: str) -> bool:
    if not val:
        return True
    v = val.strip().lower()
    return v.startswith(("javascript:", "mailto:", "data:"))

def proxy_url_for(abs_url: str) -> str:
    return f"/proxy?url={quote_plus(abs_url)}"

def rewrite_html(original_url: str, html_text: str) -> str:
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
                if should_skip(url_part):
                    new_parts.append(sub)
                    continue
                abs_url = urljoin(original_url, url_part)
                new_parts.append(f"{proxy_url_for(abs_url)} {descriptor}".strip())
            tag[attr] = ', '.join(new_parts)
            return
        if should_skip(val):
            return
        abs_url = urljoin(original_url, val)
        tag[attr] = proxy_url_for(abs_url)

    # rewrite common attributes
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

    # meta refresh handling
    for meta in soup.find_all('meta'):
        if meta.has_attr('http-equiv') and meta['http-equiv'].lower() == 'refresh' and meta.has_attr('content'):
            content = meta['content']
            match = re.search(r'url=\\s*(.+)', content, flags=re.IGNORECASE)
            if match:
                part = match.group(1).strip().strip('\"\\' ')
                abs_url = urljoin(original_url, part)
                meta['content'] = re.sub(r'url=\\s*.+', f'URL={proxy_url_for(abs_url)}', content, flags=re.IGNORECASE)

    # insert base tag for resolving relative links in CSS, etc.
    head = soup.head
    if head:
        base_tag = soup.new_tag('base', href=proxy_url_for(original_url))
        head.insert(0, base_tag)
        # add simple dark CSS
        style = soup.new_tag('style')
        style.string = "html,body{background:#0b0d0f!important;color:#e6eef8!important} a{color:#8ab4ff!important}"
        head.append(style)

    # inject script to intercept clicks and notify parent (for history) — appended to body
    injected = soup.new_tag('script')
    injected.string = r"""
(function(){
  try {
    document.addEventListener('click', function(e){
      var a = e.target.closest && e.target.closest('a');
      if(!a) return;
      var href = a.getAttribute('href');
      if(!href) return;
      if(href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('data:')) return;
      // allow ctrl/meta or target=_blank
      if(a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      // If already proxied (starts with /proxy) notify parent so it can push history
      if(href.startsWith('/proxy')) {
        try { window.parent.postMessage({__darkproxy_navigate: href}, '*'); } catch(e){}
        location.href = href;
        return;
      }
      // fallback: build proxied url and navigate
      var prox = '/proxy?url=' + encodeURIComponent(href);
      try { window.parent.postMessage({__darkproxy_navigate: prox}, '*'); } catch(e){}
      location.href = prox;
    }, true);

    // intercept form submits to route through proxy
    document.addEventListener('submit', function(e){
      var f = e.target;
      if(!f) return;
      var action = f.getAttribute('action') || location.href;
      if(action.startsWith('/proxy')) return;
      var prox = '/proxy?url=' + encodeURIComponent(action);
      f.setAttribute('action', prox);
    }, true);
  } catch(err){}
})();
"""
    if soup.body:
        soup.body.append(injected)
    else:
        soup.append(injected)

    return str(soup)

# ==== FastAPI endpoints ====

@app.get('/', response_class=HTMLResponse)
async def index():
    return HTMLResponse(content=FRONTEND_HTML, status_code=200)

@app.get('/proxy')
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
    try:
        resp = await fetch_target(target)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Error fetching target: {e}")
    content_type = resp.headers.get("Content-Type", "")
    if "text/html" in content_type.lower():
        text = resp.text
        rewritten = rewrite_html(target, text)
        return HTMLResponse(content=rewritten, status_code=resp.status_code)
    else:
        headers = dict(resp.headers)
        for h in ("transfer-encoding", "content-encoding", "connection"):
            headers.pop(h, None)
        return Response(content=resp.content, status_code=resp.status_code, media_type=headers.get("Content-Type"))

@app.get('/_health')
async def health():
    return PlainTextResponse("ok", status_code=200)

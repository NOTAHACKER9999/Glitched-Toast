"""
Diagnostic proxy for testing — safer, more verbose.

Use:
  uvicorn app:app --reload
Or deploy to Vercel (app.py + requirements.txt).

requirements.txt should include:
fastapi
uvicorn
httpx
beautifulsoup4
html5lib
"""

import traceback
import time
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, Response, PlainTextResponse, JSONResponse
import httpx
from bs4 import BeautifulSoup
from urllib.parse import unquote_plus, urljoin
from typing import Deque
from collections import deque

app = FastAPI(title="Diagnostic Proxy")

# keep last N diagnostic entries in memory for quick debugging (not persistent)
DIAG_HISTORY_MAX = 30
_diag: Deque[dict] = deque(maxlen=DIAG_HISTORY_MAX)

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; DarkProxy/1.0)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

FRONTEND_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>Proxy Diagnostic</title></head>
<body style="background:#111;color:#eee;font-family:system-ui;padding:12px">
  <h2>Proxy Diagnostic UI</h2>
  <p>Enter an address to proxy (include https:// recommended):</p>
  <form id="f"><input id="u" style="width:420px" placeholder="https://example.com"/><button>Go</button></form>
  <div id="out" style="margin-top:12px;border-radius:8px;padding:8px;background:#0b0d0f"></div>
  <script>
    const f=document.getElementById('f'), u=document.getElementById('u'), out=document.getElementById('out');
    f.addEventListener('submit', async e=>{
      e.preventDefault();
      let url=u.value.trim();
      if(!url) return;
      if(!/^https?:\\/\\//i.test(url)) url='https://'+url;
      out.innerText = 'Loading...';
      try{
        const resp = await fetch('/proxy?url='+encodeURIComponent(url));
        // if html, show it inside out
        const ct = resp.headers.get('content-type') || '';
        if(ct.includes('text/html')) {
          const text = await resp.text();
          out.innerHTML = text;
        } else {
          const blob = await resp.blob();
          out.innerText = 'Non-HTML response (content-type: '+ct+') — length: '+blob.size;
        }
      }catch(err){
        out.innerText = 'Fetch error: '+err;
      }
    });
  </script>
</body></html>
"""

def add_diag(entry: dict):
    entry['_ts'] = time.time()
    _diag.appendleft(entry)

@app.get("/", response_class=HTMLResponse)
async def index():
    return FRONTEND_HTML

@app.get("/_diag")
async def diag():
    # return last few diagnostic entries (json)
    return JSONResponse([dict(e) for e in list(_diag)])

@app.get("/proxy")
async def proxy(request: Request, url: str = None):
    start = time.time()
    if not url:
        return PlainTextResponse("Missing ?url=...", status_code=400)
    try:
        target = unquote_plus(url)
    except Exception:
        target = url

    # Very basic validation
    if not (target.startswith("http://") or target.startswith("https://")):
        return PlainTextResponse("Target must start with http:// or https://", status_code=400)

    # Build headers to send upstream; forward client's User-Agent if present
    headers = DEFAULT_HEADERS.copy()
    incoming_ua = request.headers.get("user-agent")
    if incoming_ua:
        headers["User-Agent"] = incoming_ua

    # Try to fetch with httpx and catch errors — provide clear diagnostics
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=20.0, headers=headers) as client:
            upstream = await client.get(target)
    except Exception as e:
        tb = traceback.format_exc()
        diag = {"url": target, "error": str(e), "trace": tb}
        add_diag(diag)
        # Return a helpful HTML error so you can see it in the browser
        body = f"<h2>Fetch error</h2><pre>{str(e)}</pre><h3>Traceback</h3><pre>{tb}</pre>"
        return HTMLResponse(body, status_code=502)

    # Save some diagnostics about the upstream response
    diag = {
        "url": target,
        "status_code": upstream.status_code,
        "content_type": upstream.headers.get("content-type"),
        "headers_sample": {k: upstream.headers.get(k) for k in ("content-type","content-length","x-frame-options","content-security-policy")},
        "elapsed_s": upstream.elapsed.total_seconds() if hasattr(upstream, "elapsed") else None,
    }
    add_diag(diag)

    content_type = upstream.headers.get("content-type", "").lower()

    # If HTML-like, inject <base> and return rewritten HTML
    if "text/html" in content_type or content_type.startswith("application/xhtml"):
        try:
            # Use html5lib or the default parser if not installed
            soup = BeautifulSoup(upstream.text, "html.parser")
            # inject base
            if soup.head:
                base_tag = soup.new_tag("base", href=target)
                # ensure we don't duplicate base tags
                existing = soup.head.find("base")
                if existing:
                    existing['href'] = target
                else:
                    soup.head.insert(0, base_tag)
            # optional small dark css injection (non-destructive)
            if soup.head:
                style = soup.new_tag("style")
                style.string = "html,body{background:#0b0d0f!important;color:#e6eef8!important;} a{color:#8ab4ff!important}"
                soup.head.append(style)
            out_html = str(soup)
            # return with original upstream status code
            return HTMLResponse(content=out_html, status_code=upstream.status_code, headers={"x-proxy-from": target})
        except Exception as e:
            tb = traceback.format_exc()
            add_diag({"url": target, "parse_error": str(e), "trace": tb})
            return HTMLResponse(f"<h2>Parse error</h2><pre>{str(e)}</pre><pre>{tb}</pre>", status_code=500)

    # For non-HTML (images, CSS, JS), return bytes with original content type
    try:
        ct = upstream.headers.get("content-type", "application/octet-stream")
        # Remove hop-by-hop headers if present (we won't forward them)
        headers_out = {}
        # copy caching headers for convenience
        for k in ("content-length","cache-control","etag","last-modified"):
            v = upstream.headers.get(k)
            if v: headers_out[k] = v
        # include debug header pointing to source
        headers_out["x-proxy-from"] = target
        return Response(content=upstream.content, media_type=ct, headers=headers_out, status_code=upstream.status_code)
    except Exception as e:
        tb = traceback.format_exc()
        add_diag({"url": target, "stream_error": str(e), "trace": tb})
        return HTMLResponse(f"<h2>Stream error</h2><pre>{str(e)}</pre><pre>{tb}</pre>", status_code=500)

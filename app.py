from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, Response, PlainTextResponse
import httpx
from bs4 import BeautifulSoup
from urllib.parse import unquote_plus, urljoin
import re

app = FastAPI(title="Full Server-side Proxy")

FRONTEND_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Server-side Proxy Test</title>
</head>
<body style="background:#111;color:#fff;font-family:sans-serif;padding:10px">
<h2>Server-side Proxy Test</h2>
<form id="f">
<input type="text" id="url" placeholder="Enter URL (e.g. duckduckgo.com)" style="width:300px"/>
<button type="submit">Go</button>
</form>
<div id="content" style="margin-top:10px"></div>
<script>
const f=document.getElementById('f');
const urlInput=document.getElementById('url');
const content=document.getElementById('content');
f.addEventListener('submit', async e=>{
  e.preventDefault();
  let u=urlInput.value.trim();
  if(!u) return;
  if(!/^https?:\/\//i.test(u)) u='https://'+u;
  const res=await fetch('/proxy?url='+encodeURIComponent(u));
  const html=await res.text();
  content.innerHTML=html;
});
</script>
</body>
</html>
"""

@app.get("/", response_class=HTMLResponse)
async def home():
    return FRONTEND_HTML

def rewrite_html(base_url: str, html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    
    # Inject <base> for relative links
    head = soup.head
    if head:
        base_tag = soup.new_tag("base", href=base_url)
        head.insert(0, base_tag)

    # Dark mode CSS
    style = soup.new_tag("style")
    style.string = """
        body { background:#111!important; color:#fff!important; }
        a { color:#8ab4ff!important; }
    """
    if head:
        head.append(style)

    # Rewrite links to go through /proxy
    for tag in soup.find_all(["a","link","script","img","iframe","form"]):
        for attr in ["href","src","action"]:
            if tag.has_attr(attr):
                val = tag[attr]
                if val and not val.startswith(("javascript:","data:","mailto:")):
                    abs_url = urljoin(base_url, val)
                    tag[attr] = f"/proxy?url={abs_url}"

    return str(soup)

@app.get("/proxy")
async def proxy(url: str = None):
    if not url:
        return PlainTextResponse("Missing ?url=...", status_code=400)
    
    target_url = unquote_plus(url)
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        try:
            r = await client.get(target_url)
        except Exception as e:
            raise HTTPException(502, f"Fetch error: {e}")

    content_type = r.headers.get("content-type","")
    if "text/html" in content_type.lower():
        html = rewrite_html(target_url, r.text)
        return HTMLResponse(html, status_code=r.status_code)
    else:
        # For images, JS, CSS: serve directly
        return Response(content=r.content, media_type=content_type)

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
import httpx
from bs4 import BeautifulSoup
from urllib.parse import unquote_plus

app = FastAPI(title="Test Proxy with Base Tag")

FRONTEND_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Test Proxy with Base</title>
</head>
<body style="background:#111;color:#fff;font-family:sans-serif">
<h2>Dark Proxy Test with Base</h2>
<form id="f">
<input type="text" id="url" placeholder="Enter URL (e.g. example.com)" style="width:300px"/>
<button type="submit">Go</button>
</form>
<iframe id="frame" src="" style="width:100%;height:80vh;margin-top:10px;"></iframe>
<script>
const f=document.getElementById('f');
const urlInput=document.getElementById('url');
const frame=document.getElementById('frame');
f.addEventListener('submit', e=>{
  e.preventDefault();
  let u=urlInput.value.trim();
  if(!u) return;
  if(!/^https?:\/\//i.test(u)) u='https://'+u;
  frame.src='/proxy?url='+encodeURIComponent(u);
});
</script>
</body>
</html>
"""

@app.get("/", response_class=HTMLResponse)
async def home():
    return FRONTEND_HTML

@app.get("/proxy")
async def proxy(url: str = None):
    if not url:
        return PlainTextResponse("Missing ?url=...", status_code=400)
    
    target_url = unquote_plus(url)
    async with httpx.AsyncClient(follow_redirects=True, timeout=10) as client:
        try:
            r = await client.get(target_url)
        except Exception as e:
            raise HTTPException(502, f"Fetch error: {e}")

    content_type = r.headers.get("content-type", "")
    # Only modify HTML
    if "text/html" in content_type.lower():
        soup = BeautifulSoup(r.text, "html.parser")
        head = soup.head
        if head:
            base_tag = soup.new_tag("base", href=target_url)
            head.insert(0, base_tag)
        return HTMLResponse(str(soup), status_code=r.status_code)
    else:
        return Response(content=r.content, media_type=content_type)

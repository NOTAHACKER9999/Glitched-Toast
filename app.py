from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import HTMLResponse, PlainTextResponse
import httpx

app = FastAPI(title="Test Proxy App")

FRONTEND_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Test Proxy</title>
</head>
<body style="background:#111;color:#fff;font-family:sans-serif">
<h2>Dark Proxy Test</h2>
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
    async with httpx.AsyncClient(follow_redirects=True, timeout=10) as client:
        try:
            r = await client.get(url)
        except Exception as e:
            raise HTTPException(502, f"Fetch error: {e}")
    content_type = r.headers.get("content-type","")
    return Response(content=r.content, media_type=content_type)

// api/proxy.js - Vercel Serverless function
// This is a small, best-effort HTML proxy that rewrites common attributes
// to keep navigation inside the proxy. It's not perfect for very dynamic apps.

export default async function handler(req, res) {
  const url = (req.query.url || req.query.u || '').toString();
  if(!url){
    res.status(400).send('Missing url param. Use /api/proxy?url=');
    return;
  }

  // Validate scheme
  if(!/^https?:\/\//i.test(url)){
    res.status(400).send('Only http(s) URLs are allowed');
    return;
  }

  try {
    // fetch target
    const upstream = await fetch(url, {
      headers: {
        'user-agent': req.headers['user-agent'] || 'ToastProxy/1.0',
        'accept': req.headers['accept'] || '*/*'
      },
      redirect: 'follow'
    });

    // copy some headers, but strip security ones
    const headers = {};
    upstream.headers.forEach((v,k) => {
      k = k.toLowerCase();
      if(['content-security-policy','x-frame-options','strict-transport-security','x-content-type-options','set-cookie'].includes(k)) return;
      headers[k] = v;
    });

    const contentType = upstream.headers.get('content-type') || '';

    // If not HTML, just stream it through (images, css, js, etc.)
    if(!contentType.includes('text/html')){
      // set appropriate headers
      for(const [k,v] of Object.entries(headers)) res.setHeader(k, v);
      // force allow framing for binary assets
      res.setHeader('access-control-allow-origin', '*');
      const arrayBuffer = await upstream.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return res.status(200).send(buffer);
    }

    // HTML: rewrite links
    let body = await upstream.text();

    // Inject a meta tag for original url so client can read it
    body = body.replace(/<head([^>]*)>/i, `<head$1>\n<meta name="toast-original-url" content="${escapeHtml(url)}">`);

    // Ensure a <base> tag so relative links work — set to the upstream origin
    try {
      const u = new URL(url);
      const originBase = u.origin + '/';
      // insert or replace base
      if(/<base[^>]*>/i.test(body)){
        body = body.replace(/<base[^>]*>/i, `<base href="${originBase}">`);
      } else {
        body = body.replace(/<head([^>]*)>/i, `<head$1>\n<base href="${originBase}">`);
      }
    } catch(e){}

    // helper to rewrite attribute URLs to pass through our proxy
    const rewriteAttr = (html, attr) => {
      // very permissive regex: attr="..."; supports single/double quotes and unquoted
      const re = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'ig');
      return html.replace(re, (m, a, dquote, squote, unq) => {
        const raw = dquote ?? squote ?? unq ?? '';
        if(!raw) return m;
        // if it's a javascript: or data: or mailto:, leave alone
        if(/^(javascript:|data:|mailto:|#)/i.test(raw)) return `${attr}="${raw}"`;
        // absolute or relative will be proxied via our endpoint
        try {
          // convert relative to absolute using the upstream url as base
          const base = url;
          let resolved;
          try {
            resolved = new URL(raw, base).toString();
          } catch(e){ resolved = raw; }
          const prox = `/api/proxy?url=${encodeURIComponent(resolved)}`;
          return `${attr}="${prox}"`;
        } catch(e){
          return `${attr}="${raw}"`;
        }
      });
    };

    // rewrite common attributes
    const attrs = ['href','src','action','data-src','srcset','poster'];
    for(const a of attrs){
      body = rewriteAttr(body, a);
    }

    // rewrite locations in simple inline scripts (window.location = "...", location.href = "...")
    body = body.replace(/(window\.location\.href|location\.href|window\.location)\s*=\s*("([^"]+)"|'([^']+)'|([^;)\n]+))/ig, (m, p1, p2, s2, s3, unq) => {
      const raw = s2 ?? s3 ?? unq ?? '';
      if(!raw) return m;
      if(/^(javascript:|data:|mailto:|#)/i.test(raw)) return m;
      try {
        const resolved = new URL(raw, url).toString();
        return `${p1}='${'/api/proxy?url=' + encodeURIComponent(resolved)}'`;
      } catch(e){
        return m;
      }
    });

    // Remove X-Frame-Options meta tags if existed in HTML
    body = body.replace(/<meta[^>]*http-equiv=["']?x-frame-options["']?[^>]*>/ig, '');

    // final headers
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('access-control-allow-origin', '*');
    // send
    return res.status(200).send(body);

  } catch(err){
    console.error('proxy error', err);
    res.status(502).send('Proxy error: ' + String(err.message));
  }
}

// simple helper
function escapeHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                        }

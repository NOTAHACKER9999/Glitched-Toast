// api/proxy.js
const fetch = require('node-fetch');
const cheerio = require('cheerio');

function decodeBase64Param(u){
  try{
    return decodeURIComponent(Buffer.from(u, 'base64').toString('utf8'));
  }catch(e){
    try { return decodeURIComponent(u); } catch(e2) { return u; }
  }
}

function encodeForProxy(url){
  return '/proxy?u=' + encodeURIComponent(Buffer.from(url).toString('base64'));
}

module.exports = async (req, res) => {
  const u = req.query.u || req.query.url || '';
  if(!u){
    res.status(400).send('Missing url parameter');
    return;
  }
  const target = decodeBase64Param(u);
  if(!/^https?:\/\//i.test(target)) {
    res.status(400).send('Invalid URL');
    return;
  }

  try {
    // forward headers (some minimal forwarding)
    const headers = { 'user-agent': req.headers['user-agent'] || 'ProxyBrowser/1.0' };
    const resp = await fetch(target, { headers, redirect: 'follow' });

    // copy status for non-OK? typically 200
    const contentType = resp.headers.get('content-type') || '';
    // Remove restrictive headers
    res.removeHeader && res.removeHeader('content-security-policy');

    // If HTML, rewrite
    if (contentType.includes('text/html')) {
      const text = await resp.text();
      const $ = cheerio.load(text, { decodeEntities: false });

      // inject marker with original URL so client can read the original URL even if base tag changed
      $('body').prepend(`<div id="__proxied_original" style="display:none">${target}</div>`);

      // rewrite links and resources to route through proxy
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        if(!href) return;
        try{
          const abs = new URL(href, target).toString();
          $(el).attr('href', encodeForProxy(abs));
          $(el).attr('target',''); // keep inside frame
        }catch(e){}
      });

      // rewrite forms
      $('form[action]').each((i, el) => {
        const act = $(el).attr('action');
        try{
          const abs = new URL(act, target).toString();
          $(el).attr('action', encodeForProxy(abs));
        }catch(e){}
      });

      // rewrite src attributes for scripts, imgs, iframes, link rel=stylesheet
      $('[src]').each((i, el) => {
        const src = $(el).attr('src');
        try{
          const abs = new URL(src, target).toString();
          $(el).attr('src', '/proxy?u=' + encodeURIComponent(Buffer.from(abs).toString('base64')));
        }catch(e){}
      });

      $('link[href]').each((i, el) => {
        const href = $(el).attr('href');
        try{
          const abs = new URL(href, target).toString();
          $(el).attr('href', '/proxy?u=' + encodeURIComponent(Buffer.from(abs).toString('base64')));
        }catch(e){}
      });

      // remove or relax CSP & X-Frame-Options headers by clearing them when sending
      res.setHeader('content-type', 'text/html; charset=UTF-8');
      res.setHeader('x-frame-options', 'ALLOWALL');
      // send modified html
      res.status(200).send($.html());
      return;
    } else {
      // Non-HTML: stream bytes through and set same content-type
      const buffer = await resp.buffer();
      const ct = resp.headers.get('content-type') || '';
      res.setHeader('content-type', ct);
      res.setHeader('x-frame-options', 'ALLOWALL');
      // also forward cache headers maybe
      res.status(resp.status).send(buffer);
      return;
    }
  } catch (err) {
    console.error('proxy error', err);
    res.status(500).send('Proxy error: ' + err.toString());
  }
};

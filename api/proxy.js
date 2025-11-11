const fetch = require('node-fetch');
const cheerio = require('cheerio');

// decode base64 with fallback
function decodeBase64Param(u){
  try {
    return decodeURIComponent(Buffer.from(u, 'base64').toString('utf8'));
  } catch(e) {
    try { return decodeURIComponent(u); } catch(e2) { return u; }
  }
}

// encode url for proxy
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
    const headers = { 'user-agent': req.headers['user-agent'] || 'ProxyBrowser/1.0' };
    const resp = await fetch(target, { headers, redirect: 'follow' });

    const contentType = resp.headers.get('content-type') || '';

    // forward headers (mostly intact)
    resp.headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'content-length') res.setHeader(k, v);
    });

    if (contentType.includes('text/html')) {
      const text = await resp.text();
      const $ = cheerio.load(text, { decodeEntities: false });

      // marker for original URL
      $('body').prepend(`<div id="__proxied_original" style="display:none">${target}</div>`);

      // rewrite only <a> links
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        if(!href) return;
        try {
          const abs = new URL(href, target).toString();
          $(el).attr('href', encodeForProxy(abs)).attr('target','');
        } catch(e){}
      });

      // rewrite forms
      $('form[action]').each((i, el) => {
        const act = $(el).attr('action');
        if(!act) return;
        try {
          const abs = new URL(act, target).toString();
          $(el).attr('action', encodeForProxy(abs));
        } catch(e){}
      });

      // inject <base> for relative asset URLs (CSS, JS, images)
      $('head').prepend(`<base href="${target}">`);

      // set headers to allow iframe
      res.setHeader('content-type', 'text/html; charset=UTF-8');
      res.setHeader('x-frame-options', 'ALLOWALL');

      res.status(200).send($.html());
      return;
    } else {
      // non-HTML (images, JS, CSS) → pass through as-is
      const buffer = await resp.buffer();
      const ct = resp.headers.get('content-type') || '';
      res.setHeader('content-type', ct);
      res.setHeader('x-frame-options', 'ALLOWALL');
      res.status(resp.status).send(buffer);
      return;
    }

  } catch (err) {
    console.error('proxy error', err);
    res.status(500).send('Proxy error: ' + err.toString());
  }
};

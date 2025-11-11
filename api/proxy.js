const fetch = require('node-fetch');
const cheerio = require('cheerio');

function decodeBase64Param(u){
  try { return Buffer.from(u, 'base64').toString('utf8'); } 
  catch { return u; }
}
function encodeForProxy(url){
  return '/proxy?u=' + encodeURIComponent(Buffer.from(url).toString('base64'));
}

// Helper to rewrite HTML links and forms only
function rewriteLinksAndForms($, target) {
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if(!href) return;
    try { $(el).attr('href', encodeForProxy(new URL(href, target).toString())).attr('target',''); } catch {}
  });
  $('form[action]').each((i, el) => {
    const act = $(el).attr('action');
    if(!act) return;
    try { $(el).attr('action', encodeForProxy(new URL(act, target).toString())); } catch {}
  });
}

module.exports = async (req, res) => {
  const u = req.query.u || req.query.url || '';
  if(!u) return res.status(400).send('Missing url parameter');

  const target = decodeBase64Param(u);
  if(!/^https?:\/\//i.test(target)) return res.status(400).send('Invalid URL');

  try {
    const headers = { 'user-agent': req.headers['user-agent'] || 'MegaProxy/1.0' };
    const resp = await fetch(target, { headers, redirect: 'follow' });

    const contentType = resp.headers.get('content-type') || '';

    // Forward headers except content-length (let Vercel handle it)
    resp.headers.forEach((v, k) => { if(k.toLowerCase()!=='content-length') res.setHeader(k, v); });

    if(contentType.includes('text/html')) {
      const text = await resp.text();
      const $ = cheerio.load(text, { decodeEntities: false });

      // Inject <base> so relative assets load correctly
      $('head').prepend(`<base href="${target}">`);

      // Marker for frontend to get original URL
      $('body').prepend(`<div id="__proxied_original" style="display:none">${target}</div>`);

      // Rewrite only links and forms (leave scripts/images untouched)
      rewriteLinksAndForms($, target);

      // Inject mega-proxy JS to intercept AJAX/fetch requests
      $('body').append(`
<script>
(function(){
  const origFetch = window.fetch;
  window.fetch = function(input, init){
    let url = typeof input === 'string' ? input : input.url;
    if(url && !url.startsWith('/proxy')) {
      const enc = btoa(url);
      if(typeof input === 'string') input = '/proxy?u=' + encodeURIComponent(enc);
      else input.url = '/proxy?u=' + encodeURIComponent(enc);
    }
    return origFetch(input, init);
  };
})();
</script>
      `);

      res.setHeader('content-type', 'text/html; charset=UTF-8');
      res.setHeader('x-frame-options', 'ALLOWALL');
      res.status(200).send($.html());
      return;
    } else {
      // Non-HTML (images, JS, CSS, etc.) → pass through untouched
      const buffer = await resp.buffer();
      res.setHeader('content-type', contentType);
      res.setHeader('x-frame-options', 'ALLOWALL');
      res.status(resp.status).send(buffer);
      return;
    }

  } catch(err) {
    console.error('Mega Proxy Error:', err);
    res.status(500).send('Mega Proxy Error: ' + err.message);
  }
};

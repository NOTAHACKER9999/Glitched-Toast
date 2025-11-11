const fetch = require('node-fetch');
const cheerio = require('cheerio');

function decodeBase64Param(u) {
  try { return Buffer.from(u, 'base64').toString('utf8'); }
  catch { return u; }
}

function encodeForProxy(url) {
  return '/proxy?u=' + encodeURIComponent(Buffer.from(url).toString('base64'));
}

module.exports = async (req, res) => {
  const u = req.query.u || '';
  if (!u) return res.status(400).send('Missing url parameter');

  const target = decodeBase64Param(u);
  if (!/^https?:\/\//i.test(target)) return res.status(400).send('Invalid URL');

  try {
    const headers = { 'user-agent': req.headers['user-agent'] || 'ProxyBrowser/1.0' };
    const resp = await fetch(target, { headers, redirect: 'follow' });
    const contentType = resp.headers.get('content-type') || '';

    // Forward headers (except content-length)
    resp.headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'content-length') res.setHeader(k, v);
    });

    if (contentType.includes('text/html')) {
      const html = await resp.text();
      const $ = cheerio.load(html, { decodeEntities: false });

      // Rewrite only links and forms
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        try {
          const abs = new URL(href, target).toString();
          $(el).attr('href', encodeForProxy(abs)).attr('target', '');
        } catch {}
      });

      $('form[action]').each((i, el) => {
        const act = $(el).attr('action');
        if (!act) return;
        try {
          const abs = new URL(act, target).toString();
          $(el).attr('action', encodeForProxy(abs));
        } catch {}
      });

      // Inject <base> so relative asset paths still work
      $('head').prepend(`<base href="${target}">`);

      // Keep HTML otherwise unchanged
      res.setHeader('content-type', 'text/html; charset=UTF-8');
      res.setHeader('x-frame-options', 'ALLOWALL');

      return res.status(200).send($.html());
    } else {
      // Non-HTML content: forward unchanged
      const buffer = await resp.buffer();
      res.setHeader('content-type', contentType);
      res.setHeader('x-frame-options', 'ALLOWALL');
      return res.status(resp.status).send(buffer);
    }

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).send('Proxy error: ' + err.toString());
  }
};

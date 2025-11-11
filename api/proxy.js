const fetch = require('node-fetch');
const { URL } = require('url');

function decodeBase64Param(u) {
  try { return Buffer.from(u, 'base64').toString('utf8'); }
  catch { return u; }
}

module.exports = async (req, res) => {
  const u = req.query.u || req.query.url || '';
  if (!u) return res.status(400).send('Missing url parameter');

  const target = decodeBase64Param(u);
  if (!/^https?:\/\//i.test(target)) return res.status(400).send('Invalid URL');

  try {
    // Build full target URL including path + query
    const urlObj = new URL(target);

    // Forward request headers, but remove host to prevent conflicts
    const headers = { ...req.headers };
    delete headers.host;

    // Forward method and body if POST
    const options = {
      method: req.method,
      headers,
      redirect: 'manual',
      body: req.method === 'POST' || req.method === 'PUT' ? req : undefined,
    };

    const resp = await fetch(urlObj.toString(), options);

    // Copy status code
    res.status(resp.status);

    // Copy headers (except content-length, to avoid errors)
    resp.headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'content-length') res.setHeader(k, v);
    });

    // Force iframe load
    res.setHeader('x-frame-options', 'ALLOWALL');

    // Stream response back
    const buffer = await resp.buffer();
    res.send(buffer);

  } catch (err) {
    console.error('Reverse proxy error:', err);
    res.status(500).send('Reverse proxy error: ' + err.message);
  }
};

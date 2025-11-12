import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('text/html')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('content-type', contentType);
      return res.send(buffer);
    }

    let html = await response.text();

    // Rewrite all relative links to go through the proxy
    html = html.replace(/(href|src)=["'](?!https?:\/\/)([^"']+)["']/gi,
      `$1="${proxyBase}${encodeURIComponent(url + '$2')}"`);

    // Optional: meta tag to show original URL
    html = html.replace(/<head>/i, `<head><meta name="toast-original-url" content="${url}">`);

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    return res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Proxy error: ' + e.message);
  }
}

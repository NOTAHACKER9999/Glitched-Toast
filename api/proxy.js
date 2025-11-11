const { chromium } = require('@playwright/test');

module.exports = async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing ?url=');

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(target, { waitUntil: 'networkidle' });

    // Inject dark mode styles
    await page.addStyleTag({
      content: `
        html, body { background:#0b0d0f!important; color:#e6eef8!important; }
        a { color:#8ab4ff!important; }`
    });

    const html = await page.content();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    console.error('Toast proxy error:', err);
    res.status(500).send('Toast proxy error: ' + err.message);
  } finally {
    if (browser) await browser.close();
  }
};

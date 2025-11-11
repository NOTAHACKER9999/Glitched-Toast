const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing ?url=');

  let browser;
  try {
    // try several known executable paths
    let executablePath = await chromium.executablePath;
    if (!executablePath) {
      executablePath = chromium.path || '/usr/bin/google-chrome';
    }

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: chromium.headless !== false,
      ignoreHTTPSErrors: true
    });

    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

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

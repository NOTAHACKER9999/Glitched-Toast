const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing ?url=');

  let browser = null;
  try {
    // Get the executable path provided by chrome-aws-lambda
    const executablePath = await chromium.executablePath;

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: executablePath || '/usr/bin/google-chrome',
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    await page.addStyleTag({
      content: `
        html, body { background: #0b0d0f !important; color: #e6eef8 !important; }
        a { color: #8ab4ff !important; }
      `,
    });

    const html = await page.content();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    console.error('Proxy Error:', err);
    res.status(500).send('Proxy Error: ' + err.message);
  } finally {
    if (browser) await browser.close();
  }
};

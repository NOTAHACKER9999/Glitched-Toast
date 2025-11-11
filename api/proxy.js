const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');
const express = require('express');

const app = express();

app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).send('Missing ?url=');
  }
  try {
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true
    });
    const page = await browser.newPage();
    await page.goto(target, { waitUntil: 'networkidle0', timeout: 30000 });
    // Optionally inject dark mode CSS
    await page.addStyleTag({
      content: `
        html, body { background:#0b0d0f !important; color:#e6eef8 !important; }
        a { color:#8ab4ff !important; }
      `
    });
    const html = await page.content();
    await browser.close();
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).send(`Proxy error: ${err.toString()}`);
  }
});

module.exports = app;

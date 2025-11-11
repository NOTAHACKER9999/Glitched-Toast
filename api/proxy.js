// api/proxy.js
const fetch = require("node-fetch");
const cheerio = require("cheerio");

module.exports = async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");

  try {
    const response = await fetch(target);
    const html = await response.text();
    const $ = cheerio.load(html);

    // rewrite all <a href> and <form action> to stay in proxy
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (href && !href.startsWith("javascript:") && !href.startsWith("#")) {
        const absolute = new URL(href, target).toString();
        $(el).attr("href", `/proxy?url=${encodeURIComponent(absolute)}`);
      }
    });
    $("form[action]").each((_, el) => {
      const action = $(el).attr("action");
      const absolute = new URL(action, target).toString();
      $(el).attr("action", `/proxy?url=${encodeURIComponent(absolute)}`);
    });

    // dark-mode injection
    $("head").append(`
      <style>
        html,body{background:#0b0d0f!important;color:#e6eef8!important;}
        a{color:#8ab4ff!important;}
      </style>
    `);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send($.html());
  } catch (err) {
    console.error("Toast proxy error:", err);
    res.status(500).send("Toast proxy error: " + err.message);
  }
};

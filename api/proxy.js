// Use the built-in global fetch (available in Node 18+)
const cheerio = require("cheerio");

module.exports = async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) {
      res.status(400).send("Missing ?url=");
      return;
    }

    const response = await fetch(target);
    const html = await response.text();
    const $ = cheerio.load(html);

    // Rewrite <a href> and <form action> links
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (href && !href.startsWith("javascript:") && !href.startsWith("#")) {
        const absolute = new URL(href, target).toString();
        $(el).attr("href", `/proxy?url=${encodeURIComponent(absolute)}`);
      }
    });
    $("form[action]").each((_, el) => {
      const action = $(el).attr("action");
      if (action) {
        const absolute = new URL(action, target).toString();
        $(el).attr("action", `/proxy?url=${encodeURIComponent(absolute)}`);
      }
    });

    // Inject dark-mode style
    $("head").append(`
      <style>
        html,body{background:#0b0d0f!important;color:#e6eef8!important;}
        a{color:#8ab4ff!important;}
      </style>
    `);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send($.html());
  } catch (err) {
    console.error("Toast proxy error:", err);
    res.status(500).send("Toast proxy error: " + err.message);
  }
};

const fetch = require("node-fetch");
const cheerio = require("cheerio");

function decodeParam(u) {
  try { return Buffer.from(u, "base64").toString("utf8"); }
  catch { return u; }
}

function encode(u) { return encodeURIComponent(Buffer.from(u).toString("base64")); }

function proxify(url) { return "/proxy?u=" + encode(url); }

module.exports = async (req, res) => {
  const q = req.query.u;
  if (!q) return res.status(400).send("Missing ?u=");
  const target = decodeParam(q);

  try {
    const r = await fetch(target, {
      headers: { "user-agent": req.headers["user-agent"] || "ProxyBrowser/1.0" },
      redirect: "follow"
    });

    const type = r.headers.get("content-type") || "";

    // Forward all headers from the original response
    r.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "content-length") res.setHeader(k, v);
    });

    if (type.includes("text/html")) {
      let html = await r.text();
      const $ = cheerio.load(html, { decodeEntities: false });

      // Only rewrite <a> links and <form> actions
      $("a[href]").each((_, el) => {
        try {
          const abs = new URL($(el).attr("href"), target).toString();
          $(el).attr("href", proxify(abs)).attr("target", "");
        } catch {}
      });

      $("form[action]").each((_, el) => {
        try {
          const abs = new URL($(el).attr("action"), target).toString();
          $(el).attr("action", proxify(abs));
        } catch {}
      });

      // Inject <base> for relative assets (images, scripts, CSS)
      $("head").prepend(`<base href="${target}">`);

      // Hidden div to tell frontend the original URL
      $("body").prepend(`<div id="__proxied_original" style="display:none">${target}</div>`);

      // Allow iframe
      res.setHeader("x-frame-options", "ALLOWALL");
      res.send($.html());
    } else {
      // Non-HTML: stream directly (images, JS, CSS, etc.)
      const buf = await r.buffer();
      res.send(buf);
    }

  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Proxy error: " + err.message);
  }
};

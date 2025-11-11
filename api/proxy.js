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

    // Forward all original headers except content-length (let Vercel handle it)
    r.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "content-length") res.setHeader(k, v);
    });

    if (type.includes("text/html")) {
      let html = await r.text();
      const $ = cheerio.load(html, { decodeEntities: false });

      // Only rewrite <a> and <form> links — leave scripts, images, CSS alone
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

      // Inject <base> so relative asset URLs work
      $("head").prepend(`<base href="${target}">`);

      // Inject hidden div for frontend to know original URL
      $("body").prepend(`<div id="__proxied_original" style="display:none">${target}</div>`);

      res.setHeader("x-frame-options", "ALLOWALL");
      res.send($.html());
    } else {
      // For non-HTML (images, CSS, JS) just pipe the original content
      const buf = await r.buffer();
      res.send(buf);
    }
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Proxy error: " + err.message);
  }
};

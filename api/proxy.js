// api/proxy.js
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
    const r = await fetch(target, { headers: { "user-agent": req.headers["user-agent"] || "ProxyBrowser/1.0" } });
    const type = r.headers.get("content-type") || "";

    if (type.includes("text/html")) {
      let html = await r.text();
      const $ = cheerio.load(html, { decodeEntities: false });

      // Inject hidden original URL for the frontend
      $("body").prepend(`<div id="__proxied_original" style="display:none">${target}</div>`);

      // Set <base> so relative links resolve correctly
      $("head").prepend(`<base href="${target}">`);

      // Rewrite links
      $("a[href]").each((_, el) => {
        try { const abs = new URL($(el).attr("href"), target).toString(); $(el).attr("href", proxify(abs)).attr("target", ""); } catch {}
      });

      // Rewrite forms
      $("form[action]").each((_, el) => {
        try { const abs = new URL($(el).attr("action"), target).toString(); $(el).attr("action", proxify(abs)); } catch {}
      });

      // Rewrite src attributes
      $("[src]").each((_, el) => {
        try { const abs = new URL($(el).attr("src"), target).toString(); $(el).attr("src", proxify(abs)); } catch {}
      });

      // Rewrite link[href] (stylesheets, etc.)
      $("link[href]").each((_, el) => {
        try { const abs = new URL($(el).attr("href"), target).toString(); $(el).attr("href", proxify(abs)); } catch {}
      });

      // Remove blocking headers
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("x-frame-options", "ALLOWALL");

      res.send($.html());
    } else {
      // Non-HTML: stream bytes directly
      const buffer = await r.buffer();
      res.setHeader("content-type", type);
      res.setHeader("x-frame-options", "ALLOWALL");
      res.send(buffer);
    }
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Proxy error: " + err.message);
  }
};

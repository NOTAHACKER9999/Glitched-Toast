// api/proxy.js
const fetch = require("node-fetch");
const cheerio = require("cheerio");

function decodeParam(u) {
  try {
    return decodeURIComponent(Buffer.from(u, "base64").toString("utf8"));
  } catch {
    return u;
  }
}
function encode(u) {
  return encodeURIComponent(Buffer.from(u).toString("base64"));
}
function proxify(url) {
  return `/proxy?u=${encode(url)}`;
}

module.exports = async (req, res) => {
  const q = req.query.u;
  if (!q) return res.status(400).send("Missing ?u=");
  const target = decodeParam(q);

  try {
    const r = await fetch(target, {
      headers: { "user-agent": req.headers["user-agent"] || "GlitchBrowser/1.0" },
    });
    const type = r.headers.get("content-type") || "";
    if (type.includes("text/html")) {
      let html = await r.text();
      const $ = cheerio.load(html, { decodeEntities: false });

      $("a[href]").each((_, el) => {
        const abs = new URL($(el).attr("href"), target).toString();
        $(el).attr("href", proxify(abs)).attr("target", "");
      });
      $("form[action]").each((_, el) => {
        const abs = new URL($(el).attr("action"), target).toString();
        $(el).attr("action", proxify(abs));
      });
      $("[src]").each((_, el) => {
        const abs = new URL($(el).attr("src"), target).toString();
        $(el).attr("src", proxify(abs));
      });
      $("link[href]").each((_, el) => {
        const abs = new URL($(el).attr("href"), target).toString();
        $(el).attr("href", proxify(abs));
      });

      $("head").prepend(`<base href="${target}">`);
      $("body").prepend(`<div id="__proxied_original" style="display:none">${target}</div>`);

      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("x-frame-options", "ALLOWALL");
      res.send($.html());
    } else {
      const buf = await r.buffer();
      res.setHeader("content-type", type);
      res.setHeader("x-frame-options", "ALLOWALL");
      res.send(buf);
    }
  } catch (err) {
    res.status(500).send("Proxy error: " + err);
  }
};

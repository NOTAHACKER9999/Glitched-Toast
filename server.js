// server.js
import express from "express";
import fetch from "node-fetch";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import LRU from "lru-cache";
import dotenv from "dotenv";
import { URL } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Simple LRU cache for GET responses (keyed by proxied URL)
const cache = new LRU({
  max: 500,
  ttl: parseInt(process.env.CACHE_TTL_MS || "300000"), // ms
});

// Security middlewares
app.use(helmet({
  // Keep default helmet settings; we will tweak some headers for proxy responses
}));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiter
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
  max: parseInt(process.env.RATE_LIMIT_MAX || "60"),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Helper: block local/private IPs and invalid input
function isPrivateIp(hostname) {
  // Basic check: disallow raw IPs for private ranges and localhost
  // We intentionally keep this conservative — avoid proxying internal networks.
  if (!hostname) return true;
  if (/^(localhost|127\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(hostname)) return true;
  return false;
}

function isAllowedHost(hostname) {
  const allowEnv = process.env.ALLOWLIST_HOSTS;
  if (!allowEnv) return true; // allow all by default
  const allowed = allowEnv.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.some(a => hostname.endsWith(a));
}

// Utility: rewrite HTML so that links/resources go through our /proxy route
function rewriteHtml(body, baseUrl, proxyPrefix = "/proxy?url=") {
  // This is a best-effort simple rewrite using regex. For robust handling, use an HTML parser (cheerio/jsdom).
  const absolute = (u) => {
    try {
      return new URL(u, baseUrl).toString();
    } catch (e) { return u; }
  };

  // Replace src/href attributes that look like resources or links
  // Note: regex-based HTML rewriting is brittle but works for many sites.
  body = body.replace(
    /<(a|link|script|img|iframe|source|video|audio|form)\b[^>]*(?:href|src|action)=["']?([^"'\s>]+)["']?[^>]*>/gi,
    (m, tag, url) => {
      if (!url) return m;
      // skip data: and javascript: and mailto:
      if (/^(data:|javascript:|mailto:|#)/i.test(url)) return m;
      const abs = absolute(url);
      const proxied = proxyPrefix + encodeURIComponent(abs);
      // replace the URL within the match
      return m.replace(url, proxied);
    }
  );

  // Also replace bare CSS url(...) references
  body = body.replace(/url\((['"]?)([^'")]+)(['"]?)\)/gi, (m, q1, url) => {
    if (/^(data:|https?:|\/\/)/i.test(url) === false) {
      url = new URL(url, baseUrl).toString();
    } else if (url.startsWith("//")) {
      url = "https:" + url;
    }
    const proxied = `url(${q1}${proxyPrefix}${encodeURIComponent(url)}${q1})`;
    return proxied;
  });

  return body;
}

// Main proxy handler
app.all("/proxy", async (req, res) => {
  const target = req.query.url || req.body.url;
  if (!target) return res.status(400).send("Missing 'url' query param.");

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (err) {
    return res.status(400).send("Invalid URL.");
  }

  // Prevent proxied requests to private IPs / localhost
  const host = targetUrl.hostname;
  if (isPrivateIp(host) || !isAllowedHost(host)) {
    return res.status(403).send("Access to that host is forbidden.");
  }

  // Only cache GET
  const cacheKey = `${req.method}:${targetUrl.toString()}`;
  if (req.method === "GET" && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    // Serve cached object (includes status, headers, body)
    res.status(cached.status);
    for (const [k, v] of Object.entries(cached.headers || {})) {
      // do not forward some hop-by-hop headers
      if (["content-encoding", "transfer-encoding", "connection"].includes(k.toLowerCase())) continue;
      res.set(k, v);
    }
    return res.send(cached.body);
  }

  // Build fetch options: forward select headers
  const headers = {};
  // Only forward a safe subset of headers from the client to the upstream
  const allowedForward = ["accept", "accept-language", "user-agent", "cookie", "range"];
  for (const h of allowedForward) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }

  // If the client sent a body (POST, PUT), forward it
  const fetchOptions = {
    method: req.method,
    headers,
    redirect: "manual",
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : undefined
  };

  try {
    const upstream = await fetch(targetUrl.toString(), fetchOptions);

    // Copy status and headers to response (with some modifications for safety)
    res.status(upstream.status);

    // Copy headers, but strip/alter security headers that would break proxied use
    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      // Do not forward CSP / frame-ancestors / set-cookie (we handle cookies carefully) / strict-transport-security
      if (["content-security-policy", "x-frame-options", "frame-options", "strict-transport-security"].includes(lower)) return;
      // Allow CORS from anywhere if you want (you can restrict)
      if (lower === "access-control-allow-origin") return;
      res.set(name, value);
    });

    // Make adjustments: remove CSP so in-iframe loads work; set referrer-policy if desired
    res.set("Referrer-Policy", "no-referrer-when-downgrade");

    // Stream or buffer response
    const contentType = upstream.headers.get("content-type") || "";

    // If it's HTML, rewrite
    if (contentType.includes("text/html")) {
      const text = await upstream.text();
      const rewritten = rewriteHtml(text, targetUrl.toString(), "/proxy?url=");
      // Optional: remove or adjust <base> tags so relative URLs still go through proxy
      // Cache
      if (req.method === "GET") {
        cache.set(cacheKey, {
          status: upstream.status,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: rewritten
        });
      }
      res.set("Content-Type", "text/html; charset=utf-8");
      return res.send(rewritten);
    }

    // For other text types (CSS, JS), we might rewrite url() inside CSS; handle common types:
    if (contentType.includes("text/css")) {
      const text = await upstream.text();
      const rewritten = rewriteHtml(text, targetUrl.toString(), "/proxy?url=");
      if (req.method === "GET") {
        cache.set(cacheKey, {
          status: upstream.status,
          headers: { "content-type": contentType },
          body: rewritten
        });
      }
      res.set("Content-Type", contentType);
      return res.send(rewritten);
    }

    // For images, video, binary: stream directly
    // For streaming, pipe the upstream body
    res.set("Content-Type", contentType);
    // Stream buffer into response
    const buffer = await upstream.arrayBuffer();
    const b = Buffer.from(buffer);
    if (req.method === "GET") {
      cache.set(cacheKey, {
        status: upstream.status,
        headers: { "content-type": contentType },
        body: b
      });
    }
    return res.send(b);

  } catch (err) {
    console.error("Proxy fetch error:", err);
    return res.status(502).send("Bad Gateway: error fetching target.");
  }
});

// Minimal front-end: serve index.html
app.get("/", (req, res) => {
  res.sendFile(new URL("./index.html", import.meta.url));
});

// health check
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Proxy browser listening on port ${PORT}`);
});

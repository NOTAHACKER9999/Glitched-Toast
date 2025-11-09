'use strict';

// Import the Ultraviolet bundle first so self.Ultraviolet is defined
if (!self.__uv && self.importScripts) {
  importScripts('/uv/uv.bundle.js'); // make sure this path matches your setup
}

const uvHeadersToRemove = [
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "content-security-policy",
  "content-security-policy-report-only",
  "expect-ct",
  "feature-policy",
  "origin-isolation",
  "strict-transport-security",
  "upgrade-insecure-requests",
  "x-content-type-options",
  "x-download-options",
  "x-frame-options",
  "x-permitted-cross-domain-policies",
  "x-powered-by",
  "x-xss-protection"
];

const simpleMethods = ["GET","HEAD"];

class UVServiceWorker extends self.Ultraviolet.EventEmitter {
  constructor(config = self.__uv$config) {
    super();
    config.bare = config.bare || '/bare/';
    config.prefix = config.prefix || '/service/';
    this.config = config;

    const addresses = (Array.isArray(config.bare) ? config.bare : [config.bare])
      .map(url => new URL(url, location).toString());
    this.address = addresses[Math.floor(Math.random() * addresses.length)];
    this.bareClient = new self.Ultraviolet.BareClient(this.address);
  }

  async fetch({ request }) {
    try {
      if (!request.url.startsWith(location.origin + this.config.prefix)) {
        return await fetch(request);
      }

      const uv = new self.Ultraviolet(this.config, this.address);
      if (typeof this.config.construct === "function") this.config.construct(uv, "service");

      const cookieDB = await uv.cookie.db();
      uv.meta.origin = location.origin;
      uv.meta.base = uv.meta.url = new URL(uv.sourceUrl(request.url));

      let body = null;
      if (!simpleMethods.includes(request.method.toUpperCase())) {
        body = await request.blob();
      }

      const wrappedRequest = new UVRequest(request, uv, this, body);

      // Call the Bare server
      const targetUrl = wrappedRequest.blob ? "blob:" + location.origin + wrappedRequest.url.pathname : wrappedRequest.url;
      const response = await this.bareClient.fetch(targetUrl, {
        headers: wrappedRequest.headers,
        method: wrappedRequest.method,
        body: wrappedRequest.body,
        credentials: wrappedRequest.credentials,
        mode: location.origin !== wrappedRequest.address.origin ? "cors" : wrappedRequest.mode,
        cache: wrappedRequest.cache,
        redirect: wrappedRequest.redirect
      });

      const uvResponse = new UVResponse(wrappedRequest, response);

      // Remove sensitive headers
      for (const h of uvHeadersToRemove) {
        if (uvResponse.headers[h]) delete uvResponse.headers[h];
      }

      return new Response(uvResponse.body, {
        headers: uvResponse.headers,
        status: uvResponse.status,
        statusText: uvResponse.statusText
      });

    } catch (err) {
      console.error(err);
      return new Response("Ultraviolet Service Worker error", { status: 500 });
    }
  }
}

self.UVServiceWorker = UVServiceWorker;

// --- Minimal helper classes (UVRequest/UVResponse) ---
class UVResponse {
  constructor(request, raw) {
    this.request = request;
    this.raw = raw;
    this.ultraviolet = request.ultraviolet;
    this.headers = {};
    for (const key in raw.rawHeaders) {
      this.headers[key.toLowerCase()] = raw.rawHeaders[key];
    }
    this.status = raw.status;
    this.statusText = raw.statusText;
    this.body = raw.body;
  }
}

class UVRequest {
  constructor(request, ultraviolet, sw, blobBody = null) {
    this.ultraviolet = ultraviolet;
    this.request = request;
    this.headers = Object.fromEntries(request.headers.entries());
    this.method = request.method;
    this.address = ultraviolet.address;
    this.body = blobBody;
    this.cache = request.cache;
    this.redirect = request.redirect;
    this.credentials = "omit";
    this.mode = request.mode === "cors" ? "cors" : "same-origin";
    this.blob = false;
  }

  get url() { return this.ultraviolet.meta.url; }
  set url(u) { this.ultraviolet.meta.url = u; }

  get base() { return this.ultraviolet.meta.base; }
  set base(b) { this.ultraviolet.meta.base = b; }
        }

import express from "express";
import { createBareServer } from "@tomphttp/bare-server-node";
import { join } from "path";
import { fileURLToPath } from "url";
import http from "http";

const __dirname = join(fileURLToPath(import.meta.url), "..");

const app = express();
// Create Bare server and map it to /service/
const bare = createBareServer("/service/");
const server = http.createServer();

app.use(express.static(join(__dirname))); // Serve index.html + uv/ + assets

server.on("request", (req, res) => {
  if (bare.shouldRoute(req)) {
    bare.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

server.on("upgrade", (req, socket, head) => {
  if (bare.shouldRoute(req)) {
    bare.routeUpgrade(req, socket, head);
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🌌 Glitch Gate running on port ${PORT}`);
  console.log(`🧩 Bare server active at /service/`);
});
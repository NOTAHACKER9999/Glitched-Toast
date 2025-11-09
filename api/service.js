import { createBareServer } from '@tomphttp/bare-server-node';
import http from 'http';

const bare = createBareServer('/service/');

export default function handler(req, res) {
  // Use the Bare server to handle requests
  const server = http.createServer((req2, res2) => {
    if (bare.shouldRoute(req2)) {
      bare.routeRequest(req2, res2);
    } else {
      res2.statusCode = 404;
      res2.end('Not Found');
    }
  });

  server.emit('request', req, res);
    }

import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";
import { initializeWhatsApp, setSocketServer } from "./lib/whatsapp";
import { startNotificationWorker, sweepOverdueValidations } from "./lib/travel/notifications";
import { handleUploadsRequest, routeUploadsRequest } from "./lib/uploads";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handler = app.getRequestHandler();

app.prepare().then(async () => {
  const httpServer = createServer((req, res) => {
    // Media under public/uploads/ is no longer served by Next's static file
    // handler: /uploads/* requires an authenticated, active inbox-role user
    // (lib/uploads.ts). routeUploadsRequest decodes + normalizes the pathname
    // before matching, so encoded spellings of /uploads cannot fall through
    // to Next's decoded public/ lookup and bypass the session gate.
    let pathname: string | null = null;
    try {
      pathname = req.url ? new URL(req.url, "http://localhost").pathname : null;
    } catch {
      pathname = null; // unparseable URL — let the Next handler deal with it
    }
    if (pathname) {
      const route = routeUploadsRequest(req.method ?? "", pathname);
      if (route.kind === "handle") {
        handleUploadsRequest(req, res, pathname).catch((err) => {
          console.error("[Uploads] media request error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal error" }));
          } else {
            res.destroy();
          }
        });
        return;
      }
      if (route.kind === "bad-request") {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "private, no-store" });
        res.end(JSON.stringify({ error: "Bad request" }));
        return;
      }
      if (route.kind === "method-not-allowed") {
        res.writeHead(405, {
          "Content-Type": "application/json",
          Allow: "GET, HEAD",
          "Cache-Control": "private, no-store",
        });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
    }
    handler(req, res);
  });
  const io = new Server(httpServer, {
    path: "/api/socket",
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  setSocketServer(io);

  setTimeout(() => {
    initializeWhatsApp().catch((err) => {
      console.error("[WhatsApp] initialization error:", err);
    });
  }, 2000);

  // Travel module: async delivery of queued workflow notifications (email +
  // WhatsApp). DB-backed outbox, so the Next.js bundle and this server share
  // state through SQLite, not process memory.
  startNotificationWorker();
  setInterval(() => {
    sweepOverdueValidations().catch((err) => {
      console.error("[Travel] overdue sweep error:", err);
    });
  }, 60 * 60 * 1000);

  httpServer
    .once("error", (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, hostname, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
    });
});

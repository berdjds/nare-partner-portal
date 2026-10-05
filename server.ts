import "next/dist/server/node-environment-baseline";
import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";
import { initializeWhatsAppAccounts, setSocketServer } from "./lib/whatsapp";
import { socketAllowRequest } from "./lib/socket-auth";
import { startNotificationWorker, sweepOverdueValidations } from "./lib/travel/notifications";
import { handleUploadsRequest, routeUploadsRequest } from "./lib/uploads";
import { resolveServerRuntime } from "./lib/server-mode";
import { checkEnvironment } from "./lib/env-check";

// W7a start-up check: refuse to boot a production deployment with a missing,
// placeholder or trivially short session secret. Runs before anything
// listens; the log line must never print the secret value.
const envCheck = checkEnvironment();
for (const warning of envCheck.warnings) {
  console.warn(`[Env] warning: ${warning}`);
}
if (envCheck.fatal.length > 0) {
  console.error(`[Env] fatal: ${envCheck.fatal.join("; ")}`);
  process.exit(1);
}

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
    // Origin gate for every transport/handshake (engine.io allowRequest):
    // only the exact origin of NEXTAUTH_URL (+ SOCKET_ALLOWED_ORIGINS) is
    // accepted — no CORS `*`, no /api/socket response headers. Session
    // authentication, rooms and revalidation are wired by setSocketServer()
    // via lib/socket-auth.ts.
    allowRequest: socketAllowRequest,
  });

  setSocketServer(io);

  // Deploy gate (scripts/vps-deploy.sh): WACONTROL_MODE=trial serves HTTP only
  // — no WhatsApp client, no notification worker, no overdue sweep — so a
  // candidate build can run against a copy of production data. HTTP, sockets
  // and the media gate above stay live; that is what the trial health check
  // verifies. WACONTROL_NOTIFICATIONS_PAUSED=1 stops only the worker.
  const runtime = resolveServerRuntime();

  // W3 (wa-multi): boots every ENABLED account (Marhaba plus any account
  // the owner enabled); each has its own client and a failure in one
  // never affects the others.
  if (runtime.whatsapp) {
    setTimeout(() => {
      initializeWhatsAppAccounts().catch((err) => {
        console.error("[WhatsApp] initialization error:", err);
      });
    }, 2000);
  } else {
    console.log("[Server] trial mode: WhatsApp client not started");
  }

  // Travel module: async delivery of queued workflow notifications (email +
  // WhatsApp). DB-backed outbox, so the Next.js bundle and this server share
  // state through SQLite, not process memory.
  if (runtime.notificationWorker) {
    startNotificationWorker();
  } else if (runtime.notificationsPaused) {
    console.log("[Server] notifications paused: outbox worker not started");
  }

  if (runtime.overdueSweep) {
    setInterval(() => {
      sweepOverdueValidations().catch((err) => {
        console.error("[Travel] overdue sweep error:", err);
      });
    }, 60 * 60 * 1000);
  }

  httpServer
    .once("error", (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, hostname, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
    });
});

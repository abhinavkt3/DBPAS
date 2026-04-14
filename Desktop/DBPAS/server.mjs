import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DBPASService } from "./src/dbpas-service.mjs";
import { normalizeGps } from "./src/utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const dataFile = path.join(__dirname, "data", "ledger.json");
const port = Number(process.env.PORT ?? 3003);
const host = process.env.HOST ?? "127.0.0.1";
const isPortExplicitlySet = Boolean(process.env.PORT);

const service = new DBPASService({
  dbFile: dataFile,
  secret: process.env.DBPAS_HMAC_SECRET ?? "dbpas-secure-local-runtime"
});

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, {
      error: error.message ?? "Unexpected server error."
    });
  }
});

startServer(port);

function startServer(targetPort, hasRetried = false) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && !isPortExplicitlySet && !hasRetried) {
      const fallbackPort = targetPort + 1;
      console.warn(
        `Port ${targetPort} is already in use. Retrying DBPAS on http://${host}:${fallbackPort}`
      );
      startServer(fallbackPort, true);
      return;
    }

    throw error;
  });

  server.listen(targetPort, host, () => {
    console.log(`DBPAS app running at http://${host}:${targetPort}`);
  });
}

async function handleApi(request, response, url) {
  const { method } = request;
  const token = getBearerToken(request);
  const productMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
  const productActionMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/([^/]+)$/);
  const accountActionMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/([^/]+)$/);

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(response, 200, service.getPublicBootstrap());
    return;
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody(request);
    sendJson(response, 200, service.login(body));
    return;
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    sendJson(response, 200, service.logout(token));
    return;
  }

  if (method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(response, 200, service.getDashboard(token));
    return;
  }

  if (method === "POST" && url.pathname === "/api/accounts") {
    const body = await readJsonBody(request);
    sendJson(response, 201, service.createAccount(token, body));
    return;
  }

  if (method === "POST" && accountActionMatch && accountActionMatch[2] === "status") {
    const accountId = decodeURIComponent(accountActionMatch[1]);
    const body = await readJsonBody(request);
    sendJson(response, 200, service.updateAccountStatus(token, accountId, body));
    return;
  }

  if (method === "GET" && productMatch) {
    sendJson(response, 200, service.getProductDetails(token, decodeURIComponent(productMatch[1])));
    return;
  }

  if (method === "POST" && url.pathname === "/api/products") {
    const body = await readJsonBody(request);
    sendJson(response, 201, service.registerProduct(token, body));
    return;
  }

  if (method === "GET" && productActionMatch && productActionMatch[2] === "audit") {
    const productId = decodeURIComponent(productActionMatch[1]);
    const lat = url.searchParams.get("lat");
    const lon = url.searchParams.get("lon");
    const scanLocation =
      lat !== null && lon !== null ? normalizeGps({ lat: Number(lat), lon: Number(lon) }) : undefined;
    sendJson(response, 200, service.auditProduct(token, productId, scanLocation));
    return;
  }

  if (method === "POST" && productActionMatch) {
    const productId = decodeURIComponent(productActionMatch[1]);
    const action = productActionMatch[2];
    const body = await readJsonBody(request);

    if (action === "handoff") {
      sendJson(response, 200, service.handoffProduct(token, productId, body));
      return;
    }

    if (action === "update-nonce") {
      sendJson(response, 200, service.updateNonce(token, productId, body));
      return;
    }

    if (action === "transfer") {
      sendJson(response, 200, service.transferOwnership(token, productId, body));
      return;
    }

    if (action === "verify") {
      sendJson(response, 200, service.verifyProduct(token, productId, body));
      return;
    }
  }

  sendJson(response, 404, { error: "Route not found." });
}

function getBearerToken(request) {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function serveStatic(response, pathname) {
  const resolvedPath =
    pathname === "/" || pathname === "/verify"
      ? path.join(publicDir, "index.html")
      : path.join(publicDir, pathname.replace(/^\/+/, ""));

  const safePath = path.resolve(resolvedPath);
  if (!safePath.startsWith(path.resolve(publicDir)) || !fs.existsSync(safePath)) {
    serveFile(response, path.join(publicDir, "index.html"));
    return;
  }

  serveFile(response, safePath);
}

function serveFile(response, filePath) {
  const extension = path.extname(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extension] ?? "application/octet-stream",
    "Cache-Control": "no-store"
  });
  response.end(fs.readFileSync(filePath));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

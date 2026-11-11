"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const backend = require("./index");
const store = require("./git-store");

const SITE_DIR = process.env.SITE_DIR || "/srv/books/site";
const PORT = Number(process.env.PORT || 8080);
const BIND_ADDRESS = process.env.BIND_ADDRESS || "0.0.0.0";
const BODY_LIMIT = 3_000_000;
const PUBLIC_URL = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", ...extra });
  res.end(body);
}

async function staticFile(res, pathname) {
  const fileMap = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/admin": ["admin-app.html", "text/html; charset=utf-8"],
    "/admin.html": ["admin-app.html", "text/html; charset=utf-8"],
    "/admin-app.html": ["admin-app.html", "text/html; charset=utf-8"],
    "/admin-auth.js": ["admin-auth.js", "text/javascript; charset=utf-8"],
    "/admin-config.js": ["admin-config.js", "text/javascript; charset=utf-8"],
  };
  if (fileMap[pathname]) {
    const [name, type] = fileMap[pathname];
    const body = await fs.readFile(path.join(SITE_DIR, name));
    return send(res, 200, type, body, { "Cache-Control": name.endsWith(".js") ? "no-cache" : "no-store" });
  }
  if (pathname === "/books.json" || /^\/covers\/[A-Za-z0-9._-]{1,180}$/.test(pathname)) {
    const name = pathname.slice(1);
    const body = await store.read(name);
    if (!body) return send(res, 404, "text/plain; charset=utf-8", "Not found");
    const type = name.endsWith(".json") ? "application/json; charset=utf-8" : (name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg");
    return send(res, 200, type, body, { "Cache-Control": "public, max-age=60" });
  }
  return send(res, 404, "text/plain; charset=utf-8", "Not found");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const trustedProxy = isLoopback(req.socket.remoteAddress || "");
    const secure = Boolean(req.socket.encrypted) || (trustedProxy && String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https");
    if (!secure && PUBLIC_URL && req.method === "GET" && ["/admin", "/admin.html", "/admin-app.html"].includes(url.pathname)) {
      res.writeHead(302, { Location: `${PUBLIC_URL}${url.pathname}${url.search}`, "Cache-Control": "no-store" });
      return res.end();
    }
    if (url.pathname === "/api") {
      const host = req.headers.host || "";
      const origin = req.headers.origin || "";
      if (origin && origin !== `${secure ? "https" : "http"}://${host}`) return send(res, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Источник не разрешён." }));
      if (req.method === "OPTIONS") return send(res, 204, "application/json; charset=utf-8", "", { "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type" });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > BODY_LIMIT) return send(res, 413, "application/json; charset=utf-8", JSON.stringify({ error: "Запрос слишком большой." }));
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : String(value || "")]));
      const route = query.route || "/api/health";
      const startedAt = Date.now();
      process.stdout.write(`${new Date().toISOString()} start ${req.method} ${route}\n`);
      const forwardedIp = trustedProxy ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
      const result = await backend.handle({ method: req.method.toUpperCase(), route, query, headers, body, secure, ip: forwardedIp || req.socket.remoteAddress || "unknown" });
      process.stdout.write(`${new Date().toISOString()} done ${req.method} ${route} ${result.statusCode} ${Date.now() - startedAt}ms\n`);
      return send(res, result.statusCode, result.headers["Content-Type"], result.body, result.headers);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "Method not allowed", { Allow: "GET, HEAD" });
    if (req.method === "HEAD") {
      res.writeHead(200, { "X-Content-Type-Options": "nosniff" });
      return res.end();
    }
    return await staticFile(res, decodeURIComponent(url.pathname));
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    const message = status < 500 ? error.message : "Внутренняя ошибка сервера.";
    if (status >= 500) process.stderr.write(`${new Date().toISOString()} request failed: ${error.message}\n`);
    return send(res, status, "application/json; charset=utf-8", JSON.stringify({ error: message }));
  }
});

server.listen(PORT, BIND_ADDRESS, () => process.stdout.write(`Books admin listening on ${server.address().address}:${PORT}\n`));

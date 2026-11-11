"use strict";

const crypto = require("node:crypto");
const store = require("./git-store");

const SESSION_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 3_000_000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 8;
const attempts = new Map();

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyPassword(value, encoded) {
  const [scheme, salt, expected] = String(encoded || "").split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const digest = crypto.scryptSync(String(value), salt, 32).toString("base64url");
  return safeEqual(digest, expected);
}

function sessionToken() {
  const secret = process.env.SESSION_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: "shared-editor", iat: now, exp: now + SESSION_SECONDS })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function validSession(token) {
  try {
    const [payload, signature, extra] = String(token || "").split(".");
    if (!payload || !signature || extra) return false;
    const expected = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest();
    const received = Buffer.from(signature, "base64url");
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims.sub === "shared-editor" && claims.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function checkLoginLimit(ip) {
  const now = Date.now();
  const previous = attempts.get(ip);
  if (previous && now - previous.startedAt < LOGIN_WINDOW_MS) {
    if (previous.blockedUntil > now) return false;
    previous.count += 1;
    if (previous.count > LOGIN_MAX_ATTEMPTS) {
      previous.blockedUntil = now + LOGIN_WINDOW_MS;
      return false;
    }
  } else {
    attempts.set(ip, { startedAt: now, count: 1, blockedUntil: 0 });
  }
  if (attempts.size > 2000) {
    for (const [key, item] of attempts) if (now - item.startedAt > LOGIN_WINDOW_MS * 2) attempts.delete(key);
  }
  return true;
}

function parseBody(raw) {
  if (Buffer.byteLength(raw || "", "utf8") > MAX_BODY_BYTES) throw Object.assign(new Error("Запрос слишком большой."), { statusCode: 413 });
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("Некорректные данные запроса."), { statusCode: 400 }); }
}

function response(statusCode, body, extraHeaders = {}) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders }, body: JSON.stringify(body) };
}

function sessionCookieHeader(token, clear = false) {
  const value = clear ? "" : `books_admin=${token}`;
  const age = clear ? 0 : SESSION_SECONDS;
  return `${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;
}

function cookieSession(headers) {
  const raw = String(headers.cookie || "");
  const item = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith("books_admin="));
  return item ? item.slice("books_admin=".length) : "";
}

async function stats(days) {
  if (!process.env.GOATCOUNTER_TOKEN || !process.env.GOATCOUNTER_CODE) return { statusCode: 503, body: { error: "Статистика не настроена." } };
  const count = Math.min(365, Math.max(1, Number.parseInt(days || "30", 10)));
  const end = new Date();
  const start = new Date(end.getTime() - (count - 1) * 86400000);
  const iso = (value) => value.toISOString().slice(0, 10);
  const base = `https://${process.env.GOATCOUNTER_CODE}.goatcounter.com/api/v0`;
  const headers = { Authorization: `Bearer ${process.env.GOATCOUNTER_TOKEN}` };
  const query = `start=${encodeURIComponent(`${iso(start)}T00:00:00Z`)}&end=${encodeURIComponent(`${iso(end)}T23:59:59Z`)}`;
  const [totalResponse, hitsResponse] = await Promise.all([
    fetch(`${base}/stats/total?${query}&daily=1`, { headers, signal: AbortSignal.timeout(8000) }),
    fetch(`${base}/stats/hits?${query}&daily=1&limit=100`, { headers, signal: AbortSignal.timeout(8000) }),
  ]);
  if (!totalResponse.ok || !hitsResponse.ok) return { statusCode: 502, body: { error: "Не удалось загрузить статистику." } };
  const [total, hits] = await Promise.all([totalResponse.json(), hitsResponse.json()]);
  return { statusCode: 200, body: { total, hits } };
}

async function handle({ method, route, query, headers, body, ip, secure = false }) {
  if (route === "/api/health" && method === "GET") return response(200, { ok: true });
  if (route === "/api/logout" && method === "POST") return response(200, { ok: true }, { "Set-Cookie": sessionCookieHeader("", true) });
  if (route === "/api/login" && method === "POST") {
    if (!secure) return response(400, { error: "Открой редактор по защищённой HTTPS-ссылке." });
    if (!checkLoginLimit(ip)) return response(429, { error: "Слишком много попыток. Подожди минуту и попробуй снова." });
    const input = parseBody(body);
    if (!process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD_HASH || !process.env.SESSION_SECRET) return response(503, { error: "Вход ещё не настроен." });
    if (!safeEqual(String(input.login || ""), process.env.ADMIN_LOGIN) || !verifyPassword(input.password || "", process.env.ADMIN_PASSWORD_HASH)) {
      return response(401, { error: "Логин или пароль не подошёл." });
    }
    return response(200, { login: process.env.ADMIN_LOGIN, expiresIn: SESSION_SECONDS }, { "Set-Cookie": sessionCookieHeader(sessionToken()) });
  }

  if (!secure) return response(400, { error: "Открой редактор по защищённой HTTPS-ссылке." });
  if (!validSession(cookieSession(headers))) return response(401, { error: "Сеанс закончился. Войди снова." });
  if (route === "/api/me" && method === "GET") return response(200, { login: process.env.ADMIN_LOGIN || "редактор" });

  if (route === "/api/catalog" && method === "GET") {
    const raw = await store.read("books.json");
    if (!raw) return response(404, { error: "Каталог books.json не найден." });
    let catalog;
    try { catalog = JSON.parse(raw.toString("utf8")); }
    catch { return response(502, { error: "Файл каталога повреждён." }); }
    if (!Array.isArray(catalog.books)) return response(502, { error: "Файл каталога повреждён." });
    return response(200, { catalog, sha: await store.blobSha("books.json") });
  }

  if (route === "/api/covers" && method === "POST") {
    const input = parseBody(body);
    const name = String(input.path || "");
    const content = String(input.contentBase64 || "");
    if (!/^covers\/[A-Za-z0-9._-]{1,180}$/.test(name) || !content || content.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
      return response(400, { error: "Не удалось принять обложку. Максимальный размер после сжатия — около 2 МБ." });
    }
    const bytes = Buffer.from(content, "base64");
    if (bytes.length > 2_000_000) return response(413, { error: "Обложка слишком большая." });
    const sha = await store.write(name, bytes, "Обновление обложки книги");
    return response(200, { sha });
  }

  if (route === "/api/catalog" && method === "PUT") {
    const input = parseBody(body);
    const catalog = input.catalog;
    const expectedSha = String(input.expectedSha || "");
    if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.books) || !catalog.site || typeof catalog.site !== "object") return response(400, { error: "Данные каталога заполнены неверно." });
    const current = await store.blobSha("books.json");
    if (!current) return response(404, { error: "Текущий каталог не найден." });
    if (!expectedSha || expectedSha !== current) return response(409, { error: "Каталог уже обновил другой редактор. Забери свежую версию и повтори публикацию." });
    const sha = await store.write("books.json", Buffer.from(JSON.stringify(catalog, null, 2), "utf8"), "Обновление каталога книг", current);
    return response(200, { sha });
  }

  if (route === "/api/stats" && method === "GET") {
    const result = await stats(query.days);
    return response(result.statusCode, result.body);
  }
  return response(404, { error: "Такого адреса нет." });
}

module.exports = { handle };

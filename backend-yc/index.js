]7;file://ALEX/C:\Users\wwwla\Documents\Codex\2026-11-11\new-chat-3\"use strict";

const crypto = require("node:crypto");

const SESSION_SECONDS = 8 * 60 * 60;
const MAX_REQUEST_BYTES = 3_000_000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map();

function response(statusCode, body, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (origin && origin === process.env.ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = process.env.ALLOWED_ORIGIN;
    headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
    headers["Access-Control-Max-Age"] = "600";
  }
  return { statusCode, headers, isBase64Encoded: false, body: JSON.stringify(body) };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signSession(secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: "shared-editor", iat: now, exp: now + SESSION_SECONDS })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySession(secret, token) {
  try {
    const [payload, signature, extra] = String(token).split(".");
    if (!payload || !signature || extra) return false;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest();
    const received = Buffer.from(signature, "base64url");
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims.sub === "shared-editor" && Number(claims.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function parseBody(event) {
  const value = typeof event.body === "string" ? event.body : "";
  const body = event.isBase64Encoded ? Buffer.from(value, "base64").toString("utf8") : value;
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error("Запрос слишком большой."), { statusCode: 413 });
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error("Некорректные данные запроса."), { statusCode: 400 });
  }
}

function sourceIp(event) {
  return event.requestContext?.identity?.sourceIp || "unknown";
}

function checkLoginLimit(ip) {
  const now = Date.now();
  const previous = loginAttempts.get(ip);
  if (previous && now - previous.startedAt < LOGIN_WINDOW_MS) {
    if (previous.blockedUntil > now) return false;
    previous.attempts += 1;
    if (previous.attempts > LOGIN_MAX_ATTEMPTS) {
      previous.blockedUntil = now + LOGIN_WINDOW_MS;
      return false;
    }
  } else {
    loginAttempts.set(ip, { startedAt: now, attempts: 1, blockedUntil: 0 });
  }
  if (loginAttempts.size > 2000) {
    for (const [key, value] of loginAttempts) {
      if (now - value.startedAt > LOGIN_WINDOW_MS * 2) loginAttempts.delete(key);
    }
  }
  return true;
}

async function githubRequest(path, options = {}) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) {
    throw new Error("Сервер публикации ещё не настроен.");
  }
  return fetch(`https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
}

function repoPath(path) {
  if (path !== "books.json" && !/^covers\/[A-Za-z0-9._-]{1,180}$/.test(path)) {
    throw Object.assign(new Error("Недопустимый путь к файлу."), { statusCode: 400 });
  }
  return path.split("/").map(encodeURIComponent).join("/");
}

async function readFile(path) {
  const filePath = repoPath(path);
  const branch = encodeURIComponent(process.env.GITHUB_BRANCH || "main");
  const result = await githubRequest(`/contents/${filePath}?ref=${branch}`);
  if (result.status === 404) return null;
  if (!result.ok) throw Object.assign(new Error(`GitHub: чтение файла вернуло ${result.status}.`), { statusCode: 502 });
  return result.json();
}

async function putFile(path, content, message, sha) {
  const result = await githubRequest(`/contents/${repoPath(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content,
      branch: process.env.GITHUB_BRANCH || "main",
      ...(sha ? { sha } : {}),
    }),
  });
  const data = await result.json().catch(() => ({}));
  if (result.status === 409 || result.status === 422) {
    throw Object.assign(new Error("Файл уже изменили. Обнови каталог и повтори публикацию."), { statusCode: 409 });
  }
  if (!result.ok) throw Object.assign(new Error(`GitHub: запись файла вернула ${result.status}.`), { statusCode: 502 });
  return data.content?.sha || null;
}

function requireSession(event) {
  const headers = event.headers || {};
  const authorization = headers.authorization || headers.Authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return !!token && !!process.env.SESSION_SECRET && verifySession(process.env.SESSION_SECRET, token);
}

async function route(event, method, params) {
  const path = String(params.route || "/api/health").replace(/\/$/, "") || "/";
  if (path === "/api/health" && method === "GET") return { statusCode: 200, body: { ok: true } };

  if (path === "/api/login" && method === "POST") {
    if (!checkLoginLimit(sourceIp(event))) return { statusCode: 429, body: { error: "Слишком много попыток. Подожди минуту и попробуй снова." } };
    const body = parseBody(event);
    if (!process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
      return { statusCode: 503, body: { error: "Вход ещё не настроен." } };
    }
    if (!safeEqual(String(body.login || ""), process.env.ADMIN_LOGIN) || !safeEqual(String(body.password || ""), process.env.ADMIN_PASSWORD)) {
      return { statusCode: 401, body: { error: "Логин или пароль не подошёл." } };
    }
    return { statusCode: 200, body: { token: signSession(process.env.SESSION_SECRET), expiresIn: SESSION_SECONDS } };
  }

  if (!requireSession(event)) return { statusCode: 401, body: { error: "Сеанс закончился. Войди снова." } };

  if (path === "/api/me" && method === "GET") return { statusCode: 200, body: { login: process.env.ADMIN_LOGIN } };

  if (path === "/api/catalog" && method === "GET") {
    const file = await readFile("books.json");
    if (!file?.content) return { statusCode: 404, body: { error: "Каталог books.json не найден." } };
    const catalog = JSON.parse(Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"));
    if (!Array.isArray(catalog.books)) return { statusCode: 502, body: { error: "Файл каталога повреждён." } };
    return { statusCode: 200, body: { catalog, sha: file.sha } };
  }

  if (path === "/api/covers" && method === "POST") {
    const body = parseBody(event);
    const filePath = String(body.path || "");
    const content = String(body.contentBase64 || "");
    if (!/^covers\/[A-Za-z0-9._-]{1,180}$/.test(filePath) || !content || content.length > 2_800_000 || !/^[A-Za-z0-9+/=]+$/.test(content)) {
      return { statusCode: 400, body: { error: "Не удалось принять обложку. Максимальный размер после сжатия — около 2 МБ." } };
    }
    const current = await readFile(filePath);
    const sha = await putFile(filePath, content, "Обложка книги", current?.sha || null);
    return { statusCode: 200, body: { sha } };
  }

  if (path === "/api/catalog" && method === "PUT") {
    const body = parseBody(event);
    const catalog = body.catalog;
    const expectedSha = String(body.expectedSha || "");
    if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.books) || !catalog.site || typeof catalog.site !== "object") {
      return { statusCode: 400, body: { error: "Данные каталога заполнены неверно." } };
    }
    const current = await readFile("books.json");
    if (!current?.sha) return { statusCode: 404, body: { error: "Текущий каталог не найден." } };
    if (expectedSha && current.sha !== expectedSha) {
      return { statusCode: 409, body: { error: "Каталог уже обновил другой редактор. Забери свежую версию и повтори публикацию." } };
    }
    const content = Buffer.from(JSON.stringify(catalog, null, 2), "utf8").toString("base64");
    const sha = await putFile("books.json", content, "Обновление каталога книг", current.sha);
    return { statusCode: 200, body: { sha } };
  }

  if (path === "/api/stats" && method === "GET") {
    if (!process.env.GOATCOUNTER_TOKEN || !process.env.GOATCOUNTER_CODE) return { statusCode: 503, body: { error: "Статистика не настроена." } };
    const days = Math.min(365, Math.max(1, Number.parseInt(params.days || "30", 10)));
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (days - 1) * 86400000);
    const isoDate = (value) => value.toISOString().slice(0, 10);
    const start = `${isoDate(startDate)}T00:00:00Z`;
    const end = `${isoDate(endDate)}T23:59:59Z`;
    const api = `https://${process.env.GOATCOUNTER_CODE}.goatcounter.com/api/v0`;
    const headers = { Authorization: `Bearer ${process.env.GOATCOUNTER_TOKEN}` };
    const [totalResponse, hitsResponse] = await Promise.all([
      fetch(`${api}/stats/total?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&daily=1`, { headers }),
      fetch(`${api}/stats/hits?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&daily=1&limit=100`, { headers }),
    ]);
    if (!totalResponse.ok || !hitsResponse.ok) return { statusCode: 502, body: { error: "Не удалось загрузить статистику." } };
    const [total, hits] = await Promise.all([totalResponse.json(), hitsResponse.json()]);
    return { statusCode: 200, body: { total, hits } };
  }

  return { statusCode: 404, body: { error: "Такого адреса нет." } };
}

exports.handler = async (event) => {
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const origin = headers.origin || "";
  const method = String(event.httpMethod || event.requestContext?.httpMethod || "GET").toUpperCase();
  const params = event.queryStringParameters || {};
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "";

  if (!allowedOrigin || (origin && origin !== allowedOrigin)) return response(403, { error: "Источник не разрешён." }, origin);
  if (method === "OPTIONS") return response(200, {}, origin);

  try {
    const result = await route({ ...event, headers }, method, params);
    return response(result.statusCode, result.body, origin);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    const message = statusCode >= 500 ? "Внутренняя ошибка сервера." : error.message;
    return response(statusCode, { error: message }, origin);
  }
};


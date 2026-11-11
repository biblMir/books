const API_VERSION = "2022-11-28";
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const utf8 = new TextEncoder();

function json(data, status = 200, origin = "", allowedOrigin = "") {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (origin && origin === allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
    headers["Access-Control-Max-Age"] = "600";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function base64url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64Utf8(value) {
  const bytes = utf8.encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const normalized = value.replace(/\s/g, "");
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function safeEqual(left, right) {
  const a = utf8.encode(String(left));
  const b = utf8.encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

async function signSession(secret, username) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(utf8.encode(JSON.stringify({ sub: username, iat: now, exp: now + SESSION_SECONDS })));
  const key = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, utf8.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

async function verifySession(secret, token) {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return false;
    const key = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64url(signature), utf8.encode(payload));
    if (!valid) return false;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    return claims.sub === "shared-editor" && Number(claims.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function requireSession(request, env) {
  const value = request.headers.get("Authorization") || "";
  const token = value.startsWith("Bearer ") ? value.slice(7) : "";
  return !!token && !!env.SESSION_SECRET && (await verifySession(env.SESSION_SECRET, token));
}

async function githubRequest(env, path, options = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("Сервер публикации ещё не настроен.");
  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(options.headers || {}),
    },
  });
}

function safeRepoPath(path) {
  return path === "books.json" || /^covers\/[A-Za-z0-9._-]{1,180}$/.test(path);
}

async function readFile(env, path) {
  const url = `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`;
  const response = await githubRequest(env, url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub: чтение файла вернуло ${response.status}.`);
  return response.json();
}

async function putFile(env, path, content, message, sha = null) {
  const response = await githubRequest(env, `/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content,
      branch: env.GITHUB_BRANCH || "main",
      ...(sha ? { sha } : {}),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 409 || response.status === 422) {
    throw Object.assign(new Error("Файл уже изменили. Обнови каталог и повтори публикацию."), { status: 409 });
  }
  if (!response.ok) throw new Error(`GitHub: запись файла вернула ${response.status}.`);
  return result.content?.sha || null;
}

async function handleApi(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = env.ALLOWED_ORIGIN || "";
  if (!allowedOrigin || origin !== allowedOrigin) return json({ error: "Источник не разрешён." }, 403, origin, allowedOrigin);
  if (request.method === "OPTIONS") return json({}, 200, origin, allowedOrigin);

  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true }, 200, origin, allowedOrigin);
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.LOGIN_LIMITER) {
      const limit = await env.LOGIN_LIMITER.limit({ key: ip });
      if (!limit.success) return json({ error: "Слишком много попыток. Подожди минуту и попробуй снова." }, 429, origin, allowedOrigin);
    }
    const body = await request.json().catch(() => null);
    const login = String(body?.login || "");
    const password = String(body?.password || "");
    if (!env.ADMIN_LOGIN || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
      return json({ error: "Вход ещё не настроен." }, 503, origin, allowedOrigin);
    }
    if (!safeEqual(login, env.ADMIN_LOGIN) || !safeEqual(password, env.ADMIN_PASSWORD)) {
      return json({ error: "Логин или пароль не подошёл." }, 401, origin, allowedOrigin);
    }
    const token = await signSession(env.SESSION_SECRET, "shared-editor");
    return json({ token, expiresIn: SESSION_SECONDS }, 200, origin, allowedOrigin);
  }

  if (!(await requireSession(request, env))) return json({ error: "Сеанс закончился. Войди снова." }, 401, origin, allowedOrigin);

  if (url.pathname === "/api/me" && request.method === "GET") {
    return json({ login: env.ADMIN_LOGIN }, 200, origin, allowedOrigin);
  }

  if (url.pathname === "/api/catalog" && request.method === "GET") {
    try {
      const file = await readFile(env, "books.json");
      if (!file?.content) return json({ error: "Каталог books.json не найден." }, 404, origin, allowedOrigin);
      const catalog = JSON.parse(decodeBase64Utf8(file.content));
      if (!Array.isArray(catalog.books)) return json({ error: "Файл каталога повреждён." }, 502, origin, allowedOrigin);
      return json({ catalog, sha: file.sha }, 200, origin, allowedOrigin);
    } catch (error) {
      return json({ error: error.message || "Не удалось загрузить каталог." }, error.status || 502, origin, allowedOrigin);
    }
  }

  if (url.pathname === "/api/covers" && request.method === "POST") {
    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > MAX_JSON_BYTES) return json({ error: "Файл слишком большой (лимит 8 МБ)." }, 413, origin, allowedOrigin);
    const body = await request.json().catch(() => null);
    const path = String(body?.path || "");
    const content = String(body?.contentBase64 || "");
    if (!/^covers\/[A-Za-z0-9._-]{1,180}$/.test(path) || !content || content.length > 11 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(content)) {
      return json({ error: "Не удалось принять обложку." }, 400, origin, allowedOrigin);
    }
    try {
      const current = await readFile(env, path);
      const sha = await putFile(env, path, content, "Обложка книги", current?.sha || null);
      return json({ sha }, 200, origin, allowedOrigin);
    } catch (error) {
      return json({ error: error.message || "Не удалось загрузить обложку." }, error.status || 502, origin, allowedOrigin);
    }
  }

  if (url.pathname === "/api/catalog" && request.method === "PUT") {
    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > MAX_JSON_BYTES) return json({ error: "Каталог слишком большой." }, 413, origin, allowedOrigin);
    const body = await request.json().catch(() => null);
    const catalog = body?.catalog;
    const expectedSha = String(body?.expectedSha || "");
    if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.books) || !catalog.site || typeof catalog.site !== "object") {
      return json({ error: "Данные каталога заполнены неверно." }, 400, origin, allowedOrigin);
    }
    try {
      const current = await readFile(env, "books.json");
      if (!current?.sha) return json({ error: "Текущий каталог не найден." }, 404, origin, allowedOrigin);
      if (expectedSha && current.sha !== expectedSha) {
        return json({ error: "Каталог уже обновил другой редактор. Забери свежую версию и повтори публикацию." }, 409, origin, allowedOrigin);
      }
      const content = base64Utf8(JSON.stringify(catalog, null, 2));
      const sha = await putFile(env, "books.json", content, "Обновление каталога книг", current.sha);
      return json({ sha }, 200, origin, allowedOrigin);
    } catch (error) {
      return json({ error: error.message || "Не удалось опубликовать каталог." }, error.status || 502, origin, allowedOrigin);
    }
  }

  if (url.pathname === "/api/stats" && request.method === "GET") {
    if (!env.GOATCOUNTER_TOKEN || !env.GOATCOUNTER_CODE) return json({ error: "Статистика не настроена." }, 503, origin, allowedOrigin);
    const days = Math.min(365, Math.max(1, Number.parseInt(url.searchParams.get("days") || "30", 10)));
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (days - 1) * 86400000);
    const date = (value) => value.toISOString().slice(0, 10);
    const start = `${date(startDate)}T00:00:00Z`;
    const end = `${date(endDate)}T23:59:59Z`;
    const base = `https://${env.GOATCOUNTER_CODE}.goatcounter.com/api/v0`;
    const headers = { Authorization: `Bearer ${env.GOATCOUNTER_TOKEN}` };
    const [totalResponse, hitsResponse] = await Promise.all([
      fetch(`${base}/stats/total?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&daily=1`, { headers }),
      fetch(`${base}/stats/hits?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&daily=1&limit=100`, { headers }),
    ]);
    if (!totalResponse.ok || !hitsResponse.ok) return json({ error: "Не удалось загрузить статистику." }, 502, origin, allowedOrigin);
    const [total, hits] = await Promise.all([totalResponse.json(), hitsResponse.json()]);
    return json({ total, hits }, 200, origin, allowedOrigin);
  }

  return json({ error: "Такого адреса нет." }, 404, origin, allowedOrigin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      if (origin !== env.ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return json({}, 200, origin, env.ALLOWED_ORIGIN);
    }
    if (!new URL(request.url).pathname.startsWith("/api/")) return json({ error: "Такого адреса нет." }, 404, origin, env.ALLOWED_ORIGIN);
    try {
      return await handleApi(request, env);
    } catch (error) {
      return json({ error: "Внутренняя ошибка сервера." }, 500, origin, env.ALLOWED_ORIGIN);
    }
  },
};
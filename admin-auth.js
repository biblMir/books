(() => {
  const API = String(window.BOOKS_ADMIN_API || "").replace(/\/$/, "");
  const BASE_SHA_KEY = "booksAdminBaseSha.v1";
  const LS_PUB = "bookmgr.publish.v1";
  const LS_STATS = "bookmgr.stats.v1";
  const LS_EXPORTED = "bookmgr.publishedHash.v1";
  let authenticated = false;
  let baseSha = localStorage.getItem(BASE_SHA_KEY) || "";
  const overlay = document.getElementById("loginOverlay");
  const form = document.getElementById("loginForm");
  const message = document.getElementById("loginMessage");
  const submit = document.getElementById("loginSubmit");
  const logout = document.getElementById("btnLogout");

  // Remove credentials left by the former per-browser token flow.
  localStorage.removeItem(LS_PUB);
  localStorage.removeItem(LS_STATS);

  function showLogin(text = "") {
    authenticated = false;
    overlay.hidden = false;
    logout.hidden = true;
    message.textContent = text;
    document.getElementById("loginUser").focus();
  }

  function hideLogin(login) {
    overlay.hidden = true;
    logout.hidden = false;
    document.getElementById("signedInAs").textContent = login || "редактор";
  }

  async function api(path, options = {}) {
    if (!API || API.includes("YOUR_FUNCTION_ID")) {
      throw new Error("Сервер входа ещё не подключён.");
    }
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const [route, query = ""] = path.split("?");
    const endpoint = new URL(API, window.location.origin);
    endpoint.searchParams.set("route", route);
    new URLSearchParams(query).forEach((value, key) => endpoint.searchParams.set(key, value));
    const timeoutMs = path === "/api/login" || path === "/api/me" ? 10000 : path.startsWith("/api/covers") ? 60000 : 30000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(endpoint, { ...options, headers, credentials: "same-origin", cache: "no-store", signal: controller.signal });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Сервер долго не отвечает. Обнови страницу и проверь подключение.");
      throw new Error("Не удалось связаться с сервером. Проверь адрес и подключение к сети.");
    } finally {
      clearTimeout(timeout);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/login") showLogin("Сеанс закончился. Войди снова.");
      throw new Error(data.error || `Ошибка сервера: ${response.status}.`);
    }
    return data;
  }

  async function pullLatest(force = false) {
    const result = await api("/api/catalog");
    const exported = localStorage.getItem(LS_EXPORTED);
    const hasDraft = !!exported && exported !== stateHash();
    const previousSha = localStorage.getItem(BASE_SHA_KEY) || "";
    if (!force && hasDraft && previousSha && confirm("На этом компьютере есть неопубликованные изменения. Оставить их? Если другой редактор уже обновил каталог, публикация попросит сначала загрузить свежую версию.")) {
      baseSha = previousSha;
      return false;
    }
    for (const book of books) await coverDel(book.id).catch(() => {});
    blobUrlCache.clear();
    books = result.catalog.books.map(normalizeBook);
    site = { ...DEFAULT_SITE, ...result.catalog.site };
    baseSha = result.sha;
    localStorage.setItem(BASE_SHA_KEY, baseSha);
    fillSiteForm();
    save();
    await renderRows();
    await renderPreview();
    localStorage.setItem(LS_EXPORTED, stateHash());
    updateDirty();
    return true;
  }

  async function publish() {
    if (!authenticated) return showLogin("Сначала войди в админку.");
    const button = document.getElementById("btnPublish");
    button.disabled = true;
    try {
      let count = 0;
      for (const book of books.filter((item) => item.cover)) {
        const blob = await coverGet(book.id).catch(() => null);
        if (!blob) continue;
        pubStatusMsg(`Загружаю обложки… ${++count}`, "");
        await api("/api/covers", {
          method: "POST",
          body: JSON.stringify({ path: book.cover, contentBase64: await blobToBase64(blob) }),
        });
      }
      pubStatusMsg("Публикую каталог…", "");
      const result = await api("/api/catalog", {
        method: "PUT",
        body: JSON.stringify({ catalog: catalogData(), expectedSha: baseSha }),
      });
      baseSha = result.sha;
      localStorage.setItem(BASE_SHA_KEY, baseSha);
      localStorage.setItem(LS_EXPORTED, stateHash());
      updateDirty();
      pubStatusMsg("Опубликовано. Сайт обновится в течение минуты.", "ok");
      toast("Опубликовано");
    } catch (error) {
      pubStatusMsg(error.message, "err");
    } finally {
      button.disabled = false;
    }
  }

  async function loadStats() {
    const button = document.getElementById("btnLoadStats");
    button.disabled = true;
    statsStatusMsg("Загружаю…");
    try {
      const days = parseInt(document.getElementById("stPeriod").value, 10);
      const { total, hits } = await api(`/api/stats?days=${days}`);
      const events = hits.hits.filter((item) => item.event);
      const pages = hits.hits.filter((item) => !item.event);
      showStats({
        days: total.stats.map((item) => ({ day: item.day, count: item.daily })),
        books: events.map((item) => ({ name: item.path.replace(/^open-book:\s*/, ""), count: item.count })),
        pageviews: pages.reduce((sum, item) => sum + item.count, 0),
        totalVisitors: total.total,
        totalClicks: events.reduce((sum, item) => sum + item.count, 0),
        daysCount: days,
      });
      statsStatusMsg("Статистика обновлена.");
    } catch (error) {
      statsStatusMsg(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    message.textContent = "Проверяю вход…";
    try {
      const result = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ login: document.getElementById("loginUser").value.trim(), password: document.getElementById("loginPassword").value }),
      });
      message.textContent = "Вход принят, загружаю каталог…";
      document.getElementById("loginPassword").value = "";
      const me = await api("/api/me");
      authenticated = true;
      hideLogin(me.login);
      await pullLatest(false);
      pubStatusMsg("Вошёл. Каталог синхронизирован.", "ok");
    } catch (error) {
      showLogin(error.message);
    } finally {
      submit.disabled = false;
    }
  });

  // Intercept legacy handlers so API secrets never go from the browser to GitHub.
  document.addEventListener("click", (event) => {
    const button = event.target.closest("#btnPublish, #btnPull, #btnLoadStats, #btnLogout");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.id === "btnPublish") publish();
    else if (button.id === "btnPull") pullLatest(true).then(() => pubStatusMsg("Загружена свежая версия каталога.", "ok")).catch((error) => pubStatusMsg(error.message, "err"));
    else if (button.id === "btnLoadStats") loadStats();
    else api("/api/logout", { method: "POST" }).catch(() => {}).finally(() => showLogin("Ты вышел из админки."));
  }, true);

  (async () => {
    try {
      const me = await api("/api/me");
      authenticated = true;
      hideLogin(me.login);
      await pullLatest(false);
    } catch (error) {
      showLogin(error.message);
    }
  })();
})();

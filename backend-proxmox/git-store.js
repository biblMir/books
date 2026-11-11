"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const REPO_DIR = process.env.REPO_DIR || "/srv/books/repo";
const REPO_HTTPS = "https://github.com/biblMir/books.git";
const REPO_SSH = "git@github.com:biblMir/books.git";
const BRANCH = "main";
const DEPLOY_KEY = process.env.DEPLOY_KEY || "/etc/books-deploy/id_ed25519";
const KNOWN_HOSTS = process.env.SSH_KNOWN_HOSTS || "/etc/books-deploy/known_hosts";
const ALLOWED_FILE = /^(books\.json|covers\/[A-Za-z0-9._-]{1,180})$/;
const MAX_BUFFER = 4 * 1024 * 1024;

let queue = Promise.resolve();
let ready = false;

function git(args, options = {}) {
  return execFileAsync("git", args, {
    cwd: REPO_DIR,
    encoding: options.encoding || "utf8",
    maxBuffer: MAX_BUFFER,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: `ssh -i ${DEPLOY_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${KNOWN_HOSTS}`,
    },
  });
}

function filePath(value) {
  const clean = String(value || "");
  if (!ALLOWED_FILE.test(clean)) throw Object.assign(new Error("Недопустимый путь к файлу."), { statusCode: 400 });
  return clean;
}

async function ensureReady() {
  if (ready) return;
  await fs.mkdir(path.dirname(REPO_DIR), { recursive: true });
  try {
    await fs.access(path.join(REPO_DIR, ".git"));
  } catch {
    await execFileAsync("git", ["clone", "--depth=1", "--branch", BRANCH, REPO_HTTPS, REPO_DIR], { maxBuffer: MAX_BUFFER });
    await execFileAsync("git", ["remote", "add", "publish", REPO_SSH], { cwd: REPO_DIR });
    await execFileAsync("git", ["config", "user.name", "Books catalog editor"], { cwd: REPO_DIR });
    await execFileAsync("git", ["config", "user.email", "books-editor@localhost"], { cwd: REPO_DIR });
  }
  ready = true;
}

function serialized(operation) {
  const result = queue.then(operation, operation);
  queue = result.catch(() => {});
  return result;
}

async function syncLatest() {
  await ensureReady();
  await git(["fetch", "--depth=1", "origin", BRANCH]);
}

async function readUnlocked(name) {
  const clean = filePath(name);
  await syncLatest();
  try {
    const { stdout } = await git(["show", `origin/${BRANCH}:${clean}`], { encoding: "buffer" });
    return stdout;
  } catch (error) {
    if (String(error.stderr || "").includes("does not exist") || String(error.stderr || "").includes("path '") ) return null;
    throw error;
  }
}

async function blobShaUnlocked(name) {
  const clean = filePath(name);
  try {
    const { stdout } = await git(["rev-parse", `origin/${BRANCH}:${clean}`]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function read(name) {
  return serialized(() => readUnlocked(name));
}

async function blobSha(name) {
  return serialized(async () => {
    await syncLatest();
    return blobShaUnlocked(name);
  });
}

async function write(name, content, message, expectedSha = null) {
  const clean = filePath(name);
  return serialized(async () => {
    await syncLatest();
    const currentSha = await blobShaUnlocked(clean);
    if (expectedSha !== null && currentSha !== expectedSha) {
      throw Object.assign(new Error("Каталог уже обновил другой редактор. Забери свежую версию и повтори публикацию."), { statusCode: 409 });
    }
    if (!currentSha && clean === "books.json") {
      throw Object.assign(new Error("Каталог books.json не найден."), { statusCode: 404 });
    }

    await git(["reset", "--hard", `origin/${BRANCH}`]);
    const target = path.join(REPO_DIR, ...clean.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { mode: 0o644 });
    await git(["add", "--", clean]);
    await git(["commit", "-m", String(message || "Обновление каталога книг").slice(0, 100)]);
    try {
      await git(["push", "publish", `HEAD:${BRANCH}`]);
    } catch (error) {
      throw Object.assign(new Error("Не удалось опубликовать изменения. Проверь deploy key и повтори попытку."), { statusCode: 503, cause: error });
    }
    await git(["fetch", "--depth=1", "origin", BRANCH]);
    return await blobShaUnlocked(clean);
  });
}

module.exports = { read, write, blobSha, ensureReady };

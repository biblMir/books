"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const target = process.env.ENV_FILE || "/etc/books-admin.env";
if (fs.existsSync(target)) throw new Error(`${target} already exists; refusing to overwrite it.`);

const words = [
  "sova", "reka", "kedr", "most", "list", "kniga", "sneg", "veter",
  "lampa", "noch", "bereg", "kamen", "moroz", "ogon", "klen", "zerno",
  "teplo", "luna", "pole", "trava", "zakat", "tuman", "iskra", "volna",
  "dom", "sad", "les", "grad", "shmel", "kot", "kit", "yantar",
  "mys", "vesna", "more", "kofe", "hleb", "zvezda", "syr", "slon",
  "klyon", "topol", "ruch", "fontan", "mostok", "kruzhka", "fonar", "sok",
  "mango", "limon", "perchatka", "teatr", "motyl", "barhat", "karandash", "chay",
  "sunduk", "vagon", "panda", "robot", "sharf", "pion", "ruchey", "oblako",
];
const password = `${Array.from({ length: 6 }, () => words[crypto.randomInt(words.length)]).join("-")}-${crypto.randomInt(1000, 10000)}`;
const salt = crypto.randomBytes(16).toString("base64url");
const digest = crypto.scryptSync(password, salt, 32).toString("base64url");
const values = [
  "PORT=8080",
  "SITE_DIR=/srv/books/site",
  "REPO_DIR=/var/lib/books/repo",
  "DEPLOY_KEY=/var/lib/books/.ssh/id_ed25519",
  "SSH_KNOWN_HOSTS=/var/lib/books/.ssh/known_hosts",
  "ADMIN_LOGIN=editor",
  `ADMIN_PASSWORD_HASH=scrypt$${salt}$${digest}`,
  `SESSION_SECRET=${crypto.randomBytes(48).toString("base64url")}`,
  "GOATCOUNTER_CODE=lana",
  "",
].join("\n");
fs.writeFileSync(target, values, { mode: 0o640, flag: "wx" });
execFileSync("chown", ["root:books", target]);
console.log(`ADMIN_LOGIN=editor\nADMIN_PASSWORD=${password}`);

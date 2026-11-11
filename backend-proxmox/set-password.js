"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const target = process.env.ENV_FILE || "/etc/books-admin.env";
const input = process.stdin;
let password = "";
process.stdout.write("Новый общий пароль (ввод скрыт): ");
if (input.isTTY && input.setRawMode) input.setRawMode(true);
input.resume();
input.setEncoding("utf8");
input.on("data", (chunk) => {
  for (const char of chunk) {
    if (char === "\u0003") process.exit(130);
    if (char === "\r" || char === "\n") {
      if (input.setRawMode) input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (password.length < 12) {
        process.stderr.write("Пароль должен быть не короче 12 символов.\n");
        process.exit(1);
      }
      const salt = crypto.randomBytes(16).toString("base64url");
      const digest = crypto.scryptSync(password, salt, 32).toString("base64url");
      const hash = `scrypt$${salt}$${digest}`;
      const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
      const line = `ADMIN_PASSWORD_HASH=${hash}`;
      const next = /^ADMIN_PASSWORD_HASH=.*$/m.test(current)
        ? current.replace(/^ADMIN_PASSWORD_HASH=.*$/m, line)
        : `${current.trimEnd()}\n${line}\n`;
      const temp = `${target}.new`;
      fs.writeFileSync(temp, next, { mode: 0o600 });
      fs.renameSync(temp, target);
      execFileSync("chown", ["root:books", target]);
      fs.chmodSync(target, 0o640);
      password = "";
      process.stdout.write("Пароль сохранён. Перезапусти books-admin.service.\n");
      process.exit(0);
    }
    if (char === "\u007f" || char === "\b") password = password.slice(0, -1);
    else password += char;
  }
});

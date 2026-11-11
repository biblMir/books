# Cloudflare API for the book catalog

This Worker is the private backend for the public GitHub Pages site. Editors use one shared login and password; the GitHub and GoatCounter tokens stay in Cloudflare Worker Secrets and are never included in `site/admin.html`.

## One-time setup

1. Install Node.js if it is not already installed, then from this folder run `npx wrangler login` and complete Cloudflare sign-in.
2. Create a GitHub fine-grained personal access token for **only** `biblMir/books`, with repository permission **Contents: Read and write**. It is a server credential, not an editor credential; never paste it into chat or commit it. Set an expiry and rotate it before it expires.
3. From `worker/`, run `npx wrangler secret put GITHUB_TOKEN` and paste the token into the Wrangler prompt.
4. Run `npx wrangler secret put ADMIN_LOGIN` and enter the shared login, then `npx wrangler secret put ADMIN_PASSWORD` and enter a memorable but non-trivial shared passphrase. Do not put these values in files or messages.
5. Generate a random session signing key locally and set it with `npx wrangler secret put SESSION_SECRET`.
6. If the admin should show GoatCounter statistics, set `GOATCOUNTER_TOKEN` with `npx wrangler secret put GOATCOUNTER_TOKEN`. The site code already uses the `lana` GoatCounter account.
7. Deploy with `npx wrangler deploy`. Wrangler prints the Worker URL, typically `https://books-admin-api.<account-subdomain>.workers.dev`.
8. Put that URL in `site/admin-config.js` as `BOOKS_ADMIN_API`. Then publish the updated admin files to `biblMir/books`.

The `LOGIN_LIMITER` binding limits repeated login attempts. Its limit is approximate and local to the Cloudflare location, so use a long passphrase and do not share it outside the editor group.

## API behavior

- `POST /api/login` checks the shared login and password and returns a short-lived, signed session token.
- `GET /api/me` validates the session.
- `GET /api/catalog` reads the current catalog from GitHub.
- `PUT /api/catalog` writes the catalog and checks the previously-read GitHub SHA to prevent overwriting another editor's newer changes.
- `POST /api/covers` uploads an image to the repository.
- `GET /api/stats?days=30` proxies GoatCounter statistics without exposing its token.

Only requests from `https://biblmir.github.io` are accepted by CORS. The Worker token is limited to this one repository and is not sent to browsers.
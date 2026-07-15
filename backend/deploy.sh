#!/bin/bash
set -e
# Full deploy: pull from GitHub, rebuild API + frontend, restart all services
# Usage: bash /app/deploy.sh
# Requires: GITHUB_DEPLOY_TOKEN in /app/.env

REPO_DIR=/var/www/fansly-everywhere
GH_REMOTE="https://${GITHUB_DEPLOY_TOKEN}@github.com/FTPLabs/fan-platform.git"

echo "[deploy] $(date) — starting"

# 1. Pull latest code
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "$GH_REMOTE" "$REPO_DIR"
else
  cd "$REPO_DIR"
  git remote set-url origin "$GH_REMOTE"
  git fetch origin main
  git reset --hard origin/main
fi

cd "$REPO_DIR"

# 2. Install dependencies (uses pnpm from PATH)
export PNPM_HOME="/root/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"
pnpm install --frozen-lockfile 2>&1 | tail -5

# 3. Build API server
echo "[deploy] building API server..."
pnpm --filter @workspace/api-server run build
# Copy built bundle to /app/api/
mkdir -p /app/api
cp -f artifacts/api-server/dist/index.mjs /app/api/index.mjs
cp -f artifacts/api-server/dist/index.mjs.map /app/api/index.mjs.map 2>/dev/null || true
# Copy pino worker files needed at runtime
for f in artifacts/api-server/dist/pino-file.mjs artifacts/api-server/dist/pino-worker.mjs artifacts/api-server/dist/pino-pretty.mjs artifacts/api-server/dist/thread-stream-worker.mjs; do
  [ -f "$f" ] && cp -f "$f" /app/api/ && cp -f "${f}.map" /app/api/ 2>/dev/null || true
done
echo "[deploy] API built and copied"

# 4. Build frontend
echo "[deploy] building frontend..."
pnpm --filter @workspace/fansly-everywhere run build
echo "[deploy] frontend built at $REPO_DIR/artifacts/fansly-everywhere/dist/public"

# 5. Copy backend scripts
cp -f backend/auth-bot.mjs /app/auth-bot.mjs
cp -f backend/mtproto-auth.mjs /app/mtproto-auth.mjs
cp -f backend/patch-gramjs.cjs /app/patch-gramjs.cjs
cp -f backend/make_telethon_session.py /app/make_telethon_session.py
cp -f backend/gen-tdata.py /app/gen-tdata.py
cp -f backend/tg_full_export.py /app/tg_full_export.py
cp -f backend/set_2fa_telethon.py /app/set_2fa_telethon.py
cp -f backend/ecosystem.config.js /app/ecosystem.config.js

# 6. Update nginx if config changed
diff backend/nginx.conf /etc/nginx/sites-available/fansly >/dev/null 2>&1 || {
  cp -f backend/nginx.conf /etc/nginx/sites-available/fansly
  nginx -t && systemctl reload nginx && echo "[deploy] nginx reloaded"
}

# 7. Load env vars
set -a && source /app/.env && set +a

# 8. Apply gramjs patch
node /app/patch-gramjs.cjs || true

# 9. Restart all PM2 processes
echo "[deploy] restarting PM2 processes..."
pm2 restart fan-api || pm2 start /app/ecosystem.config.js --only fan-api
pm2 delete auth-bot mtproto-auth >/dev/null 2>&1 || true
sleep 1
pm2 start /app/ecosystem.config.js --only auth-bot,mtproto-auth
pm2 save

echo "[deploy] done: $(date)"
pm2 list

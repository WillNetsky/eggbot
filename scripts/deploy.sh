#!/usr/bin/env bash
set -e

HOST="netsky@192.168.1.211"
REMOTE_DIR="~/eggbot"
NODE_PATH="/usr/local/bin:/usr/local/Cellar/node@22/22.22.0/bin"

echo "→ Syncing source..."
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude '*.db' \
  --exclude 'eggbot.json' \
  . "$HOST:$REMOTE_DIR"

echo "→ Building..."
ssh "$HOST" "export PATH=$NODE_PATH:\$PATH && cd $REMOTE_DIR && npm install --silent && npm run build"

echo "→ Restarting..."
ssh "$HOST" "export PATH=$NODE_PATH:\$PATH && cd $REMOTE_DIR && pm2 restart eggbot 2>/dev/null || pm2 start dist/index.js --name eggbot"

echo "→ Checking status..."
ssh "$HOST" "export PATH=$NODE_PATH:\$PATH && pm2 show eggbot | grep -E 'status|restarts|uptime'"

echo "✓ Deployed to $HOST"

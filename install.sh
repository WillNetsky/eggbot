#!/usr/bin/env bash
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

EGGBOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$HOME/.eggbot"

echo ""
echo -e "${CYAN}${BOLD}  🥚 eggbot installer${NC}"
echo -e "  ${BOLD}$(uname -s) / $(uname -m)${NC}"
echo ""

# ── Check Node ──────────────────────────────────────────────────────────────

NODE_MIN=22
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found.${NC} Install Node ${NODE_MIN}+ from https://nodejs.org"
  exit 1
fi

NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt "$NODE_MIN" ]; then
  echo -e "${RED}✗ Node.js ${NODE_VER} is too old.${NC} Need Node ${NODE_MIN}+."
  exit 1
fi

echo -e "${GREEN}✓${NC} Node.js $(node --version)"

# ── Install deps ─────────────────────────────────────────────────────────────

echo -e "${GREEN}✓${NC} Installing dependencies..."
cd "$EGGBOT_DIR"
npm install --silent

# ── Build ────────────────────────────────────────────────────────────────────

echo -e "${GREEN}✓${NC} Building..."
npm run build --silent

# ── Config ───────────────────────────────────────────────────────────────────

mkdir -p "$DATA_DIR"

configure() {
  echo ""
  echo -e "  ${BOLD}Configure eggbot${NC}"
  echo ""

  # Ollama host
  read -r -p "  Ollama host [http://localhost:11434]: " OLLAMA_HOST
  OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"

  # Test connectivity
  printf "  Testing Ollama connection... "
  if curl -sf "${OLLAMA_HOST}/api/tags" -o /dev/null 2>/dev/null; then
    echo -e "${GREEN}✓ connected${NC}"

    # List available models
    MODELS=$(curl -sf "${OLLAMA_HOST}/api/tags" | grep -o '"name":"[^"]*"' | cut -d'"' -f4 | head -20 || true)
    if [ -n "$MODELS" ]; then
      echo ""
      echo -e "  Available models:"
      echo "$MODELS" | while read -r m; do echo "    - $m"; done
      echo ""
    fi
  else
    echo -e "${YELLOW}⚠ could not reach Ollama${NC} (continuing anyway — check host/port later)"
  fi

  # Model selection
  echo -e "  Model routing ${CYAN}(press Enter to keep default)${NC}:"
  read -r -p "  Orchestrator / general    [qwen2.5:14b]: "        M_ORCH;  M_ORCH="${M_ORCH:-qwen2.5:14b}"
  read -r -p "  Coder                     [qwen2.5-coder:14b]: "  M_CODER; M_CODER="${M_CODER:-qwen2.5-coder:14b}"
  read -r -p "  Fast / lightweight        [qwen2.5:7b]: "          M_FAST;  M_FAST="${M_FAST:-qwen2.5:7b}"
  read -r -p "  Reasoning                 [deepseek-r1:8b]: "      M_REAS;  M_REAS="${M_REAS:-deepseek-r1:8b}"

  # Server port
  read -r -p "  Web UI port               [4444]: " PORT
  PORT="${PORT:-4444}"

  # Write config
  cat > "$EGGBOT_DIR/eggbot.json" <<EOF
{
  "ollama": {
    "host": "$OLLAMA_HOST",
    "models": {
      "orchestrator": "$M_ORCH",
      "coder": "$M_CODER",
      "fast": "$M_FAST",
      "reasoning": "$M_REAS"
    }
  },
  "server": {
    "port": $PORT,
    "host": "0.0.0.0"
  },
  "agent": {
    "maxWorkers": 8,
    "maxIterations": 50,
    "systemName": "eggbot"
  }
}
EOF

  echo ""
  echo -e "${GREEN}✓${NC} Config written to eggbot.json"
}

if [ ! -f "$EGGBOT_DIR/eggbot.json" ]; then
  configure
else
  echo -e "${GREEN}✓${NC} eggbot.json already exists"
  read -r -p "  Reconfigure? [y/N] " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    configure
  fi
fi

# ── Daemon setup ─────────────────────────────────────────────────────────────

OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  install_launchd() {
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST="$PLIST_DIR/ai.eggbot.plist"
    LOG_DIR="$DATA_DIR/logs"
    mkdir -p "$PLIST_DIR" "$LOG_DIR"

    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.eggbot</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>$EGGBOT_DIR/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$EGGBOT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/eggbot.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/eggbot.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
EOF

    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo -e "${GREEN}✓${NC} Daemon installed and started (launchd)"
    echo -e "  Logs: ${CYAN}$LOG_DIR/eggbot.log${NC}"
    echo -e "  Stop:  ${CYAN}launchctl unload $PLIST${NC}"
    echo -e "  Start: ${CYAN}launchctl load $PLIST${NC}"
  }

  echo ""
  read -r -p "  Install as login daemon (auto-start on login)? [Y/n] " ans
  ans="${ans:-Y}"
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    install_launchd
  else
    echo -e "  Run manually: ${CYAN}npm start${NC} or ${CYAN}npm run dev${NC}"
  fi

elif [ "$OS" = "Linux" ]; then
  install_systemd() {
    SERVICE_FILE="$HOME/.config/systemd/user/eggbot.service"
    LOG_DIR="$DATA_DIR/logs"
    mkdir -p "$(dirname "$SERVICE_FILE")" "$LOG_DIR"

    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=eggbot autonomous agent daemon
After=network.target

[Service]
Type=simple
ExecStart=$(which node) $EGGBOT_DIR/dist/index.js
WorkingDirectory=$EGGBOT_DIR
Restart=always
RestartSec=3
StandardOutput=append:$LOG_DIR/eggbot.log
StandardError=append:$LOG_DIR/eggbot.error.log
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable eggbot
    systemctl --user start eggbot
    echo -e "${GREEN}✓${NC} Daemon installed and started (systemd user service)"
    echo -e "  Logs:   ${CYAN}journalctl --user -u eggbot -f${NC}"
    echo -e "  Status: ${CYAN}systemctl --user status eggbot${NC}"
    echo -e "  Stop:   ${CYAN}systemctl --user stop eggbot${NC}"
  }

  echo ""
  read -r -p "  Install as systemd user service? [Y/n] " ans
  ans="${ans:-Y}"
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    install_systemd
  else
    echo -e "  Run manually: ${CYAN}npm start${NC} or ${CYAN}npm run dev${NC}"
  fi

else
  echo -e "${YELLOW}⚠${NC}  Unknown OS — skipping daemon setup. Run manually: npm start"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}  eggbot installed.${NC}"
echo -e "  Config: ${CYAN}$EGGBOT_DIR/eggbot.json${NC}"
echo -e "  Data:   ${CYAN}$DATA_DIR/${NC}"
echo -e "  Web UI: ${CYAN}http://localhost:4444${NC}"
echo ""
echo ""

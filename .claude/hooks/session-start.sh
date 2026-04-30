#!/bin/bash
set -euo pipefail

# Only run in remote Claude Code environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
ENGINE_DIR="$PROJECT_DIR/engine"
APP_DIR="$PROJECT_DIR/app"

log() { echo "==> [vayu] $*"; }
ok()  { echo "    [ok] $*"; }
skip(){ echo "    [skip] $*"; }

# ── 1. System packages ────────────────────────────────────────────────────────
log "Checking system build dependencies..."

MISSING_PKGS=()

need_pkg() {
  local cmd="$1" pkg="$2"
  command -v "$cmd" &>/dev/null || MISSING_PKGS+=("$pkg")
}

need_pkg cmake        cmake
need_pkg ninja        ninja-build
need_pkg g++          g++
need_pkg pkg-config   pkg-config
need_pkg python3      python3
need_pkg curl         curl
need_pkg zip          zip
need_pkg unzip        unzip
need_pkg tar          tar

# libssl headers needed by vcpkg's curl port
dpkg -s libssl-dev &>/dev/null 2>&1 || MISSING_PKGS+=(libssl-dev)
# libcurl headers
dpkg -s libcurl4-openssl-dev &>/dev/null 2>&1 || MISSING_PKGS+=(libcurl4-openssl-dev)

if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
  log "Installing missing packages: ${MISSING_PKGS[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends "${MISSING_PKGS[@]}"
else
  ok "All system packages present"
fi

# Verify cmake version >= 3.25
CMAKE_VER=$(cmake --version | head -1 | grep -oP '\d+\.\d+\.\d+')
CMAKE_MAJOR=$(echo "$CMAKE_VER" | cut -d. -f1)
CMAKE_MINOR=$(echo "$CMAKE_VER" | cut -d. -f2)
if [ "$CMAKE_MAJOR" -lt 3 ] || { [ "$CMAKE_MAJOR" -eq 3 ] && [ "$CMAKE_MINOR" -lt 25 ]; }; then
  log "cmake $CMAKE_VER is too old (need >= 3.25), installing from Kitware APT..."
  sudo apt-get install -y --no-install-recommends apt-transport-https ca-certificates gnupg
  wget -O - https://apt.kitware.com/keys/kitware-archive-latest.asc 2>/dev/null \
    | gpg --dearmor - \
    | sudo tee /usr/share/keyrings/kitware-archive-keyring.gpg >/dev/null
  . /etc/os-release
  echo "deb [signed-by=/usr/share/keyrings/kitware-archive-keyring.gpg] https://apt.kitware.com/ubuntu/ $UBUNTU_CODENAME main" \
    | sudo tee /etc/apt/sources.list.d/kitware.list
  sudo apt-get update -qq
  sudo apt-get install -y cmake
  ok "cmake $(cmake --version | head -1) installed"
else
  ok "cmake $CMAKE_VER"
fi

# ── 2. Node.js >= 20 ──────────────────────────────────────────────────────────
log "Checking Node.js..."
if command -v node &>/dev/null; then
  NODE_VER=$(node --version | grep -oP '\d+' | head -1)
  if [ "$NODE_VER" -lt 20 ]; then
    log "Node.js v$NODE_VER is too old (need >= 20), upgrading via nvm..."
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] || {
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    }
    # shellcheck disable=SC1091
    source "$NVM_DIR/nvm.sh"
    nvm install 20 --lts
    nvm use 20
    echo "source \"$NVM_DIR/nvm.sh\"" >> "$CLAUDE_ENV_FILE"
    echo "nvm use 20 --silent" >> "$CLAUDE_ENV_FILE"
  else
    ok "Node.js v$NODE_VER"
  fi
else
  log "Node.js not found, installing via nvm..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm install 20 --lts
  nvm use 20
  echo "source \"$NVM_DIR/nvm.sh\"" >> "$CLAUDE_ENV_FILE"
  echo "nvm use 20 --silent" >> "$CLAUDE_ENV_FILE"
fi

# ── 3. pnpm >= 10 ─────────────────────────────────────────────────────────────
log "Checking pnpm..."
if command -v pnpm &>/dev/null; then
  PNPM_VER=$(pnpm --version | grep -oP '^\d+')
  if [ "$PNPM_VER" -lt 10 ]; then
    log "pnpm $PNPM_VER is too old (need >= 10), upgrading..."
    npm install -g pnpm@latest
  else
    ok "pnpm $(pnpm --version)"
  fi
else
  log "pnpm not found, installing..."
  npm install -g pnpm@latest
  ok "pnpm $(pnpm --version)"
fi

# ── 4. vcpkg ──────────────────────────────────────────────────────────────────
log "Checking vcpkg..."
VCPKG_DIR="${VCPKG_ROOT:-${VCPKG_INSTALLATION_ROOT:-$HOME/.vcpkg}}"

if [ ! -f "$VCPKG_DIR/vcpkg" ]; then
  log "Bootstrapping vcpkg at $VCPKG_DIR..."
  git clone https://github.com/microsoft/vcpkg.git "$VCPKG_DIR" --depth=1 --quiet
  "$VCPKG_DIR/bootstrap-vcpkg.sh" -disableMetrics
  ok "vcpkg bootstrapped"
else
  ok "vcpkg at $VCPKG_DIR"
fi

# Export VCPKG_ROOT for this session and future sessions
export VCPKG_ROOT="$VCPKG_DIR"
if ! grep -q "VCPKG_ROOT" "${CLAUDE_ENV_FILE:-/dev/null}" 2>/dev/null; then
  echo "export VCPKG_ROOT=\"$VCPKG_DIR\"" >> "$CLAUDE_ENV_FILE"
  echo "export PATH=\"$VCPKG_DIR:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# ── 5. vcpkg dependencies (engine/vcpkg.json) ─────────────────────────────────
# Pre-install packages so the first cmake configure doesn't need to download them.
# Uses the manifest mode baseline from engine/vcpkg.json.
log "Installing vcpkg packages for engine (curl, nlohmann-json, cpp-httplib, gtest, sqlite3, sqlite-orm)..."
VCPKG_PACKAGES=(curl nlohmann-json cpp-httplib gtest sqlite3 sqlite-orm)
"$VCPKG_DIR/vcpkg" install "${VCPKG_PACKAGES[@]}" \
  --triplet x64-linux \
  --x-install-root="$VCPKG_DIR/installed" \
  --overlay-ports="$ENGINE_DIR" \
  2>&1 | tail -5 || true   # non-fatal; cmake --preset will also install via manifest mode
ok "vcpkg packages ready"

# ── 6. App JS dependencies ────────────────────────────────────────────────────
log "Installing app JS dependencies..."
cd "$APP_DIR"
pnpm install --frozen-lockfile
ok "pnpm install complete"

log "Environment setup complete. Ready to build with: python build.py --dev"

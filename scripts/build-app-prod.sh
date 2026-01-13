#!/bin/bash

# Vayu App - Production Build Script
# This script builds the complete production app with bundled engine
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
APP_DIR="$PROJECT_ROOT/app"
ENGINE_SCRIPT="$SCRIPT_DIR/build-engine-macos.sh"

# Helper functions
info() { echo -e "${BLUE}==>${NC} $1"; }
warn() { echo -e "${YELLOW}Warning:${NC} $1"; }
error() { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }
success() { echo -e "${GREEN}✓${NC} $1"; }

# Build engine
build_engine() {
    info "Building C++ engine for production..."
    
    if [ ! -f "$ENGINE_SCRIPT" ]; then
        error "Engine build script not found: $ENGINE_SCRIPT"
    fi
    
    bash "$ENGINE_SCRIPT"
    success "Engine built and packaged"
}

# Install app dependencies
install_deps() {
    info "Installing app dependencies..."
    cd "$APP_DIR"
    
    if ! command -v pnpm &>/dev/null; then
        error "pnpm not found. Install it with: npm install -g pnpm"
    fi
    
    pnpm install
    success "Dependencies installed"
}

# Build the Electron app
build_app() {
    info "Building Electron app..."
    cd "$APP_DIR"
    
    # Compile TypeScript
    info "Compiling TypeScript..."
    pnpm run electron:compile
    
    # Build React app with Vite
    info "Building React app..."
    pnpm run build
    
    # Package with electron-builder
    info "Packaging with electron-builder..."
    pnpm run electron:build
    
    success "App built successfully"
}

# Main
main() {
    local start_time=$(date +%s)
    
    echo "Vayu App - Production Build"
    echo "============================="
    echo ""
    
    build_engine
    install_deps
    build_app
    
    local end_time=$(date +%s)
    local elapsed=$((end_time - start_time))
    
    echo ""
    success "Production build completed in ${elapsed}s!"
    echo ""
    echo "Output:"
    echo "  - DMG installer: app/release/Vayu Desktop-*.dmg"
    echo ""
    echo "To test the app:"
    echo "  1. Open the DMG file"
    echo "  2. Drag Vayu Desktop to Applications"
    echo "  3. Launch from Applications folder"
}

main

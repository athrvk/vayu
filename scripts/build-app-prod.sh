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

# Helper functions
info() { echo -e "${BLUE}==>${NC} $1"; }
warn() { echo -e "${YELLOW}Warning:${NC} $1"; }
error() { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }
success() { echo -e "${GREEN}✓${NC} $1"; }

# Detect platform and set engine script
detect_platform() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        PLATFORM="macOS"
        ENGINE_SCRIPT="$SCRIPT_DIR/build-engine-macos.sh"
        OUTPUT_INFO="DMG installer: app/release/Vayu Desktop-*.dmg"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        PLATFORM="Linux"
        ENGINE_SCRIPT="$SCRIPT_DIR/build-engine-linux.sh"
        OUTPUT_INFO="AppImage/deb: app/release/Vayu Desktop-*"
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]] || [[ "$OSTYPE" == "cygwin" ]] || grep -q Microsoft /proc/version 2>/dev/null; then
        PLATFORM="Windows"
        ENGINE_SCRIPT="$SCRIPT_DIR/build-engine-windows.sh"
        OUTPUT_INFO="NSIS installer: app/release/Vayu Desktop Setup *.exe"
    else
        error "Unsupported platform: $OSTYPE"
    fi
    info "Building for: $PLATFORM"
}

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
    
    detect_platform
    build_engine
    install_deps
    build_app
    
    local end_time=$(date +%s)
    local elapsed=$((end_time - start_time))
    
    echo ""
    success "Production build completed in ${elapsed}s!"
    echo ""
    echo "Output:"
    echo "  - $OUTPUT_INFO"
    echo ""
    if [[ "$PLATFORM" == "macOS" ]]; then
        echo "To test the app:"
        echo "  1. Open the DMG file"
        echo "  2. Drag Vayu Desktop to Applications"
        echo "  3. Launch from Applications folder"
    elif [[ "$PLATFORM" == "Linux" ]]; then
        echo "To test the app:"
        echo "  1. Install the .deb package or run the AppImage"
        echo "  2. Launch Vayu Desktop from your applications menu"
    elif [[ "$PLATFORM" == "Windows" ]]; then
        echo "To test the app:"
        echo "  1. Run the installer"
        echo "  2. Launch Vayu Desktop from the Start menu"
    fi
}

main

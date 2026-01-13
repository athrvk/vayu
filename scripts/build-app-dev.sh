#!/bin/bash

# Vayu App - Development Build Script
# This script sets up and runs the development environment
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
ENGINE_DIR="$PROJECT_ROOT/engine"
APP_DIR="$PROJECT_ROOT/app"

# Helper functions
info() { echo -e "${BLUE}==>${NC} $1"; }
warn() { echo -e "${YELLOW}Warning:${NC} $1"; }
error() { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }
success() { echo -e "${GREEN}✓${NC} $1"; }

# Detect platform
detect_platform() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        PLATFORM="macos"
        CORES=$(sysctl -n hw.physicalcpu 2>/dev/null || echo 4)
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        PLATFORM="linux"
        CORES=$(nproc 2>/dev/null || echo 4)
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]] || [[ "$OSTYPE" == "cygwin" ]] || grep -q Microsoft /proc/version 2>/dev/null; then
        PLATFORM="windows"
        CORES=$(nproc 2>/dev/null || echo 4)
    else
        error "Unsupported platform: $OSTYPE"
    fi
    info "Platform detected: $PLATFORM"
}

# Check if engine is built
check_engine() {
    local engine_binary
    
    if [[ "$PLATFORM" == "windows" ]]; then
        engine_binary="$ENGINE_DIR/build/Release/vayu-engine.exe"
    else
        engine_binary="$ENGINE_DIR/build/vayu-engine"
    fi
    
    if [ ! -f "$engine_binary" ]; then
        warn "Engine binary not found at: $engine_binary"
        info "Building engine..."
        
        cd "$ENGINE_DIR"
        if [ -d "build" ]; then
            info "Using existing build directory"
        else
            info "Creating new build directory"
            mkdir -p build
        fi
        
        cd build
        
        if [[ "$PLATFORM" == "windows" ]]; then
            cmake .. -G "Visual Studio 17 2022" -DCMAKE_BUILD_TYPE=Debug
            cmake --build . --config Debug -j "$CORES"
        else
            cmake .. -DCMAKE_BUILD_TYPE=Debug
            cmake --build . -j "$CORES"
        fi
        
        success "Engine built successfully"
    else
        success "Engine binary found at: $engine_binary"
    fi
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

# Main
main() {
    echo "Vayu App - Development Setup"
    echo "=============================="
    echo ""
    
    detect_platform
    check_engine
    install_deps
    
    echo ""
    success "Development environment ready!"
    echo ""
    echo "To start development:"
    echo "  cd app"
    echo "  pnpm run electron:dev"
    echo ""
    echo "This will:"
    echo "  1. Start Vite dev server (React app)"
    echo "  2. Compile TypeScript for Electron"
    echo "  3. Launch Electron with the app"
    echo "  4. Auto-start the C++ engine sidecar"
}

main

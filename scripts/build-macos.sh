#!/bin/bash

# Vayu Build Script for macOS
# Usage: ./build-macos.sh [dev|prod]
# 
# This script builds the C++ engine and Electron app for macOS
# - dev:  Development build with debug symbols
# - prod: Production build optimized and packaged as DMG

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Helper functions
info() { echo -e "${BLUE}==>${NC} $1"; }
warn() { echo -e "${YELLOW}Warning:${NC} $1"; }
error() { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }
success() { echo -e "${GREEN}✓${NC} $1"; }

# Determine build mode
BUILD_MODE="${1:-prod}"
if [[ "$BUILD_MODE" != "dev" && "$BUILD_MODE" != "prod" ]]; then
    error "Invalid build mode. Use 'dev' or 'prod'"
fi

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$PROJECT_ROOT/engine"
APP_DIR="$PROJECT_ROOT/app"

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    error "This script is for macOS only"
fi

# Check prerequisites
check_prerequisites() {
    info "Checking prerequisites..."
    
    if ! command -v cmake &>/dev/null; then
        error "cmake not found. Install with: brew install cmake"
    fi
    
    if ! command -v vcpkg &>/dev/null; then
        error "vcpkg not found. Install from: https://vcpkg.io/en/getting-started.html"
    fi
    
    if ! command -v pnpm &>/dev/null; then
        error "pnpm not found. Install with: npm install -g pnpm"
    fi
    
    success "Prerequisites checked"
}

# Build engine
build_engine() {
    if [[ "$BUILD_MODE" == "dev" ]]; then
        info "Building C++ engine (Debug mode)..."
        BUILD_TYPE="Debug"
        BUILD_DIR="$ENGINE_DIR/build"
    else
        info "Building C++ engine (Release mode)..."
        BUILD_TYPE="Release"
        BUILD_DIR="$ENGINE_DIR/build-release"
    fi
    
    # Get vcpkg root
    VCPKG_ROOT="$(dirname "$(which vcpkg)")"
    
    # Detect architecture
    ARCH=$(uname -m)
    if [[ "$ARCH" == "arm64" ]]; then
        TRIPLET="arm64-osx"
    else
        TRIPLET="x64-osx"
    fi
    
    # Clean and create build directory
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"
    
    # Configure CMake
    cmake -GNinja \
          -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
          -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
          -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
          -DVCPKG_MANIFEST_MODE=OFF \
          -DVAYU_BUILD_TESTS=OFF \
          -DVAYU_BUILD_CLI=OFF \
          -DVAYU_BUILD_ENGINE=ON \
          ..
    
    # Build
    local cores=$(sysctl -n hw.physicalcpu 2>/dev/null || echo 4)
    cmake --build . -j "$cores"
    
    success "Engine built successfully"
}

# Build Electron app
build_electron() {
    info "Building Electron app..."
    cd "$APP_DIR"
    
    # Install dependencies
    if [ ! -d "node_modules" ]; then
        info "Installing dependencies..."
        pnpm install
    fi
    
    if [[ "$BUILD_MODE" == "dev" ]]; then
        # Development mode - just compile TypeScript
        info "Compiling TypeScript..."
        pnpm run electron:compile
        success "Development build ready"
    else
        # Production mode - full build with packaging
        info "Compiling TypeScript..."
        pnpm run electron:compile
        
        info "Building React app..."
        pnpm run build
        
        # Copy engine binary to resources
        mkdir -p "$APP_DIR/resources/bin"
        cp "$ENGINE_DIR/build-release/vayu-engine" "$APP_DIR/resources/bin/vayu-engine"
        chmod +x "$APP_DIR/resources/bin/vayu-engine"
        
        info "Packaging with electron-builder..."
        pnpm run electron:build
        
        success "Production build complete"
    fi
}

# Main execution
main() {
    local start_time=$(date +%s)
    
    echo ""
    echo "╔════════════════════════════════════════╗"
    echo "║   Vayu Build Script for macOS          ║"
    echo "║   Mode: $(printf '%-30s' "$BUILD_MODE")║"
    echo "╚════════════════════════════════════════╝"
    echo ""
    
    check_prerequisites
    build_engine
    build_electron
    
    local end_time=$(date +%s)
    local elapsed=$((end_time - start_time))
    
    echo ""
    echo "╔════════════════════════════════════════╗"
    echo "║   Build completed in ${elapsed}s              ║"
    echo "╚════════════════════════════════════════╝"
    echo ""
    
    if [[ "$BUILD_MODE" == "dev" ]]; then
        echo "🚀 To start the app in development mode:"
        echo ""
        echo "   cd app"
        echo "   pnpm run electron:dev"
        echo ""
        echo "This will:"
        echo "  • Start Vite dev server (React app on http://localhost:5173)"
        echo "  • Launch Electron with the app"
        echo "  • Auto-start the C++ engine sidecar"
        echo ""
    else
        echo "✅ Production build created:"
        echo ""
        echo "   app/release/Vayu Desktop-*.dmg"
        echo ""
        echo "📦 To install:"
        echo "  1. Open the DMG file"
        echo "  2. Drag Vayu Desktop to Applications"
        echo "  3. Launch from Applications folder"
        echo ""
    fi
}

main

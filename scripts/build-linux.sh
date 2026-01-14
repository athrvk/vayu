#!/bin/bash

# Vayu Build Script for Linux
# Usage: ./build-linux.sh [dev|prod] [OPTIONS]
# 
# This script builds the C++ engine and Electron app for Linux
# - dev:  Development build with debug symbols
# - prod: Production build optimized and packaged as AppImage/deb
#
# Options:
#   --skip-engine       Skip building the C++ engine
#   --skip-app          Skip building the Electron app
#   --clean             Clean build directory before building
#   --vcpkg-root PATH   Override vcpkg root directory
#   --artifacts PATH    Copy build artifacts to this directory (for CI)
#   -h, --help          Show this help message

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

# Default values
BUILD_MODE="prod"
SKIP_ENGINE=false
SKIP_APP=false
CLEAN_BUILD=false
VCPKG_ROOT_OVERRIDE=""
ARTIFACTS_DIR=""

# Parse arguments
show_help() {
    echo "Vayu Build Script for Linux"
    echo ""
    echo "Usage: ./build-linux.sh [dev|prod] [OPTIONS]"
    echo ""
    echo "Build Modes:"
    echo "  dev     Development build with debug symbols"
    echo "  prod    Production build optimized and packaged (default)"
    echo ""
    echo "Options:"
    echo "  --skip-engine       Skip building the C++ engine"
    echo "  --skip-app          Skip building the Electron app"
    echo "  --clean             Clean build directory before building"
    echo "  --vcpkg-root PATH   Override vcpkg root directory"
    echo "  --artifacts PATH    Copy build artifacts to this directory (for CI)"
    echo "  -h, --help          Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./build-linux.sh dev                    # Dev build (engine + app)"
    echo "  ./build-linux.sh prod --skip-engine     # Prod build, skip engine"
    echo "  ./build-linux.sh prod --clean           # Clean prod build"
    echo "  ./build-linux.sh prod --artifacts ./out # Prod build with artifacts"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        dev|prod)
            BUILD_MODE="$1"
            shift
            ;;
        --skip-engine)
            SKIP_ENGINE=true
            shift
            ;;
        --skip-app)
            SKIP_APP=true
            shift
            ;;
        --clean)
            CLEAN_BUILD=true
            shift
            ;;
        --vcpkg-root)
            VCPKG_ROOT_OVERRIDE="$2"
            shift 2
            ;;
        --artifacts)
            ARTIFACTS_DIR="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            ;;
        *)
            error "Unknown option: $1. Use --help for usage."
            ;;
    esac
done

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$PROJECT_ROOT/engine"
APP_DIR="$PROJECT_ROOT/app"

# Check if running on Linux
if [[ "$OSTYPE" != "linux-gnu"* ]]; then
    error "This script is for Linux only"
fi

# Check prerequisites
check_prerequisites() {
    info "Checking prerequisites..."
    
    local missing=()
    
    # Check cmake
    if command -v cmake &>/dev/null; then
        local cmake_version=$(cmake --version | head -n1)
        echo -e "  CMake: $cmake_version"
    else
        missing+=("cmake (sudo apt install cmake ninja-build)")
    fi
    
    # Check ninja
    if command -v ninja &>/dev/null; then
        local ninja_version=$(ninja --version)
        echo -e "  Ninja: $ninja_version"
    else
        missing+=("ninja-build (sudo apt install ninja-build)")
    fi
    
    # Check vcpkg
    if [[ -n "$VCPKG_ROOT_OVERRIDE" ]]; then
        VCPKG_ROOT="$VCPKG_ROOT_OVERRIDE"
        echo -e "  vcpkg (overridden): $VCPKG_ROOT"
    elif [[ -n "$VCPKG_ROOT" ]] && [[ -d "$VCPKG_ROOT" ]]; then
        echo -e "  vcpkg: $VCPKG_ROOT"
    elif command -v vcpkg &>/dev/null; then
        VCPKG_ROOT="$(dirname "$(which vcpkg)")"
        echo -e "  vcpkg: $VCPKG_ROOT"
    else
        missing+=("vcpkg (https://vcpkg.io/en/getting-started.html)")
    fi
    
    # Check pnpm (only if building app)
    if [[ "$SKIP_APP" == false ]]; then
        if command -v pnpm &>/dev/null; then
            local pnpm_version=$(pnpm --version)
            echo -e "  pnpm: $pnpm_version"
        else
            missing+=("pnpm (npm install -g pnpm)")
        fi
    fi
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo ""
        echo -e "${RED}Missing prerequisites:${NC}"
        for item in "${missing[@]}"; do
            echo -e "  - $item"
        done
        echo ""
        error "Please install the missing prerequisites and try again."
    fi
    
    success "All prerequisites found"
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
    
    # Detect architecture
    ARCH=$(uname -m)
    if [[ "$ARCH" == "aarch64" ]] || [[ "$ARCH" == "arm64" ]]; then
        TRIPLET="arm64-linux"
    else
        TRIPLET="x64-linux"
    fi
    
    # Clean build directory if requested
    if [[ "$CLEAN_BUILD" == true ]] && [[ -d "$BUILD_DIR" ]]; then
        info "Cleaning build directory..."
        rm -rf "$BUILD_DIR"
    fi
    
    # Create build directory
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"
    
    # Configure CMake
    info "Configuring CMake..."
    cmake -GNinja \
          -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
          -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
          -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
          -DVCPKG_MANIFEST_MODE=ON \
          -DVAYU_BUILD_TESTS=OFF \
          -DVAYU_BUILD_CLI=OFF \
          -DVAYU_BUILD_ENGINE=ON \
          ..
    
    # Build
    info "Building..."
    local cores=$(nproc 2>/dev/null || echo 4)
    cmake --build . -j "$cores"
    
    # Verify binary
    if [[ ! -f "$BUILD_DIR/vayu-engine" ]]; then
        error "Build succeeded but binary not found at: $BUILD_DIR/vayu-engine"
    fi
    
    ENGINE_BINARY="$BUILD_DIR/vayu-engine"
    success "Engine built successfully: $ENGINE_BINARY"
}

# Setup application icons
setup_icons() {
    info "Setting up application icons..."
    
    local icon_png_dir="$PROJECT_ROOT/shared/icon_png"
    local build_dir="$APP_DIR/build"
    
    # Ensure build directory exists
    mkdir -p "$build_dir"
    
    # Copy PNG for Linux (256x256 is standard)
    if [[ -f "$icon_png_dir/vayu_icon_256x256.png" ]]; then
        cp "$icon_png_dir/vayu_icon_256x256.png" "$build_dir/icon.png"
        echo "    icon.png (Linux)"
    fi
    
    # Copy all PNG icon sizes for electron-builder's icon set (Linux needs these)
    local icon_set_dir="$build_dir/icons"
    mkdir -p "$icon_set_dir"
    
    if [[ -d "$icon_png_dir" ]]; then
        cp "$icon_png_dir"/*.png "$icon_set_dir/" 2>/dev/null || true
        echo "    icons/ folder (all PNG sizes)"
    fi
    
    success "Icons ready"
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
    
    # Setup icons from shared folder
    setup_icons
    
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
        local resources_dir="$APP_DIR/build/resources/bin"
        mkdir -p "$resources_dir"
        
        if [[ -n "$ENGINE_BINARY" ]] && [[ -f "$ENGINE_BINARY" ]]; then
            info "Copying engine binary to resources..."
            cp "$ENGINE_BINARY" "$resources_dir/vayu-engine"
            chmod +x "$resources_dir/vayu-engine"
            echo "    Copied: vayu-engine"
        else
            warn "Engine binary not found, skipping copy"
        fi
        
        info "Packaging with electron-builder..."
        pnpm run electron:pack
        
        # Copy artifacts to output directory if specified (for CI)
        if [[ -n "$ARTIFACTS_DIR" ]]; then
            local release_dir="$APP_DIR/release"
            if [[ -d "$release_dir" ]]; then
                mkdir -p "$ARTIFACTS_DIR"
                info "Copying build artifacts to: $ARTIFACTS_DIR"
                cp "$release_dir"/*.AppImage "$ARTIFACTS_DIR/" 2>/dev/null || true
                cp "$release_dir"/*.deb "$ARTIFACTS_DIR/" 2>/dev/null || true
                cp "$release_dir"/*.rpm "$ARTIFACTS_DIR/" 2>/dev/null || true
            else
                warn "Release directory not found: $release_dir"
            fi
        fi
        
        success "Production build complete"
    fi
}

# Main execution
main() {
    local start_time=$(date +%s)
    
    echo ""
    echo "╔════════════════════════════════════════╗"
    echo "║   Vayu Build Script for Linux          ║"
    echo "║   Mode: $(printf '%-30s' "${BUILD_MODE^^}")║"
    echo "╚════════════════════════════════════════╝"
    echo ""
    
    check_prerequisites
    
    ENGINE_BINARY=""
    
    if [[ "$SKIP_ENGINE" == false ]]; then
        build_engine
    else
        warn "Skipping engine build"
        # Try to find existing binary
        if [[ "$BUILD_MODE" == "prod" ]]; then
            ENGINE_BINARY="$ENGINE_DIR/build-release/vayu-engine"
        else
            ENGINE_BINARY="$ENGINE_DIR/build/vayu-engine"
        fi
        if [[ -f "$ENGINE_BINARY" ]]; then
            info "Using existing engine binary: $ENGINE_BINARY"
        fi
    fi
    
    if [[ "$SKIP_APP" == false ]]; then
        build_electron
    else
        warn "Skipping app build"
    fi
    
    local end_time=$(date +%s)
    local elapsed=$((end_time - start_time))
    
    echo ""
    echo "╔════════════════════════════════════════╗"
    echo "║   Build completed in ${elapsed}s               ║"
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
        if [[ -d "$APP_DIR/release" ]]; then
            ls -1 "$APP_DIR/release"/*.AppImage 2>/dev/null | while read f; do echo "   $f"; done
            ls -1 "$APP_DIR/release"/*.deb 2>/dev/null | while read f; do echo "   $f"; done
            ls -1 "$APP_DIR/release"/*.rpm 2>/dev/null | while read f; do echo "   $f"; done
        fi
        echo ""
        echo "📦 To install:"
        echo "  AppImage: chmod +x *.AppImage && ./Vayu-*.AppImage"
        echo "  deb: sudo dpkg -i vayu-client_*.deb"
        echo "  rpm: sudo rpm -i vayu-client-*.rpm"
        echo ""
    fi
}

# Run main with error handling
if ! main; then
    echo ""
    echo "╔════════════════════════════════════════╗"
    echo "║   Build failed!                        ║"
    echo "╚════════════════════════════════════════╝"
    echo ""
    exit 1
fi

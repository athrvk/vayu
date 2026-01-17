#!/bin/bash

# Vayu Build Script for Linux
# Usage: ./build-linux.sh [dev|prod] [OPTIONS]
# 
# This script builds the C++ engine and Electron app for Linux
# - dev:  Development build with debug symbols
# - prod: Production build optimized and packaged as AppImage/deb

set -e

# Save the directory from where the script was launched
# This is crucial for generating correct relative paths at the end,
# because the script changes directories during execution.
LAUNCH_DIR="$(pwd)"

# Colors for output (consistent across platforms)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Helper functions (consistent style)
info()    { echo -e "${CYAN}==>${NC} $1"; }
warn()    { echo -e "${YELLOW}Warning:${NC} $1"; }
error()   { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }

# Default values
BUILD_MODE="prod"
SKIP_ENGINE=false
SKIP_APP=false
CLEAN_BUILD=false
VERBOSE_OUTPUT=false
VCPKG_ROOT_OVERRIDE=""
ARTIFACTS_DIR=""

# Parse arguments
show_help() {
    echo "Vayu Build Script for Linux"
    echo "Usage: ./build-linux.sh [dev|prod] [-e|-a] [OPTIONS]"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        dev|prod) BUILD_MODE="$1"; shift ;;
        -e|--skip-app) SKIP_APP=true; SKIP_ENGINE=false; shift ;;
        -a|--skip-engine) SKIP_ENGINE=true; SKIP_APP=false; shift ;;
        --clean) CLEAN_BUILD=true; shift ;;
        -v|--verbose) VERBOSE_OUTPUT=true; shift ;;
        --vcpkg-root) VCPKG_ROOT_OVERRIDE="$2"; shift 2 ;;
        --artifacts) ARTIFACTS_DIR="$2"; shift 2 ;;
        -h|--help) show_help ;;
        *) error "Unknown option: $1. Use --help for usage." ;;
    esac
done

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
ENGINE_DIR="$PROJECT_ROOT/engine"
APP_DIR="$PROJECT_ROOT/app"

# Helper to calculate path relative to LAUNCH directory
get_relative_path() {
    local target="$1"
    if command -v realpath &>/dev/null; then
        realpath --relative-to="$LAUNCH_DIR" "$target"
    else
        # Fallback to python if realpath isn't installed
        python3 -c "import os; print(os.path.relpath('$target', '$LAUNCH_DIR'))" 2>/dev/null || echo "$target"
    fi
}

# Check if running on Linux
if [[ "$OSTYPE" != "linux-gnu"* ]]; then
    error "This script is for Linux only"
fi

# Check prerequisites
check_prerequisites() {
    info "Checking prerequisites..."
    local missing=()
    
    if ! command -v cmake &>/dev/null; then missing+=("cmake"); fi
    if ! command -v ninja &>/dev/null; then missing+=("ninja-build"); fi
    
    # Check vcpkg
    if [[ -n "$VCPKG_ROOT_OVERRIDE" ]]; then
        VCPKG_ROOT="$VCPKG_ROOT_OVERRIDE"
    elif [[ -n "$VCPKG_ROOT" ]] && [[ -d "$VCPKG_ROOT" ]]; then
        : # VCPKG_ROOT is set
    elif command -v vcpkg &>/dev/null; then
        VCPKG_ROOT="$(dirname "$(which vcpkg)")"
    else
        missing+=("vcpkg")
    fi
    
    if [[ "$SKIP_APP" == false ]] && ! command -v pnpm &>/dev/null; then
        missing+=("pnpm");
    fi
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        error "Missing prerequisites: ${missing[*]}"
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
    
    if [[ "$CLEAN_BUILD" == true ]] && [[ -d "$BUILD_DIR" ]]; then
        rm -rf "$BUILD_DIR"
    fi
    
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"
    
    info "Configuring CMake..."
    # Simplified logging logic for brevity
    if ! cmake -GNinja \
        -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
        -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
        -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
        -DVCPKG_MANIFEST_MODE=ON \
        -DVAYU_BUILD_TESTS=OFF \
        -DVAYU_BUILD_CLI=OFF \
        -DVAYU_BUILD_ENGINE=ON \
        .. > /tmp/cmake_config.log 2>&1; then
        cat /tmp/cmake_config.log
        error "CMake configuration failed"
    fi
    
    info "Building..."
    local cores=$(nproc 2>/dev/null || echo 4)
    if ! cmake --build . -j "$cores" > /tmp/cmake_build.log 2>&1; then
        cat /tmp/cmake_build.log
        error "Build failed"
    fi
    
    ENGINE_BINARY="$BUILD_DIR/vayu-engine"
    if [[ ! -f "$ENGINE_BINARY" ]]; then
        error "Binary not found at $ENGINE_BINARY"
    fi
    success "Engine built successfully"
}

# Setup icons
setup_icons() {
    local icon_png_dir="$PROJECT_ROOT/shared/icon_png"
    local build_dir="$APP_DIR/build"
    mkdir -p "$build_dir/icons"
    
    if [[ -f "$icon_png_dir/vayu_icon_256x256.png" ]]; then
        cp "$icon_png_dir/vayu_icon_256x256.png" "$build_dir/icon.png"
    fi
    if [[ -d "$icon_png_dir" ]]; then
        cp "$icon_png_dir"/*.png "$build_dir/icons/" 2>/dev/null || true
    fi
}

# Build Electron app
build_electron() {
    info "Building Electron app..."
    cd "$APP_DIR"
    
    if [ ! -d "node_modules" ]; then
        info "Installing dependencies..."
        pnpm install
    fi
    
    setup_icons
    
    if [[ "$BUILD_MODE" == "dev" ]]; then
        info "Compiling TypeScript..."
        pnpm run electron:compile
        success "Development build ready"
    else
        info "Compiling and Packaging..."
        pnpm run electron:compile
        pnpm run build
        
        # Copy engine binary
        local resources_dir="$APP_DIR/build/resources/bin"
        mkdir -p "$resources_dir"
        if [[ -f "$ENGINE_BINARY" ]]; then
            cp "$ENGINE_BINARY" "$resources_dir/vayu-engine"
            chmod +x "$resources_dir/vayu-engine"
        fi
        
        pnpm run electron:pack
        
        # Artifacts copy logic
        if [[ -n "$ARTIFACTS_DIR" ]]; then
            mkdir -p "$ARTIFACTS_DIR"
            cp "$APP_DIR/release"/*.{AppImage,deb,rpm} "$ARTIFACTS_DIR/" 2>/dev/null || true
        fi
        success "Production build complete"
    fi
}

# Main execution
main() {
    local start_time=$(date +%s)
    
    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   Vayu Build Script for Linux          ║${NC}"
    echo -e "${CYAN}║   Mode: $(printf '%-30s' "${BUILD_MODE^^}") ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════╝${NC}"
    echo ""
    
    check_prerequisites
    
    ENGINE_BINARY=""
    
    # Engine Build Logic
    if [[ "$SKIP_ENGINE" == false ]]; then
        build_engine
    else
        # Find existing binary if skipping build
        if [[ "$BUILD_MODE" == "prod" ]]; then
            ENGINE_BINARY="$ENGINE_DIR/build-release/vayu-engine"
        else
            ENGINE_BINARY="$ENGINE_DIR/build/vayu-engine"
        fi
    fi
    
    # App Build Logic
    if [[ "$SKIP_APP" == false ]]; then
        build_electron
    fi
    
    local end_time=$(date +%s)
    local elapsed=$((end_time - start_time))
    
    echo ""
    success "Build completed successfully in ${elapsed}s"
    echo ""
    echo "To run the application, copy and paste the command below:"
    echo ""

    # ---------------------------------------------------------
    # IMPROVED POST-BUILD MESSAGE LOGIC
    # ---------------------------------------------------------

    if [[ "$BUILD_MODE" == "dev" ]]; then
        # DEV MODE: Calculate relative path from LAUNCH directory to App Directory
        local rel_app_path=$(get_relative_path "$APP_DIR")
        
        echo -e "${CYAN}  cd ./$rel_app_path && pnpm run electron:dev${NC}"
        
    else
        # PROD MODE: Find the AppImage and give relative path from LAUNCH directory
        local release_dir="$APP_DIR/release"
        
        # Try to find an AppImage first (easiest to run)
        local app_image=$(find "$release_dir" -name "*.AppImage" 2>/dev/null | head -n 1)
        
        if [[ -n "$app_image" ]]; then
            local rel_img_path=$(get_relative_path "$app_image")
            echo -e "${CYAN}  ./$rel_img_path${NC}"
        else
            # Fallback if no AppImage, try deb
            local deb_pkg=$(find "$release_dir" -name "*.deb" 2>/dev/null | head -n 1)
            if [[ -n "$deb_pkg" ]]; then
                local rel_deb_path=$(get_relative_path "$deb_pkg")
                echo -e "  (Install .deb): ${CYAN}sudo dpkg -i ./$rel_deb_path${NC}"
            else
                 echo -e "${YELLOW}  No build artifacts found in $release_dir${NC}"
            fi
        fi
    fi
    echo ""
}

# Run main
if ! main; then
    echo -e "${RED}Build failed!${NC}"
    exit 1
fi
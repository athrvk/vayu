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
    echo -e "${CYAN}Vayu Build Script for Linux${NC}"
    echo ""
    echo "Usage: ./build-linux.sh [dev|prod] [-e|-a] [OPTIONS]"
    echo ""
    echo "Build Mode:"
    echo "  dev     Development build (Debug mode)"
    echo "  prod    Production build (Release mode, default)"
    echo ""
    echo "Component Selection (shortcuts):"
    echo "  -e, --skip-app      Build only the C++ engine"
    echo "  -a, --skip-engine   Build only the Electron app"
    echo "  (no flag)           Build both engine and app"
    echo ""
    echo "Other Options:"
    echo "  --clean             Clean build directories before building"
    echo "  -v, --verbose       Show detailed output when build fails"
    echo "  --vcpkg-root PATH   Override vcpkg root directory"
    echo "  --artifacts PATH    Copy build artifacts to this directory (for CI)"
    echo "  -h, --help          Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./build-linux.sh              # Build all (prod)"
    echo "  ./build-linux.sh dev          # Build all (dev)"
    echo "  ./build-linux.sh -e           # Build engine only (prod)"
    echo "  ./build-linux.sh dev -e       # Build engine only (dev)"
    echo "  ./build-linux.sh -a           # Build app only (prod)"
    echo "  ./build-linux.sh -a --clean   # Build app only, clean first"
    echo ""
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

    # Determine what we're building
    build_components=()
    if [[ "$SKIP_ENGINE" == false ]]; then build_components+=("Engine"); fi
    if [[ "$SKIP_APP" == false ]]; then build_components+=("App"); fi
    local components_str=$(echo ${build_components[*]} | tr ' ' '+')
    if [[ ${#build_components[@]} -eq 0 ]]; then
        error "Nothing to build! Use -h for help."
    fi
    
    echo ""
    echo -e "${CYAN}╔═════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   Vayu Build Script for Linux   ║${NC}"
    echo -e "${CYAN}║   Mode: $(printf "${BUILD_MODE^^}") | $components_str       ║${NC}"
    echo -e "${CYAN}╚═════════════════════════════════╝${NC}"
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
        # PROD MODE: Find artifacts and give clear install/run instructions
        local release_dir="$APP_DIR/release"

        # Try to find AppImage and deb packages
        local app_image=$(find "$release_dir" -name "*.AppImage" 2>/dev/null | head -n 1)
        local deb_pkg=$(find "$release_dir" -name "*.deb" 2>/dev/null | head -n 1)

        if [[ -n "$app_image" ]]; then
            local rel_img_path=$(get_relative_path "$app_image")
            echo -e "${CYAN}Run AppImage:${NC} ./$rel_img_path"
            echo ""
            echo -e "Notes for AppImage:" 
            echo " - AppImages require FUSE at runtime on many systems (libfuse.so.2)."
            echo -e "   If you see 'dlopen(): error loading libfuse.so.2', install it: ${CYAN}sudo apt update && sudo apt install libfuse2${NC}"
            echo -e " - On systems without FUSE (some WSL installations), the AppImage may not run. Consider installing the .deb package instead."
            echo -e " - You can extract the AppImage contents without FUSE: ${CYAN}./$(basename "$app_image") --appimage-extract && ./squashfs-root/AppRun${NC}"
            echo ""
        fi

        if [[ -n "$deb_pkg" ]]; then
            local rel_deb_path=$(get_relative_path "$deb_pkg")
            echo -e "${CYAN}Install .deb package (recommended if AppImage fails):${NC}"
            echo -e "  sudo dpkg -i ./$rel_deb_path"
            echo -e "  # then fix dependencies if needed: sudo apt-get install -f"
            echo ""
            echo -e "Alternative (modern apt): ${CYAN}sudo apt install ././$rel_deb_path${NC}"
            echo ""
        fi

        if [[ -z "$app_image" && -z "$deb_pkg" ]]; then
            echo -e "${YELLOW}  No build artifacts found in $release_dir${NC}"
        fi
    fi
    echo ""
}

# Run main
if ! main; then
    echo -e "${RED}Build failed!${NC}"
    exit 1
fi
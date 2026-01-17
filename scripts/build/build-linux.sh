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
VERBOSE_OUTPUT=false
VCPKG_ROOT_OVERRIDE=""
ARTIFACTS_DIR=""

# Parse arguments
show_help() {
    echo "Vayu Build Script for Linux"
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
    echo "CI/Advanced options:"
    echo "  --vcpkg-root PATH   Override vcpkg root directory"
    echo "  --artifacts PATH    Output installer artifacts to this directory"
    echo ""
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        dev|prod)
            BUILD_MODE="$1"
            shift
            ;;
        -e|--skip-app)
            SKIP_APP=true
            SKIP_ENGINE=false
            shift
            ;;
        -a|--skip-engine)
            SKIP_ENGINE=true
            SKIP_APP=false
            shift
            ;;
        --clean)
            CLEAN_BUILD=true
            shift
            ;;
        -v|--verbose)
            VERBOSE_OUTPUT=true
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
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
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
    if [[ "$VERBOSE_OUTPUT" == true ]]; then
        # In verbose mode, show all output
        cmake -GNinja \
              -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
              -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
              -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
              -DVCPKG_MANIFEST_MODE=ON \
              -DVAYU_BUILD_TESTS=OFF \
              -DVAYU_BUILD_CLI=OFF \
              -DVAYU_BUILD_ENGINE=ON \
              .. 2>&1 | tee /tmp/cmake_config_output.log
        CMAKE_CONFIG_EXIT=${PIPESTATUS[0]}
    else
        # In normal mode, capture output silently
        cmake -GNinja \
              -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
              -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
              -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
              -DVCPKG_MANIFEST_MODE=ON \
              -DVAYU_BUILD_TESTS=OFF \
              -DVAYU_BUILD_CLI=OFF \
              -DVAYU_BUILD_ENGINE=ON \
              .. > /tmp/cmake_config_output.log 2>&1
        CMAKE_CONFIG_EXIT=$?
    fi
    
    if [[ $CMAKE_CONFIG_EXIT -ne 0 ]]; then
        if [[ "$VERBOSE_OUTPUT" == true ]]; then
            echo ""
            echo "╔════════════════════════════════════════╗"
            echo "║   CMake Configuration Failed!         ║"
            echo "╚════════════════════════════════════════╝"
            echo ""
            echo "CMake output:"
            cat /tmp/cmake_config_output.log
            echo ""
        fi
        error "CMake configuration failed with exit code $CMAKE_CONFIG_EXIT"
    fi
    
    # Build
    info "Building..."
    local cores=$(nproc 2>/dev/null || echo 4)
    if [[ "$VERBOSE_OUTPUT" == true ]]; then
        # In verbose mode, show output in real-time
        cmake --build . -j "$cores" 2>&1 | tee /tmp/cmake_build_output.log
        CMAKE_BUILD_EXIT=${PIPESTATUS[0]}
    else
        # In normal mode, capture silently
        cmake --build . -j "$cores" > /tmp/cmake_build_output.log 2>&1
        CMAKE_BUILD_EXIT=$?
    fi
    
    if [[ $CMAKE_BUILD_EXIT -ne 0 ]]; then
        if [[ "$VERBOSE_OUTPUT" == true ]]; then
            echo ""
            echo "╔════════════════════════════════════════╗"
            echo "║   Build Failed!                        ║"
            echo "╚════════════════════════════════════════╝"
            echo ""
            
            # Extract and highlight error lines
            echo "Error summary (lines containing 'error' or 'failed'):"
            echo ""
            grep -i "error\|failed" /tmp/cmake_build_output.log | head -20 || true
            echo ""
            
            # Show last 50 lines for context
            echo "Last 50 lines of build output:"
            echo ""
            tail -50 /tmp/cmake_build_output.log | while IFS= read -r line; do
                if echo "$line" | grep -qi "error\|failed"; then
                    echo -e "${RED}$line${NC}"
                else
                    echo "$line"
                fi
            done
            echo ""
        fi
        error "Build failed with exit code $CMAKE_BUILD_EXIT"
    fi
    
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
    echo "║   Build completed successfully in ${elapsed}s          ║"
    echo "╚════════════════════════════════════════╝"
    echo ""
    
    if [[ "$BUILD_MODE" == "dev" ]]; then
        # Calculate relative path to app dir from current location for easy copy-paste
        local current_dir=$(pwd)
        local relative_app_path
        if command -v realpath &>/dev/null; then
            relative_app_path=$(realpath --relative-to="$current_dir" "$APP_DIR" 2>/dev/null || echo "$APP_DIR")
        else
            # Fallback: use Python to calculate relative path
            relative_app_path=$(python3 -c "import os; print(os.path.relpath('$APP_DIR', '$current_dir'))" 2>/dev/null || echo "$APP_DIR")
        fi
        
        echo "To start the Electron app in development mode:"
        echo ""
        echo "    cd $relative_app_path; pnpm run electron:dev"
        echo ""
    else
        echo "Production build created:"
        echo ""
        local release_dir="$APP_DIR/release"
        local has_appimage=false
        local has_deb=false
        local has_rpm=false
        local appimage_files=()
        local deb_files=()
        local rpm_files=()
        
        if [[ -d "$release_dir" ]]; then
            # Check what files exist and list them
            appimage_files=($(ls -1 "$release_dir"/*.AppImage 2>/dev/null || true))
            if [[ ${#appimage_files[@]} -gt 0 ]]; then
                has_appimage=true
                for f in "${appimage_files[@]}"; do echo "   $f"; done
            fi
            
            deb_files=($(ls -1 "$release_dir"/*.deb 2>/dev/null || true))
            if [[ ${#deb_files[@]} -gt 0 ]]; then
                has_deb=true
                for f in "${deb_files[@]}"; do echo "   $f"; done
            fi
            
            rpm_files=($(ls -1 "$release_dir"/*.rpm 2>/dev/null || true))
            if [[ ${#rpm_files[@]} -gt 0 ]]; then
                has_rpm=true
                for f in "${rpm_files[@]}"; do echo "   $f"; done
            fi
        fi
        
        echo ""
        echo "To install and launch Vayu:"
        
        if [[ "$has_appimage" == true ]] || [[ "$has_deb" == true ]] || [[ "$has_rpm" == true ]]; then
            echo "  1. Install using one of the following methods:"
            echo ""
            
            if [[ "$has_appimage" == true ]] && [[ ${#appimage_files[@]} -gt 0 ]]; then
                local appimage_name=$(basename "${appimage_files[0]}")
                echo "     AppImage (portable, no installation needed):"
                echo "       chmod +x \"$appimage_name\" && ./\"$appimage_name\""
                echo ""
            fi
            
            if [[ "$has_deb" == true ]] && [[ ${#deb_files[@]} -gt 0 ]]; then
                local deb_name=$(basename "${deb_files[0]}")
                echo "     Debian/Ubuntu (.deb package):"
                echo "       sudo dpkg -i \"$deb_name\""
                echo ""
            fi
            
            if [[ "$has_rpm" == true ]] && [[ ${#rpm_files[@]} -gt 0 ]]; then
                local rpm_name=$(basename "${rpm_files[0]}")
                echo "     Red Hat/Fedora (.rpm package):"
                echo "       sudo rpm -i \"$rpm_name\""
                echo ""
            fi
        else
            echo "  1. Install the generated package from the release directory."
            echo ""
        fi
        
        echo "  2. After installation, launch 'Vayu' from your applications menu."
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

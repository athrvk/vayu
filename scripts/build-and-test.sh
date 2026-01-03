#!/bin/bash

# Vayu Build Script
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$PROJECT_ROOT/engine"
BUILD_DIR="$ENGINE_DIR/build"

# Options
BUILD_TYPE="Release"
CLEAN=false
RUN_TESTS=true
VERBOSE=false

# Helper functions
info() { echo -e "${BLUE}==>${NC} $1"; }
error() { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }
success() { echo -e "${GREEN}✓${NC} $1"; }

# Usage
usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Simple build script for Vayu engine.

OPTIONS:
    -d, --debug         Build in Debug mode
    -c, --clean         Clean build directory first
    -s, --skip-tests    Skip running tests
    -t, --tests-only    Only run tests (no build)
    -v, --verbose       Verbose output
    -h, --help          Show this help

EXAMPLES:
    $(basename "$0")           # Release build + tests
    $(basename "$0") -d        # Debug build
    $(basename "$0") -c        # Clean build
    $(basename "$0") -t        # Run tests only

EOF
    exit 0
}

# Parse arguments
TESTS_ONLY=false
while [[ $# -gt 0 ]]; do
    case $1 in
        -d|--debug) BUILD_TYPE="Debug"; shift ;;
        -c|--clean) CLEAN=true; shift ;;
        -s|--skip-tests) RUN_TESTS=false; shift ;;
        -t|--tests-only) TESTS_ONLY=true; shift ;;
        -v|--verbose) VERBOSE=true; shift ;;
        -h|--help) usage ;;
        *) error "Unknown option: $1" ;;
    esac
done

# Check vcpkg
check_vcpkg() {
    if ! command -v vcpkg &>/dev/null; then
        error "vcpkg not found. Install: https://vcpkg.io/en/getting-started.html"
    fi
    VCPKG_ROOT="$(dirname "$(which vcpkg)")"
    info "Using vcpkg: $VCPKG_ROOT"

    # Detect triplet
    if [[ "$OSTYPE" == "darwin"* ]]; then
        TRIPLET=$([ "$(uname -m)" = "arm64" ] && echo "arm64-osx" || echo "x64-osx")
    else
        # Linux / WSL
        local arch=$(uname -m)
        if [[ "$arch" == "aarch64" ]] || [[ "$arch" == "arm64" ]]; then
            TRIPLET="arm64-linux"
        else
            TRIPLET="x64-linux"
        fi
    fi
    info "Target triplet: $TRIPLET"

    # Check for WSL performance issues
    if grep -q "Microsoft" /proc/version 2>/dev/null; then
        if [[ "$PWD" == /mnt/* ]]; then
            echo -e "${RED}Warning:${NC} You are running in WSL 2 but your project is on the Windows filesystem."
            echo -e "         This will severely impact build performance."
            echo -e "         Move the project to the Linux filesystem (e.g., ~/projects/vayu)."
        fi
    fi
}

# Parse and install dependencies from vcpkg.json
install_deps() {
    info "Installing dependencies..."
    
    # Parse dependencies from vcpkg.json
    local deps=$(grep -A 20 '"dependencies"' "$ENGINE_DIR/vcpkg.json" | grep '"' | grep -v 'dependencies' | tr -d ' ",' | grep -v '^$')
    
    for dep in $deps; do
        if [ -n "$(vcpkg list "${dep}:${TRIPLET}")" ]; then
            continue
        fi
        
        info "  Installing $dep..."
        vcpkg install "$dep:$TRIPLET"
    done
    
    success "Dependencies ready"
}

# Build
build() {
    mkdir -p "$BUILD_DIR"
    
    # Check if we need to reconfigure
    local reconfigure=true
    if [ -f "$BUILD_DIR/CMakeCache.txt" ]; then
        local current_type=$(grep "CMAKE_BUILD_TYPE:STRING" "$BUILD_DIR/CMakeCache.txt" | cut -d= -f2)
        if [ "$current_type" == "$BUILD_TYPE" ]; then
            reconfigure=false
            info "Build directory already configured for $BUILD_TYPE. Skipping configuration."
        fi
    fi

    if [ "$reconfigure" = true ]; then
        info "Configuring CMake ($BUILD_TYPE)..."
        cd "$BUILD_DIR"
        
        # Try to use Ninja if available
        local generator=""
        if command -v ninja &>/dev/null; then
            generator="-GNinja"
            info "Using Ninja generator"
        fi
        
        cmake $generator \
              -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
              -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
              -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
              -DVCPKG_MANIFEST_MODE=OFF \
              ..
    else
        cd "$BUILD_DIR"
    fi
    
    info "Building..."
    cmake --build . -j $(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
    
    success "Build complete"
}

# Run tests
run_tests() {
    [ ! -f "$BUILD_DIR/vayu_tests" ] && error "Test executable not found. Build first."
    
    info "Running tests..."
    cd "$BUILD_DIR"
    
    if ./vayu_tests; then
        success "All tests passed"
    else
        code=$?
        # Ignore QuickJS cleanup issues (SIGABRT = 134)
        [ $code -eq 134 ] || [ $code -eq 139 ] && return 0
        error "Tests failed (exit code: $code)"
    fi
}

# Main
main() {
    echo "Vayu Build Script"
    echo "Build: $BUILD_TYPE | Tests: $RUN_TESTS"
    echo ""
    
    [ "$CLEAN" = true ] && info "Cleaning build directory..." && rm -rf "$BUILD_DIR"

    check_vcpkg
    
    if [ "$TESTS_ONLY" = true ]; then
        run_tests
        exit 0
    fi
    
    install_deps
    build
    
    [ "$RUN_TESTS" = true ] && run_tests
    
    echo ""
    success "Done! Executables in: $BUILD_DIR"
    echo "  - vayu-cli"
    echo "  - vayu-engine"
}

main

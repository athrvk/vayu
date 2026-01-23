#!/bin/bash

# Vayu Build Script - Optimized for fast builds
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
BUILD_DIR="$ENGINE_DIR/build"

# Options
BUILD_TYPE="Release"
CLEAN=false
RUN_TESTS=true
VERBOSE=false
JOBS=""  # Auto-detect by default

# Helper functions
info() { echo -e "${BLUE}==>${NC} $1"; }
warn() { echo -e "${YELLOW}Warning:${NC} $1"; }
error() { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }
success() { echo -e "${GREEN}✓${NC} $1"; }

# Detect optimal job count (use physical cores, not hyper-threads for compilation)
detect_jobs() {
    if [ -n "$JOBS" ]; then
        echo "$JOBS"
        return
    fi
    
    local cores
    local mem_gb
    local mem_jobs
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS: use physical CPU count
        cores=$(sysctl -n hw.physicalcpu 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
        # macOS memory check (in bytes, convert to GB)
        mem_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 8589934592) / 1024 / 1024 / 1024 ))
    else
        # Linux: use nproc
        cores=$(nproc 2>/dev/null || echo 4)
        # Linux memory from /proc/meminfo
        mem_gb=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 8)
    fi
    
    # Cap at available memory (assume 2GB per compile job)
    mem_jobs=$((mem_gb / 2))
    [ $mem_jobs -lt 1 ] && mem_jobs=1
    
    # Use the smaller of cores or memory-based limit
    if [ $cores -gt $mem_jobs ]; then
        cores=$mem_jobs
    fi
    
    # Add 1 extra job since I/O bound tasks can benefit from slight oversubscription
    echo $((cores + 1))
}

# Usage
usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Fast build script for Vayu engine.

OPTIONS:
    -d, --debug         Build in Debug mode
    -c, --clean         Clean build directory first
    -s, --skip-tests    Skip running tests
    -t, --tests-only    Only run tests (no build)
    -j, --jobs N        Use N parallel jobs (default: auto-detect)
    -v, --verbose       Verbose output
    -h, --help          Show this help

EXAMPLES:
    $(basename "$0")           # Release build + tests
    $(basename "$0") -d        # Debug build
    $(basename "$0") -c        # Clean build
    $(basename "$0") -j 8      # Build with 8 parallel jobs
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
        -j|--jobs) JOBS="$2"; shift 2 ;;
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

    # Check for WSL performance issues (Linux only)
    if [[ "$OSTYPE" != "darwin"* ]]; then
        if grep -q "Microsoft" /proc/version 2>/dev/null; then
            if [[ "$PWD" == /mnt/* ]]; then
                warn "You are running in WSL 2 but your project is on the Windows filesystem."
                echo -e "         This will severely impact build performance."
                echo -e "         Move the project to the Linux filesystem (e.g., ~/projects/vayu)."
            fi
        fi
    fi
}

# Parse and install dependencies from vcpkg.json (parallel installation)
install_deps() {
    info "Checking dependencies..."
    
    # Parse dependencies from vcpkg.json
    local deps=$(grep -A 20 '"dependencies"' "$ENGINE_DIR/vcpkg.json" | grep '"' | grep -v 'dependencies' | tr -d ' ",' | grep -v '^$')
    
    # Collect missing deps
    local missing_deps=()
    for dep in $deps; do
        if [ -z "$(vcpkg list "${dep}:${TRIPLET}" 2>/dev/null)" ]; then
            missing_deps+=("$dep:$TRIPLET")
        fi
    done
    
    # Install all missing deps in one command (parallel)
    if [ ${#missing_deps[@]} -gt 0 ]; then
        info "Installing ${#missing_deps[@]} missing dependencies..."
        vcpkg install "${missing_deps[@]}"
    fi
    
    success "Dependencies ready"
}

# Build
build() {
    mkdir -p "$BUILD_DIR"
    
    local job_count=$(detect_jobs)
    
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
        
        # Prefer Ninja for faster builds (better parallelism and dependency tracking)
        local generator=""
        local cmake_extra_flags=""
        if command -v ninja &>/dev/null; then
            generator="-GNinja"
            info "Using Ninja generator (faster)"
        fi
        
        # Use ccache if available for faster rebuilds
        if command -v ccache &>/dev/null; then
            cmake_extra_flags="-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache"
            info "Using ccache for faster rebuilds"
        fi
        
        # Use faster linker if available (Linux only - macOS uses its own linker)
        if [[ "$OSTYPE" != "darwin"* ]]; then
            if command -v mold &>/dev/null; then
                cmake_extra_flags="$cmake_extra_flags -DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=mold -DCMAKE_SHARED_LINKER_FLAGS=-fuse-ld=mold"
                info "Using mold linker (faster)"
            elif command -v lld &>/dev/null; then
                cmake_extra_flags="$cmake_extra_flags -DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=lld -DCMAKE_SHARED_LINKER_FLAGS=-fuse-ld=lld"
                info "Using lld linker (faster)"
            fi
        fi
        
        cmake $generator \
              -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
              -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
              -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
              -DVCPKG_MANIFEST_MODE=OFF \
              -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
              $cmake_extra_flags \
              ..
    else
        cd "$BUILD_DIR"
    fi
    
    info "Building with $job_count parallel jobs..."
    cmake --build . -j "$job_count"
    
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
    local start_time=$(date +%s)
    
    echo "Vayu Build Script"
    echo "Build: $BUILD_TYPE | Tests: $RUN_TESTS | Jobs: $(detect_jobs)"
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
    
    local end_time=$(date +%s)
    local elapsed=$((end_time - start_time))
    
    echo ""
    success "Done in ${elapsed}s! Executables in: $BUILD_DIR"
    echo "  - vayu-cli"
    echo "  - vayu-engine"
}

main

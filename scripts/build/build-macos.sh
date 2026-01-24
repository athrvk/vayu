#!/bin/bash

# Vayu Build Script for macOS
# Usage: ./build-macos.sh [dev|prod] [OPTIONS]
# 
# This script builds the C++ engine and Electron app for macOS
# - dev:  Development build with debug symbols
# - prod: Production build optimized and packaged as DMG
#
# Quick aliases:
#   ./build-macos.sh -e         # Build only engine (prod)
#   ./build-macos.sh -a         # Build only app (prod)
#   ./build-macos.sh dev -e     # Build only engine (dev)
#   ./build-macos.sh dev -a     # Build only app (dev)

set -e

# Store original working directory for relative path calculations
ORIGINAL_CWD="$(pwd)"

# Colors for output (consistent across platforms)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Step counter for progress tracking
CURRENT_STEP=0
TOTAL_STEPS=0

# Helper functions (consistent style)
info()    { echo -e "${CYAN}  ▶${NC} $1"; }
detail()  { echo -e "${DIM}    $1${NC}"; }
warn()    { echo -e "${YELLOW}  ⚠${NC} ${YELLOW}$1${NC}"; }
error()   { echo -e "${RED}  ✗${NC} ${RED}$1${NC}" >&2; exit 1; }
success() { echo -e "${GREEN}  ✓${NC} $1"; }

# Step function with progress indicator
step() {
    ((CURRENT_STEP++))
    echo ""
    echo -e "${BOLD}${CYAN}[$CURRENT_STEP/$TOTAL_STEPS]${NC} ${BOLD}$1${NC}"
    echo -e "${DIM}$( printf '%*s' 60 | tr ' ' '─' )${NC}"
}

# Default values
BUILD_MODE="prod"
SKIP_ENGINE=false
SKIP_APP=false
CLEAN_BUILD=false
VERBOSE_OUTPUT=false
BUILD_TESTS=false
VCPKG_ROOT_OVERRIDE=""
ARTIFACTS_DIR=""

# Parse arguments
show_help() {
    echo "Vayu Build Script for macOS"
    echo ""
    echo "Usage: ./build-macos.sh [dev|prod] [-e|-a] [OPTIONS]"
    echo ""
    echo "Build Mode:"
    echo "  dev                 Development build (Debug mode)"
    echo "  prod                Production build (Release mode, default)"
    echo ""
    echo "Component Selection:"
    echo "  -e, --skip-app      Build only the C++ engine"
    echo "  -a, --skip-engine   Build only the Electron app"
    echo "  (no flag)           Build both engine and app"
    echo ""
    echo "Other Options:"
    echo "  --clean             Clean build directories before building"
    echo "  --with-tests        Build and run unit tests (for CI)"
    echo "  -v, --verbose       Show detailed output when build fails"
    echo "  -h, --help          Show this help message"
    echo ""
    echo "CI/Advanced Options:"
    echo "  --vcpkg-root PATH   Override vcpkg root directory"
    echo "  --artifacts PATH    Copy build artifacts to this directory"
    echo ""
    echo "Examples:"
    echo "  ./build-macos.sh                        # Build all (prod)"
    echo "  ./build-macos.sh dev                    # Build all (dev)"
    echo "  ./build-macos.sh -e                     # Build engine only (prod)"
    echo "  ./build-macos.sh dev -e                 # Build engine only (dev)"
    echo "  ./build-macos.sh -a                     # Build app only (prod)"
    echo "  ./build-macos.sh -e --with-tests        # Build engine + run tests"
    echo "  ./build-macos.sh -a --clean             # Build app only, clean first"
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
        --with-tests)
            BUILD_TESTS=true
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

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    error "This script is for macOS only"
fi

# Check prerequisites
check_prerequisites() {
    local missing=()
    
    # Check cmake
    if command -v cmake &>/dev/null; then
        detail "CMake: $(cmake --version | head -n1)"
    else
        missing+=("cmake (brew install cmake)")
    fi
    
    # Check ninja
    if command -v ninja &>/dev/null; then
        detail "Ninja: $(ninja --version)"
    else
        missing+=("ninja (brew install ninja)")
    fi
    
    # Check vcpkg
    if [[ -n "$VCPKG_ROOT_OVERRIDE" ]]; then
        VCPKG_ROOT="$VCPKG_ROOT_OVERRIDE"
        detail "vcpkg: $VCPKG_ROOT (override)"
    elif [[ -n "$VCPKG_ROOT" ]] && [[ -d "$VCPKG_ROOT" ]]; then
        detail "vcpkg: $VCPKG_ROOT"
    elif command -v vcpkg &>/dev/null; then
        VCPKG_ROOT="$(dirname "$(which vcpkg)")"
        detail "vcpkg: $VCPKG_ROOT"
    else
        missing+=("vcpkg (https://vcpkg.io/en/getting-started.html)")
    fi
    
    # Check pnpm (only if building app)
    if [[ "$SKIP_APP" == false ]]; then
        if command -v pnpm &>/dev/null; then
            detail "pnpm: $(pnpm --version)"
        else
            missing+=("pnpm (npm install -g pnpm)")
        fi
    fi
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo ""
        for item in "${missing[@]}"; do
            echo -e "${RED}    ✗ Missing: $item${NC}"
        done
        error "Please install missing prerequisites and try again."
    fi
    
    success "All prerequisites found"
}

# Build engine
build_engine() {
    if [[ "$BUILD_MODE" == "dev" ]]; then
        detail "Build type: Debug"
        BUILD_TYPE="Debug"
        BUILD_DIR="$ENGINE_DIR/build"
    else
        detail "Build type: Release"
        BUILD_TYPE="Release"
        BUILD_DIR="$ENGINE_DIR/build-release"
    fi
    
    # Detect architecture
    ARCH=$(uname -m)
    if [[ "$ARCH" == "arm64" ]]; then
        TRIPLET="arm64-osx"
    else
        TRIPLET="x64-osx"
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
    # Determine test flag
    local tests_flag="OFF"
    if [[ "$BUILD_TESTS" == true ]]; then
        tests_flag="ON"
    fi
    
    if [[ "$VERBOSE_OUTPUT" == true ]]; then
        # In verbose mode, show all output
        cmake -GNinja \
              -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
              -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
              -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
              -DVCPKG_MANIFEST_MODE=ON \
              -DVAYU_BUILD_TESTS="$tests_flag" \
              -DVAYU_BUILD_CLI=ON \
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
              -DVAYU_BUILD_TESTS="$tests_flag" \
              -DVAYU_BUILD_CLI=ON \
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
    local cores=$(sysctl -n hw.physicalcpu 2>/dev/null || echo 4)
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
    
    # Verify binaries
    if [[ ! -f "$BUILD_DIR/vayu-engine" ]]; then
        error "Build succeeded but engine binary not found at: $BUILD_DIR/vayu-engine"
    fi
    
    if [[ ! -f "$BUILD_DIR/vayu-cli" ]]; then
        error "Build succeeded but CLI binary not found at: $BUILD_DIR/vayu-cli"
    fi
    
    ENGINE_BINARY="$BUILD_DIR/vayu-engine"
    CLI_BINARY="$BUILD_DIR/vayu-cli"
    success "Engine built successfully: $ENGINE_BINARY"
    success "CLI built successfully: $CLI_BINARY"
    
    # Run tests if enabled
    if [[ "$BUILD_TESTS" == true ]]; then
        info "Running unit tests..."
        local cores=$(sysctl -n hw.physicalcpu 2>/dev/null || echo 4)
        if ! ctest --test-dir "$BUILD_DIR" --output-on-failure -j "$cores"; then
            error "Unit tests failed"
        fi
        success "All unit tests passed"
    fi
}

# Setup application icons
setup_icons() {
    info "Setting up application icons..."
    
    local icon_png_dir="$PROJECT_ROOT/shared/icon_png"
    local build_dir="$APP_DIR/build"
    
    # Ensure build directory exists
    mkdir -p "$build_dir"
    
    # Copy PNG for macOS (512x512 - electron-builder will convert to .icns)
    if [[ -f "$icon_png_dir/vayu_icon_512x512.png" ]]; then
        cp "$icon_png_dir/vayu_icon_512x512.png" "$build_dir/icon.png"
        echo "    icon.png (macOS - will be converted to .icns)"
    fi
    
    # Copy all PNG icon sizes for electron-builder's icon set
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
                cp "$release_dir"/*.dmg "$ARTIFACTS_DIR/" 2>/dev/null || true
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
    
    # Determine what we're building and set total steps
    local build_components=()
    TOTAL_STEPS=1  # Prerequisites always counted
    if [[ "$SKIP_ENGINE" == false ]]; then
        build_components+=("Engine")
        ((TOTAL_STEPS++))
    fi
    if [[ "$SKIP_APP" == false ]]; then
        build_components+=("App")
        ((TOTAL_STEPS++))
    fi
    local components_str=$(echo ${build_components[*]} | tr ' ' '+')
    
    if [[ ${#build_components[@]} -eq 0 ]]; then
        error "Nothing to build! Use -h for help."
    fi
    
    echo ""
    echo -e "${BOLD}${CYAN}"
    echo "  ██████████████████████████████████████"
    echo "  █  VAYU BUILD SCRIPT             █"
    echo "  █  Platform: macOS               █"
    echo "  ██████████████████████████████████████"
    echo -e "${NC}"
    local mode_upper=$(echo "$BUILD_MODE" | tr '[:lower:]' '[:upper:]')
    echo -e "  ${DIM}Mode:${NC} ${BOLD}${mode_upper}${NC}  ${DIM}|${NC}  ${DIM}Components:${NC} ${BOLD}$components_str${NC}"
    
    # Step 1: Prerequisites
    step "Checking Prerequisites"
    check_prerequisites
    
    ENGINE_BINARY=""
    
    if [[ "$SKIP_ENGINE" == false ]]; then
        step "Building C++ Engine"
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
        step "Building Electron App"
        build_electron
    else
        warn "Skipping app build"
    fi
    
    local end_time=$(date +%s)
    local elapsed=$((end_time - start_time))
    
    echo ""
    echo -e "${BOLD}${GREEN}"
    echo "  ██████████████████████████████████████"
    echo "  █  BUILD SUCCESSFUL              █"
    echo "  ██████████████████████████████████████"
    echo -e "${NC}"
    echo -e "  ${DIM}Total time:${NC} ${BOLD}${elapsed}s${NC}"
    echo ""
    
    echo -e "  ${BOLD}Build Artifacts:${NC}"
    echo -e "  ${DIM}──────────────────────────────────────${NC}"
    
    # Show engine binary if it was built
    if [[ "$SKIP_ENGINE" == false ]] && [[ -n "$ENGINE_BINARY" ]] && [[ -f "$ENGINE_BINARY" ]]; then
        echo -e "  ${GREEN}✓${NC} Engine: ${CYAN}$ENGINE_BINARY${NC}"
    fi
    
    # Show app artifacts if app was built
    if [[ "$SKIP_APP" == false ]]; then
        if [[ "$BUILD_MODE" == "dev" ]]; then
            echo -e "  ${GREEN}✓${NC} App: Development build ready"
        else
            local release_dir="$APP_DIR/release"
            if [[ -d "$release_dir" ]]; then
                while IFS= read -r f; do
                    echo -e "  ${GREEN}✓${NC} Installer: ${CYAN}$f${NC}"
                done < <(ls -1 "$release_dir"/*.dmg 2>/dev/null)
            fi
        fi
    fi
    
    echo ""
    echo -e "  ${BOLD}Next Steps:${NC}"
    echo -e "  ${DIM}──────────────────────────────────────${NC}"
    
    # Helper to calculate relative path from original working directory (pure bash)
    get_relative_path() {
        local target="$1"
        local source="$ORIGINAL_CWD"
        
        # Normalize paths (remove trailing slashes)
        target="${target%/}"
        source="${source%/}"
        
        # If paths are identical, return "."
        if [[ "$target" == "$source" ]]; then
            echo "."
            return
        fi
        
        # Split paths into arrays
        local IFS='/'
        read -ra target_parts <<< "$target"
        read -ra source_parts <<< "$source"
        
        # Find common prefix length
        local common=0
        local max=${#source_parts[@]}
        [[ ${#target_parts[@]} -lt $max ]] && max=${#target_parts[@]}
        
        for ((i=0; i<max; i++)); do
            if [[ "${target_parts[$i]}" != "${source_parts[$i]}" ]]; then
                break
            fi
            ((common++))
        done
        
        # Build relative path
        local result=""
        
        # Add ".." for each remaining source directory
        for ((i=common; i<${#source_parts[@]}; i++)); do
            if [[ -n "$result" ]]; then
                result="$result/.."
            else
                result=".."
            fi
        done
        
        # Add remaining target directories
        for ((i=common; i<${#target_parts[@]}; i++)); do
            if [[ -n "$result" ]]; then
                result="$result/${target_parts[$i]}"
            else
                result="${target_parts[$i]}"
            fi
        done
        
        echo "$result"
    }
    
    # Helper to format executable path (add ./ only for relative paths)
    format_executable_path() {
        local path="$1"
        if [[ "$path" == /* ]]; then
            # Absolute path - use as-is
            echo "$path"
        elif [[ "$path" != ./* ]]; then
            # Relative path without ./ prefix - add it
            echo "./$path"
        else
            # Already has ./ prefix
            echo "$path"
        fi
    }
    
    if [[ "$BUILD_MODE" == "dev" ]]; then
        if [[ "$SKIP_APP" == false ]]; then
            # Calculate relative path from original working directory
            local relative_app_path
            relative_app_path=$(get_relative_path "$APP_DIR")
            echo -e "  Run the Electron app in development mode:"
            echo -e "    ${CYAN}cd $relative_app_path && pnpm run electron:dev${NC}"
        else
            # Calculate relative path to engine binary
            local relative_engine_path
            relative_engine_path=$(get_relative_path "$ENGINE_BINARY")
            local exec_path
            exec_path=$(format_executable_path "$relative_engine_path")
            echo -e "  Engine built successfully. Run it with:"
            echo -e "    ${CYAN}$exec_path${NC}"
        fi
    else
        if [[ "$SKIP_APP" == false ]]; then
            local release_dir="$APP_DIR/release"
            local dmg_file=$(ls -1 "$release_dir"/*.dmg 2>/dev/null | head -n 1)
            if [[ -n "$dmg_file" ]]; then
                # Calculate relative path to DMG
                local relative_dmg_path
                relative_dmg_path=$(get_relative_path "$dmg_file")
                echo -e "  1. Open the DMG:"
                echo -e "     ${CYAN}open \"$relative_dmg_path\"${NC}"
                echo -e "  2. Drag Vayu to Applications"
                echo -e "  3. Launch ${BOLD}Vayu${NC} from Applications"
            else
                local relative_release_dir
                relative_release_dir=$(get_relative_path "$release_dir")
                echo -e "  Open the DMG from: ${CYAN}$relative_release_dir${NC}"
            fi
        else
            # Calculate relative path to engine binary
            local relative_engine_path
            relative_engine_path=$(get_relative_path "$ENGINE_BINARY")
            local exec_path
            exec_path=$(format_executable_path "$relative_engine_path")
            echo -e "  Run the engine directly:"
            echo -e "    ${CYAN}$exec_path${NC}"
        fi
    fi
    echo ""
}

# Run main with error handling
if ! main; then
    echo ""
    echo -e "${BOLD}${RED}"
    echo "  ██████████████████████████████████████"
    echo "  █  BUILD FAILED                  █"
    echo "  ██████████████████████████████████████"
    echo -e "${NC}"
    exit 1
fi

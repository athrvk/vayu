#!/bin/bash

# Vayu Version Bump Script
# Usage: ./scripts/bump-version.sh [major|minor|patch] [--dry-run]
#    or: ./scripts/bump-version.sh <version>
#
# Examples:
#   ./scripts/bump-version.sh patch        # 0.1.1 -> 0.1.2
#   ./scripts/bump-version.sh minor        # 0.1.1 -> 0.2.0
#   ./scripts/bump-version.sh major        # 0.1.1 -> 1.0.0
#   ./scripts/bump-version.sh 2.0.0        # Set to specific version
#   ./scripts/bump-version.sh --dry-run    # Show current version

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

info() { echo -e "${BLUE}==>${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}Warning:${NC} $1"; }
error() { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION_FILE="$PROJECT_ROOT/VERSION"
ENGINE_CMAKE="$PROJECT_ROOT/engine/CMakeLists.txt"
ENGINE_VERSION_HPP="$PROJECT_ROOT/engine/include/vayu/version.hpp"
APP_PACKAGE_JSON="$PROJECT_ROOT/app/package.json"

# Read current version
if [[ ! -f "$VERSION_FILE" ]]; then
    error "VERSION file not found at $VERSION_FILE"
fi

CURRENT_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')

# Parse version components
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Parse arguments
DRY_RUN=false
BUMP_TYPE=""
NEW_VERSION=""

for arg in "$@"; do
    case $arg in
        --dry-run|-n)
            DRY_RUN=true
            ;;
        major|minor|patch)
            BUMP_TYPE="$arg"
            ;;
        [0-9]*.[0-9]*.[0-9]*)
            NEW_VERSION="$arg"
            ;;
        -h|--help)
            echo "Vayu Version Bump Script"
            echo ""
            echo "Usage: $0 [major|minor|patch] [--dry-run]"
            echo "   or: $0 <version>"
            echo ""
            echo "Options:"
            echo "  major      Bump major version (x.0.0)"
            echo "  minor      Bump minor version (0.x.0)"
            echo "  patch      Bump patch version (0.0.x)"
            echo "  <version>  Set specific version (e.g., 2.0.0)"
            echo "  --dry-run  Show what would be changed without making changes"
            echo ""
            echo "Current version: $CURRENT_VERSION"
            exit 0
            ;;
        *)
            error "Unknown argument: $arg"
            ;;
    esac
done

# If no action specified, just show current version
if [[ -z "$BUMP_TYPE" && -z "$NEW_VERSION" ]]; then
    echo "Current version: $CURRENT_VERSION"
    echo ""
    echo "Files that contain version:"
    echo "  - $VERSION_FILE"
    echo "  - $ENGINE_CMAKE"
    echo "  - $ENGINE_VERSION_HPP"
    echo "  - $APP_PACKAGE_JSON"
    echo ""
    echo "Run '$0 --help' for usage."
    exit 0
fi

# Calculate new version
if [[ -n "$NEW_VERSION" ]]; then
    # Validate format
    if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        error "Invalid version format: $NEW_VERSION (expected: X.Y.Z)"
    fi
    IFS='.' read -r NEW_MAJOR NEW_MINOR NEW_PATCH <<< "$NEW_VERSION"
elif [[ -n "$BUMP_TYPE" ]]; then
    case $BUMP_TYPE in
        major)
            NEW_MAJOR=$((MAJOR + 1))
            NEW_MINOR=0
            NEW_PATCH=0
            ;;
        minor)
            NEW_MAJOR=$MAJOR
            NEW_MINOR=$((MINOR + 1))
            NEW_PATCH=0
            ;;
        patch)
            NEW_MAJOR=$MAJOR
            NEW_MINOR=$MINOR
            NEW_PATCH=$((PATCH + 1))
            ;;
    esac
    NEW_VERSION="$NEW_MAJOR.$NEW_MINOR.$NEW_PATCH"
fi

echo ""
echo "Version bump: $CURRENT_VERSION -> $NEW_VERSION"
echo ""

if [[ "$DRY_RUN" == true ]]; then
    warn "Dry run mode - no changes will be made"
    echo ""
fi

# Update VERSION file
update_version_file() {
    info "Updating VERSION file..."
    if [[ "$DRY_RUN" == false ]]; then
        echo "$NEW_VERSION" > "$VERSION_FILE"
    fi
    success "VERSION"
}

# Update CMakeLists.txt
update_cmake() {
    info "Updating engine/CMakeLists.txt..."
    if [[ "$DRY_RUN" == false ]]; then
        sed -i "s/VERSION $CURRENT_VERSION/VERSION $NEW_VERSION/" "$ENGINE_CMAKE"
    fi
    success "engine/CMakeLists.txt"
}

# Update version.hpp
update_version_hpp() {
    info "Updating engine/include/vayu/version.hpp..."
    if [[ "$DRY_RUN" == false ]]; then
        sed -i "s/#define VAYU_VERSION_MAJOR $MAJOR/#define VAYU_VERSION_MAJOR $NEW_MAJOR/" "$ENGINE_VERSION_HPP"
        sed -i "s/#define VAYU_VERSION_MINOR $MINOR/#define VAYU_VERSION_MINOR $NEW_MINOR/" "$ENGINE_VERSION_HPP"
        sed -i "s/#define VAYU_VERSION_PATCH $PATCH/#define VAYU_VERSION_PATCH $NEW_PATCH/" "$ENGINE_VERSION_HPP"
        sed -i "s/#define VAYU_VERSION_STRING \"$CURRENT_VERSION\"/#define VAYU_VERSION_STRING \"$NEW_VERSION\"/" "$ENGINE_VERSION_HPP"
    fi
    success "engine/include/vayu/version.hpp"
}

# Update package.json
update_package_json() {
    info "Updating app/package.json..."
    if [[ "$DRY_RUN" == false ]]; then
        # Use node/jq if available, otherwise sed
        if command -v node &>/dev/null; then
            node -e "
                const fs = require('fs');
                const pkg = JSON.parse(fs.readFileSync('$APP_PACKAGE_JSON', 'utf8'));
                pkg.version = '$NEW_VERSION';
                fs.writeFileSync('$APP_PACKAGE_JSON', JSON.stringify(pkg, null, '\t') + '\n');
            "
        else
            sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$APP_PACKAGE_JSON"
        fi
    fi
    success "app/package.json"
}

# Run updates
update_version_file
update_cmake
update_version_hpp
update_package_json

echo ""
if [[ "$DRY_RUN" == true ]]; then
    success "Dry run complete. Run without --dry-run to apply changes."
else
    success "Version bumped to $NEW_VERSION"
    echo ""
    echo "Next steps:"
    echo "  1. Review changes: git diff"
    echo "  2. Commit: git commit -am 'chore: bump version to $NEW_VERSION'"
    echo "  3. Tag: git tag v$NEW_VERSION"
    echo "  4. Push: git push && git push --tags"
fi

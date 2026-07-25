#!/usr/bin/env python3
"""
GitHub Labels Setup Script for Vayu

This script creates and updates labels in the athrvk/vayu repository according
to a semantic labeling system with components, areas, types, priorities, and statuses.

Run: python3 .github/scripts/setup-labels.py
Requires: GITHUB_TOKEN environment variable

Label Structure:
- component:* (where changes land: app, engine, database, ci, build)
- area:* (sub-areas within engine: http, auth, metrics, scripting)
- type:* (kind of change: bug, feature, enhancement, perf, test)
- status:* (workflow state: needs-review, blocked, ready-merge)
- priority:* (urgency: critical, high, low)
- severity:* (impact: blocking)
- Plus special labels: documentation, good first issue, help wanted, dependencies,
  duplicate, wontfix, invalid, question, github_actions, breaking-change,
  flaky, memory-leak, performance, build, ci, correctness

Colors use semantic meaning:
- Warm colors (orange/red): critical components and issues
- Cool colors (blue): app UI and general features
- Gray: sub-areas and infrastructure
- Green: ready/success states
- Red: blocking/urgent states
- Purple: features and help wanted
- Teal: testing and good first issues
"""

import os
import sys
import json
import requests
from typing import Dict, List, Tuple

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
OWNER = "athrvk"
REPO = "vayu"
API_URL = "https://api.github.com"

# Label definitions with colors and descriptions
LABELS = {
    # Component labels - where changes land
    "component:app": {
        "color": "3498DB",  # Blue - UI
        "description": "Changes to the Electron + React UI application"
    },
    "component:engine": {
        "color": "E67E22",  # Orange - core/critical
        "description": "Changes to the C++20 engine (daemon, HTTP server, scripting)"
    },
    "component:database": {
        "color": "E74C3C",  # Red-orange - infrastructure
        "description": "Database schema, SQLite persistence, storage layer"
    },
    "component:ci": {
        "color": "95A5A6",  # Gray - infrastructure
        "description": "GitHub Actions workflows, CI configuration"
    },
    "component:build": {
        "color": "95A5A6",  # Gray - infrastructure
        "description": "Build system, CMake, vcpkg, version management"
    },

    # Area labels - sub-areas within engine
    "area:http": {
        "color": "95A5A6",  # Gray - sub-areas
        "description": "HTTP server, routes, SSE, request/response handling"
    },
    "area:auth": {
        "color": "95A5A6",  # Gray - sub-areas
        "description": "Authentication, OAuth2, authorization logic"
    },
    "area:metrics": {
        "color": "95A5A6",  # Gray - sub-areas
        "description": "Metrics collection, statistics, performance measurement"
    },
    "area:scripting": {
        "color": "95A5A6",  # Gray - sub-areas
        "description": "QuickJS runtime, script execution, pm.* API surface"
    },

    # Type labels - kind of change
    "type:bug": {
        "color": "E74C3C",  # Red
        "description": "Bug fix"
    },
    "type:feature": {
        "color": "8E44AD",  # Purple
        "description": "New user-facing feature"
    },
    "type:enhancement": {
        "color": "3498DB",  # Blue
        "description": "Enhancement to existing feature"
    },
    "type:perf": {
        "color": "E67E22",  # Orange - warning
        "description": "Performance optimization"
    },
    "type:test": {
        "color": "16A085",  # Teal
        "description": "Tests, benchmarks, test infrastructure"
    },

    # Status labels - workflow state
    "status:needs-review": {
        "color": "F39C12",  # Amber - waiting
        "description": "Awaiting review"
    },
    "status:blocked": {
        "color": "C0392B",  # Dark red - urgent
        "description": "Blocked on something"
    },
    "status:ready-merge": {
        "color": "27AE60",  # Green - ready
        "description": "Approved and ready to merge"
    },

    # Priority labels - urgency
    "priority:critical": {
        "color": "C0392B",  # Dark red
        "description": "Critical priority - needs immediate attention"
    },
    "priority:high": {
        "color": "F39C12",  # Amber
        "description": "High priority"
    },
    "priority:low": {
        "color": "27AE60",  # Green
        "description": "Low priority"
    },

    # Severity labels - impact
    "severity:blocking": {
        "color": "E74C3C",  # Red
        "description": "Breaking change or blocking issue"
    },

    # Special labels
    "documentation": {
        "color": "3498DB",  # Blue
        "description": "Documentation, guides, examples"
    },
    "good first issue": {
        "color": "16A085",  # Teal
        "description": "Good for newcomers to tackle"
    },
    "help wanted": {
        "color": "8E44AD",  # Purple
        "description": "Extra attention or help needed"
    },
    "dependencies": {
        "color": "95A5A6",  # Gray
        "description": "Dependency updates"
    },
    "duplicate": {
        "color": "BBBFC4",  # Light gray
        "description": "This issue or PR already exists"
    },
    "wontfix": {
        "color": "BBBFC4",  # Light gray
        "description": "This will not be worked on"
    },
    "invalid": {
        "color": "BBBFC4",  # Light gray
        "description": "Invalid or incomplete"
    },
    "question": {
        "color": "D4AF37",  # Gold
        "description": "Further information is requested"
    },
    "github_actions": {
        "color": "95A5A6",  # Gray
        "description": "GitHub Actions related"
    },
    "breaking-change": {
        "color": "E74C3C",  # Red
        "description": "Breaking change - major version bump"
    },
    "flaky": {
        "color": "E67E22",  # Orange
        "description": "Flaky test or unreliable behavior"
    },
    "memory-leak": {
        "color": "E74C3C",  # Red
        "description": "Memory leak detected"
    },
    "performance": {
        "color": "E67E22",  # Orange
        "description": "Performance-related issue"
    },
    "scripting": {
        "color": "95A5A6",  # Gray
        "description": "QuickJS scripting engine"
    },
    "build": {
        "color": "95A5A6",  # Gray
        "description": "Build-related (use component:build for path-based)"
    },
    "ci": {
        "color": "95A5A6",  # Gray
        "description": "CI/CD related (use component:ci for path-based)"
    },
    "correctness": {
        "color": "E74C3C",  # Red
        "description": "Correctness issue"
    },
}


def get_headers() -> Dict[str, str]:
    """Get headers for GitHub API requests."""
    if not GITHUB_TOKEN:
        print("Error: GITHUB_TOKEN environment variable not set")
        sys.exit(1)
    return {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    }


def get_existing_labels() -> Dict[str, Dict]:
    """Fetch existing labels from the repository."""
    url = f"{API_URL}/repos/{OWNER}/{REPO}/labels"
    labels = {}
    page = 1

    while True:
        response = requests.get(url, headers=get_headers(), params={"page": page, "per_page": 100})
        if response.status_code != 200:
            print(f"Error fetching labels: {response.status_code}")
            print(response.text)
            return labels

        data = response.json()
        if not data:
            break

        for label in data:
            labels[label["name"]] = label

        page += 1

    return labels


def create_label(name: str, color: str, description: str) -> Tuple[bool, str]:
    """Create a new label."""
    url = f"{API_URL}/repos/{OWNER}/{REPO}/labels"
    payload = {
        "name": name,
        "color": color,
        "description": description,
    }

    response = requests.post(url, headers=get_headers(), json=payload)

    if response.status_code == 201:
        return True, f"Created: {name}"
    elif response.status_code == 422:
        # Label already exists, try to update
        return update_label(name, color, description)
    else:
        return False, f"Error creating {name}: {response.status_code} - {response.text}"


def update_label(name: str, color: str, description: str) -> Tuple[bool, str]:
    """Update an existing label."""
    url = f"{API_URL}/repos/{OWNER}/{REPO}/labels/{name}"
    payload = {
        "color": color,
        "description": description,
    }

    response = requests.patch(url, headers=get_headers(), json=payload)

    if response.status_code == 200:
        return True, f"Updated: {name}"
    else:
        return False, f"Error updating {name}: {response.status_code} - {response.text}"


def main():
    """Create or update all labels."""
    print(f"Setting up labels for {OWNER}/{REPO}...\n")

    existing = get_existing_labels()
    print(f"Found {len(existing)} existing labels\n")

    created = 0
    updated = 0
    failed = 0

    for name, config in sorted(LABELS.items()):
        if name in existing:
            # Check if update is needed
            existing_label = existing[name]
            needs_update = (
                existing_label.get("color", "").lower() != config["color"].lower() or
                existing_label.get("description", "") != config["description"]
            )

            if needs_update:
                success, message = update_label(name, config["color"], config["description"])
                if success:
                    updated += 1
                    print(f"✓ {message}")
                else:
                    failed += 1
                    print(f"✗ {message}")
            else:
                print(f"- {name} (no changes)")
        else:
            success, message = create_label(name, config["color"], config["description"])
            if success:
                created += 1
                print(f"✓ {message}")
            else:
                failed += 1
                print(f"✗ {message}")

    print(f"\n--- Summary ---")
    print(f"Created: {created}")
    print(f"Updated: {updated}")
    print(f"Failed:  {failed}")
    print(f"Total:   {len(LABELS)}")

    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()

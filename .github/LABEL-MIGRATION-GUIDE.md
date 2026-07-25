# Label Migration Guide

This guide explains how to migrate the athrvk/vayu repository to the new semantic labeling system.

## Overview

The new labeling system organizes labels into clear categories:
- **Component labels** (`component:*`) - where changes land (app, engine, database, ci, build)
- **Area labels** (`area:*`) - sub-areas within the engine (http, auth, metrics, scripting)
- **Type labels** (`type:*`) - kind of change (bug, feature, enhancement, perf, test)
- **Status labels** (`status:*`) - workflow state (needs-review, blocked, ready-merge)
- **Priority labels** (`priority:*`) - urgency (critical, high, low)
- **Severity labels** - impact (blocking)
- **Special labels** - documentation, good first issue, help wanted, dependencies, etc.

## Migration Steps

### Step 1: Verify GitHub App Connection

Before running the label setup script, ensure the Claude GitHub App is connected to your organization:

1. Go to https://claude.ai/admin-settings/claude-in-slack (or equivalent for your workspace)
2. Confirm the GitHub App is installed and has `repo` scope access
3. Verify the app can write labels to the athrvk/vayu repository

### Step 2: Run the Label Setup Script

Once the GitHub App is connected and you have a valid `GITHUB_TOKEN`:

```bash
cd /home/user/vayu
export GITHUB_TOKEN="your-token-here"  # GitHub Personal Access Token with 'repo' scope
python3 .github/scripts/setup-labels.py
```

The script will:
- **Create** new labels according to the schema
- **Update** existing labels (color, description)
- **Preserve** any labels not in the schema (like manual priority labels)

Expected output:
```
Setting up labels for athrvk/vayu...

Found 12 existing labels

✓ Created: component:app
✓ Created: component:engine
✓ Created: component:database
✓ Updated: documentation
✓ Created: type:bug
...

--- Summary ---
Created: 35
Updated: 6
Failed:  0
Total:   51
```

### Step 3: Update Labeler Workflow Configuration

The `.github/labeler.yml` file has already been updated to use the new label names and add area labels. No additional action needed—the workflow will auto-apply labels on the next PR.

### Step 4: Update Existing Issues and PRs (Optional)

The migration is **non-breaking**—existing issues keep their old labels. However, for consistency, you may want to manually update high-visibility items:

#### For Open Issues:
1. Identify issues that match the new schema
2. Add one `component:*` label (if not already have one)
3. Add one `type:*` label
4. Add `priority:*` if urgent
5. Remove old labels if duplicative

#### For Open PRs:
1. The labeler will auto-apply `component:*` and `area:*` labels on the next push
2. Manually add `type:*` if not auto-applied
3. Apply `status:*` as needed

#### For Closed Issues:
- Only update if you're reviewing/documenting the backlog
- New issues will use the new schema going forward

### Step 5: Update Documentation (Optional but Recommended)

If you maintain issue templates or contribution guidelines, update them to reference the new labels. See `.github/LABELING.md` for examples.

## Label Mapping Reference

### Component Labels (Auto-Applied)

| Old Name | New Name | Condition |
|----------|----------|-----------|
| `app` | `component:app` | Changes in `app/**` |
| `engine` | `component:engine` | Changes in `engine/**` |
| `database` | `component:database` | Changes in database files |
| `ci` | `component:ci` | Changes in `.github/**` |
| `build` | `component:build` | Changes to build files |
| (new) | `documentation` | Changes in `docs/**` or `**/*.md` |

### New Auto-Applied Labels

| Label | Condition |
|-------|-----------|
| `area:http` | Changes in `engine/src/http/**` |
| `area:auth` | Changes to auth-related engine code |
| `area:metrics` | Changes to metrics-related code |
| `area:scripting` | Changes in `engine/src/runtime/**` |

### Manual Labels (Apply by Choice)

These labels should be applied manually to issues and PRs:

**Type Labels** (pick one):
- `type:bug` - Bug fix
- `type:feature` - New feature
- `type:enhancement` - Enhancement
- `type:perf` - Performance improvement
- `type:test` - Tests/testing

**Status Labels** (for PRs):
- `status:needs-review` - Ready for review
- `status:blocked` - Blocked on something
- `status:ready-merge` - Approved and ready

**Priority Labels** (for issues):
- `priority:critical` - Urgent
- `priority:high` - Important
- `priority:low` - Nice-to-have

**Severity Labels**:
- `severity:blocking` - Breaking change
- `breaking-change` - Breaking change

**Special Labels**:
- `documentation` - Documentation-related
- `good first issue` - Suitable for newcomers
- `help wanted` - Need outside expertise
- `dependencies` - Dependency updates
- Plus: `duplicate`, `wontfix`, `invalid`, `question`, `flaky`, `memory-leak`, `performance`, `scripting`, `correctness`

## Troubleshooting

### Script Fails with "GitHub access is not enabled"

The Claude GitHub App isn't connected to your organization. Contact your org admin to enable it in Claude settings.

### Script Fails with "422 Unprocessable Entity"

A label with that name already exists but with different capitalization. GitHub label names are case-sensitive. Check the repository's label settings and manually delete conflicting labels before re-running the script.

### Labels Don't Auto-Apply to PRs

The labeler workflow in `.github/workflows/labeler.yml` is not running. Check:
1. Workflow is enabled in repository settings
2. `GITHUB_TOKEN` has `pull-requests: write` scope (auto-assigned in GitHub Actions)
3. PR touches files matching `.github/labeler.yml` rules

### Some Old Labels Still in Use

This is fine! The migration is non-breaking. Old labels remain for backwards compatibility. Over time, issues naturally migrate to the new schema as they're re-triaged.

To actively migrate an old label:
1. Add the new `component:*` or `type:*` equivalent
2. Remove the old label from the issue
3. Consider bulk-updating using GitHub's label management UI if many issues are affected

## Best Practices Going Forward

1. **Use auto-labels:** Don't manually apply `component:*` or `area:*` labels—the labeler does it automatically.
2. **One type per issue/PR:** Pick the single best `type:*` label, not multiple.
3. **Priority for issues:** Use `priority:*` labels to signal urgency; PRs rarely need them.
4. **Status for PRs:** Use `status:*` labels to track review workflow.
5. **Keep labels in sync:** If the schema changes, run `setup-labels.py` to update the repository.
6. **Reference in issues:** When triaging, mention which labels apply in the issue description.

## Questions?

See `.github/LABELING.md` for full documentation on each label and its purpose.

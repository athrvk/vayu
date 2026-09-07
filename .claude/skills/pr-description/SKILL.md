---
name: pr-description
description: How to write this repo's pull request title and description so a human reviewer can grasp it fast - lead with why, scale verbosity to diff size, call out risk and what to skip, never restate the diff. Always consult this before running `gh pr create` or `gh pr edit`, before filling in a PR body or title for this repo, or before drafting PR description text for the user to review - even a short one-file fix, and even if the user didn't ask for style guidance. Also applies when asked to "open a PR", "write the PR description", or "summarize this change for review".
---

# Lead with why. The diff already says what.

A reviewer can read the diff. What they cannot get from it is the reasoning -
why this approach, why now, what's risky, what's safe to skim past. That is
the only content a description needs to earn its place; everything else is
narration of lines the reviewer is about to read anyway.

Before drafting, look at the actual shape of the change - `git log
<base>..HEAD --oneline` and `git diff <base>...HEAD --stat` (or the staged
diff if nothing's committed yet), plus whatever issue it's linked to. The
judgment calls below - what's obvious, what's risky, whether concerns are
mixed - only work if you've actually looked, not inferred from the commit
message alone.

Use `.github/PULL_REQUEST_TEMPLATE.md`'s sections (`Description`, `Type of
Change`, `Testing`, `Checklist`, `Related Issues`) as the floor. Add a new
`##` section only when something doesn't fit any of those and earns its own
heading - a CI-only fix riding along with the real change, a deliberate
deviation from what a linked issue asked for. Don't invent structure the
change doesn't need.

- **Scale to the diff, not to a template.** A single-file mechanical fix gets
  one or two sentences and no bullets. A multi-file behavioral change gets a
  short paragraph per decision that isn't obvious from reading the code. A
  Description section longer than the diff it describes is a sign something
  got restated instead of explained.
- **Never restate the diff.** Before writing a sentence, ask: does the
  reviewer get this by reading the changed lines? If yes, cut it. "Added a
  `fold_scripts_into_elements` function that backfills elements from scripts"
  says nothing the function's name and body don't already say; *why* it's a
  startup repair pass instead of a migration, and what breaks if it were one,
  is the sentence worth writing.
- **Say what's risky and what's safe to skip, in the open, not at the
  bottom.** This matters more for an agent-authored PR than a human one:
  mechanical changes an agent tends to produce in bulk - renames across
  files, regenerated fixtures, a formatting pass, docs kept in sync with a
  code change per this repo's own rule - are exactly the diff a reviewer
  should not have to re-verify line by line. Naming them saves more review
  time than any amount of polish on the part that actually needs scrutiny.
  Bias risk-flagging toward the second-order effect, not just the change
  itself: not "the attribute is gone" but "a caller that still sets it gets
  no error and silently no-ops" - the second sentence is the one a reviewer
  actually needed and wouldn't get from the diff alone.
- **If the diff mixes unrelated concerns, say so before writing the
  description - don't paper over it with more headers.** A description that
  successfully explains two unrelated changes at once is a sign the PR should
  have been two PRs, not a sign the description is thorough.
- **Testing section states what was run and why that covers the change**,
  not a log dump - the same scale-to-the-change judgment this repo's own
  `CLAUDE.md` already asks for when choosing what to run in the first place.
  If nothing needed to run (a comment or doc-only change), say that plainly
  instead of leaving the section as a stub.
- **Checklist boxes are claims, not decoration.** Check what's actually true.
  Leave a box unchecked with a short reason when it doesn't apply ("no tests -
  doc-only change") rather than checking it to look complete.
- **Title: imperative mood, present tense**, matching this repo's own recent
  commit style (`feat(app): ...`, `fix(engine): ...`) - describe what the
  change does, not what was wrong before it.
- **Link the issue, don't restate it.** `Closes #123` - the issue text is one
  click away and copying it into the description doubles a maintenance
  surface for no reader benefit.

## Visual changes need a picture, not just a description

When a change is visually observable (UI, layout, a rendered page, a new
diagram) - the same class of change this repo's UI-verification workflow
already asks to check in a browser before calling the work done - add a
`## Visual changes` section to the PR body with an actual screenshot
embedded. A reviewer should not have to pull the branch to see what changed.

GitHub has no supported way to attach an image to a PR body other than the
web UI's own drag-and-drop or a git commit; commit-and-drop is the mechanism
here, so treat the screenshot commit as scaffolding for the description, not
part of the change:

1. Commit the screenshot on its own, on top of the real change - not mixed
   into a code commit - at a path outside any real source tree (repo root or
   a throwaway subfolder), with a commit message that says it's getting
   dropped (e.g. `chore: screenshot for PR body (dropped before merge)`).
2. Push the branch. GitHub only has the blob to serve once it's pushed, and
   it stays retrievable later specifically because the commit was part of a
   pushed PR's history - a local-only commit gives you nothing to link to.
3. Reference it as `https://raw.githubusercontent.com/<owner>/<repo>/<full
   commit SHA>/<path>` - the *commit SHA*, never the branch name. A
   branch-name URL points at whatever's on the tip right now and breaks the
   moment step 5 removes the commit from the branch.
4. Put that URL in the `## Visual changes` section as a markdown image, then
   open or update the PR.
5. Drop the screenshot commit from the branch (interactive rebase, mark it
   `drop`) and force-push. **Confirm with the user before this step** - it
   rewrites already-pushed history on an open PR branch, which this session's
   own standing rules already require confirming before doing regardless of
   this skill.
6. Verify the PR body still renders the image after the force-push. It keeps
   resolving because GitHub retains everything ever pushed to a PR, not
   because the URL is somehow independent of git - if it doesn't render, the
   commit didn't make it to GitHub before being dropped, or the SHA in the
   URL isn't the one that was actually pushed.

This relies on retention behavior GitHub doesn't document or guarantee, not
on a stable API. If a screenshot in some old, already-merged PR ever turns up
broken, that's why - and the fix is to re-do the upload for whatever PR is
open now, not a sign this approach was wrong for it.

**Before posting, do one self-edit pass**: read the draft as a reviewer who
has not seen the diff. Strike every sentence that only narrates a line they
are about to read. What survives should be why, what isn't obvious, what's
risky, and what to skip.

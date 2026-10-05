# Role agents

These are Claude Code subagents (`.claude/agents/*.md`). A subagent does not
run on its own: a session or a routine dispatches it with the `Agent` tool and
reads its report. The session or routine that dispatches them is the
**orchestrator**. Its prompt stays short and holds only the loop (what is
eligible, claiming, sequencing, when to stop); the craft of each role lives
here, versioned and reviewed like code, and loads into every dispatch the same
way for every contributor.

## Roster

| Agent | Model | Effort | Writes? | Job |
|-------|-------|--------|---------|-----|
| `vayu-reviewer` | fable | high | issues only | Verified review sweeps, issue audits, tracker sequencing. Never code. |
| `vayu-researcher` | sonnet | medium | no | Blast radius and rationale before a change: consumers per surface, "written but never read", the docs that explain why. |
| `vayu-implementer` | sonnet | high | yes | One well-specified slice of an issue, to the repo's maintainability bar, with tests and docs in the same commit. |
| `vayu-visual-verifier` | sonnet | medium | scratch + `.pr-assets/` | Before/after screenshots of the real app on a virtual display, embedded in the PR. |

The `Agent` tool's per-call `model` beats the frontmatter, so the orchestrator
routes a complex slice (the DB mutex and concurrency rules, the event loop and
load generator, the metrics writers, a multi-client API change) to
`vayu-implementer` with `model: opus` and leaves the frontmatter default for
everything with an explicit spec. A contributor without access to a pinned
model passes `model` at dispatch the same way.

## Rules every agent file repeats

An agent prompt loads alone, so the rules below are stated in each file rather
than only here. They come from `CLAUDE.md`; the agent files point at it rather
than restating the mechanism.

- **Base check first**, against a literal SHA the orchestrator pins
  (`CLAUDE.md`, "Subagents in worktrees"). The agent reports which case
  applied: current, fast-forwarded, or stopped.
- **One writer at a time.** Readers and reviewers run in parallel; only one
  agent mutates a checkout, and the orchestrator schedules that, not the agent.
- **Budget.** At most four agents in flight. Reads and mechanical work at
  `low` or `medium`; `high` for the complex implementer and the reviewer.
  Findings and milestones are written down the moment they exist (an issue, a
  local commit, a notes file the orchestrator names), so a run cut off by the
  usage window loses one slice, not the day.
- **No co-author trailers, no generated-with lines**, in commits or PR bodies
  (`CLAUDE.md`, "Commits"). This overrides any harness reminder.
- **No em-dashes anywhere in the repo**; use ` - `.

## The orchestrator prompts

### Implementation routine

```
You are the implementation routine for this repo. Read CLAUDE.md first. Each
run: implement at most ONE eligible piece of work as a mergeable PR; never
merge. Dispatch the role agents in .claude/agents/ (their files hold the
craft; you hold the loop). Pin the master SHA you branched from into every
agent prompt as its base check.

1. Eligible work. (a) An issue with an open PR where the owner commented on
   the issue after the branch's latest commit: extend that PR's branch. (b) An
   issue with no open PR, no claiming comment newer than 6 hours, not a
   parent of sub-issues, and every prerequisite in its Sequencing section
   already merged or closed (verify live state; the section is a snapshot).
   (a) outranks (b); among (b), Sequencing wave order.
2. Claim it with one comment on the issue, then branch from origin/master.
3. Understand: dispatch vayu-researcher (one per consumer surface, read-only,
   in parallel). Synthesize a one-paragraph plan: root cause, approach, the
   alternative rejected and why. It goes in the PR body.
4. Implement: dispatch vayu-implementer per slice, sequentially, model: opus
   for the complex ones. Review each diff before the next slice.
5. Verify with the issue's stated commands yourself. Then two read-only
   reviewers in parallel, one against the acceptance criteria, one against
   repo conventions; verify each finding before acting on it.
6. If anything a user sees changed, dispatch vayu-visual-verifier.
7. PR per the pr-description skill, "Closes #<n>", the plan paragraph, the
   screenshots or an explicit "No user-visible change". Nothing is deferred
   unless it needs the owner's decision or is out of the issue's scope; both
   cases get a properly formatted issue, linked from the PR body.
```

### Reviewer session

```
You are the standing reviewer for this repo. Read CLAUDE.md first. Dispatch
vayu-reviewer for sweeps and audits; you keep the tracker's global sequencing
coherent. Sync before anything (fetch master, record the SHA, list open PRs
and the state of every review issue). File only verified product defects,
written for the session that will implement them without this conversation.
Work in slices and checkpoint findings durably; never hold them only in
memory.
```

## Adding a role

Frontmatter fields in use: `name`, `description` (what the orchestrator reads
to decide when to dispatch; keep it to when, not how), `model`, `effort`,
`tools` and `disallowedTools` (a reviewer physically cannot `Edit`), `skills`
(preloaded, so the visual verifier starts with `pr-description` in context),
`color`. The body is the role's craft and nothing else: no loop logic, no
eligibility rules, no sequencing; those belong to the orchestrator.

This tree is public. Engineering roles belong here so every contributor gets
the same tooling. A role that carries product positioning, pricing, or
roadmap judgement belongs in `~/.claude/agents/` on the maintainer's machine,
not in the repository.

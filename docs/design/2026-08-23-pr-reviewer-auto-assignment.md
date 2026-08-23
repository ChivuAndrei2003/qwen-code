# Path-Driven PR Reviewer Routing

## Problem

Every PR touching `packages/core/` gets review requests for all code owners
via CODEOWNERS, so reviewers cannot tell which requests actually need their
attention. The issue side solved the equivalent problem with label-driven
assignment (#8668); the PR side had no targeted routing at all — the earlier
attempt (#7469) stalled because it replaced CODEOWNERS and thus removed the
`require_code_owner_review` merge gate.

## Design

The model does not choose. The reviewer is a pure function of the PR's changed
file paths.

`assign-pr-reviewer.yml` triggers on `pull_request` opened / synchronize /
ready_for_review, reads the diff's file list, and matches it against the
optional `paths` entry of each area in `.github/issue-owners.json` (first area
wins, same precedence as labels). It then requests the area's least loaded
eligible owner — same load metric and rotation as issue assignment — and stops
at one request per PR: if any mapped owner is already a requested reviewer or
has submitted a review, the run no-ops.

```
pull_request ──► assign-pr-reviewer.mjs ──► files → area → owner
                 (no model, no PR text read)
```

Security properties mirror issue assignment:

| Property                          | Mechanism                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| PR text cannot steer the reviewer | The script reads only `state`, `isDraft`, `author`, `files`, `reviewRequests`, `latestReviews` — never title, body, or comments             |
| Map edits cannot grant access     | Every candidate is re-checked against the collaborator permission API before the write; only `admin`/`maintain`/`write` pass                |
| Write token stays narrow          | Workflow-level `contents: read`; `pull-requests: write` is job-scoped and `GH_TOKEN` is step-scoped; checkout is credential-free and sparse |
| One request per PR                | Coverage check against the union of all mapped owners, re-checked immediately before the write                                              |

## Relationship to CODEOWNERS

Complementary, not a replacement. CODEOWNERS keeps enforcing the merge gate
(and still requests every owner); this workflow adds a single targeted request
so the most relevant owner sees it first. Removing the broad CODEOWNERS rule
remains a separate decision that must involve the `require_code_owner_review`
ruleset.

## Known limitations

- Fork PRs run with a read-only `GITHUB_TOKEN`, so the reviewer request 403s
  and is skipped gracefully; CODEOWNERS still covers forks.
- Bot-authored PRs are skipped — they have their own review pipeline.
- Load is counted across all open assigned issues repo-wide, the same metric
  (and same known distortion) as issue assignment.

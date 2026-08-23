// Guards for path-driven PR reviewer routing. Mirrors
// assign-issue-owner.test.mjs: the pure policy functions that decide *whether*
// and *whom* to request, and the workflow invariants (repository guard,
// permission split, step-scoped token) that keep the write token narrow.
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { loadPolicy } from './assign-issue-owner.mjs';
import {
  alreadyCovered,
  allOwners,
  matchAreaByPath,
  skipPrReason,
} from './assign-pr-reviewer.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..', '..');
const script = join(scriptsDir, 'assign-pr-reviewer.mjs');
const ownersRaw = readFileSync(
  join(repoRoot, '.github', 'issue-owners.json'),
  'utf8',
);
const policy = loadPolicy(ownersRaw);
const tempDirs = [];

const corePr = {
  state: 'OPEN',
  isDraft: false,
  author: { login: 'some-contributor' },
  files: [{ path: 'packages/core/src/foo.ts' }],
  reviewRequests: [],
  latestReviews: [],
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('assign-pr-reviewer: owner map paths', () => {
  it('parses the checked-in map with a routable core area', () => {
    const core = policy.areas.find((area) => area.name === 'core');
    assert.ok(core.paths.length > 0);
  });

  it('rejects an empty or malformed paths list', () => {
    const empty = JSON.parse(ownersRaw);
    empty.areas[0].paths = [];
    assert.throws(
      () => loadPolicy(JSON.stringify(empty)),
      /paths must be non-empty strings/,
    );

    const blank = JSON.parse(ownersRaw);
    blank.areas[0].paths = ['packages/core/', ''];
    assert.throws(
      () => loadPolicy(JSON.stringify(blank)),
      /paths must be non-empty strings/,
    );

    const notStrings = JSON.parse(ownersRaw);
    notStrings.areas[0].paths = [42];
    assert.throws(
      () => loadPolicy(JSON.stringify(notStrings)),
      /paths must be non-empty strings/,
    );
  });

  it('accepts an area without paths (issue-only area)', () => {
    const noPaths = JSON.parse(ownersRaw);
    delete noPaths.areas[0].paths;
    assert.doesNotThrow(() => loadPolicy(JSON.stringify(noPaths)));
  });
});

describe('assign-pr-reviewer: skip policy', () => {
  it('routes an open, non-draft, human-authored PR', () => {
    assert.equal(skipPrReason(corePr), null);
  });

  it('leaves a closed or merged PR alone', () => {
    assert.match(skipPrReason({ ...corePr, state: 'MERGED' }), /not open/);
  });

  it('waits for a draft to become ready', () => {
    assert.match(skipPrReason({ ...corePr, isDraft: true }), /draft/);
  });

  it('never routes bot PRs at humans', () => {
    for (const login of ['qwen-code-dev-bot', 'dependabot[bot]']) {
      assert.match(
        skipPrReason({ ...corePr, author: { login } }),
        /authored by a bot/,
      );
    }
  });
});

describe('assign-pr-reviewer: path matching', () => {
  it('matches an area when any changed file sits under its paths', () => {
    assert.equal(
      matchAreaByPath(policy, [
        { path: 'docs/readme.md' },
        { path: 'packages/core/src/tools/shell.ts' },
      ]).name,
      'core',
    );
  });

  it('returns no area when nothing touches a mapped prefix', () => {
    assert.equal(
      matchAreaByPath(policy, [{ path: 'packages/cli/src/index.ts' }]),
      null,
    );
  });

  it('does not match a prefix lookalike outside the directory', () => {
    assert.equal(
      matchAreaByPath(policy, [{ path: 'packages/core-extras/file.ts' }]),
      null,
    );
  });

  it('never matches an area without paths', () => {
    const noPaths = loadPolicy(
      JSON.stringify(
        (() => {
          const parsed = JSON.parse(ownersRaw);
          delete parsed.areas[0].paths;
          return parsed;
        })(),
      ),
    );
    assert.equal(matchAreaByPath(noPaths, corePr.files), null);
  });
});

describe('assign-pr-reviewer: idempotency', () => {
  it('collects every mapped owner into the coverage pool', () => {
    const pool = allOwners(policy);
    assert.ok(pool.includes('wenshao'));
    assert.ok(pool.length >= policy.areas[0].owners.length);
  });

  it('treats a pending request for any mapped owner as covered', () => {
    const owner = policy.areas[0].owners[0];
    assert.ok(
      alreadyCovered(policy, {
        ...corePr,
        reviewRequests: [{ login: owner }],
      }),
    );
  });

  it('treats a submitted review by any mapped owner as covered', () => {
    const owner = policy.areas[0].owners[0];
    assert.ok(
      alreadyCovered(policy, {
        ...corePr,
        latestReviews: [{ author: { login: owner }, state: 'COMMENTED' }],
      }),
    );
  });

  it('ignores team requests and unmapped reviewers', () => {
    assert.equal(
      alreadyCovered(policy, {
        ...corePr,
        reviewRequests: [{ name: 'some-team', slug: 'some-team' }],
        latestReviews: [
          { author: { login: 'random-person' }, state: 'APPROVED' },
        ],
      }),
      false,
    );
  });
});

// The stub reports wenshao as the least loaded owner so the pick is
// unambiguous regardless of the rotation offset for PR 77. Changed files come
// from the paginated REST files endpoint, not from `pr view`, so the stub
// serves them separately and can vary them between the two reads.
function runRequest(dryRun, options = {}) {
  const { firstPrJson = '', secondPrJson = '', secondFiles = '' } = options;
  const dir = mkdtempSync(join(tmpdir(), 'assign-pr-reviewer-'));
  tempDirs.push(dir);
  const log = join(dir, 'gh.log');
  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
case "$*" in
  "pr view 77 "*)
    count=$(cat "$GH_STUB_VIEW_COUNT" 2>/dev/null || echo 0)
    count=$((count + 1))
    printf '%s' "$count" > "$GH_STUB_VIEW_COUNT"
    if [ "$count" = 2 ] && [ -n "$GH_STUB_SECOND_PR" ]; then
      printf '%s' "$GH_STUB_SECOND_PR"
    elif [ -n "$GH_STUB_FIRST_PR" ]; then
      printf '%s' "$GH_STUB_FIRST_PR"
    else
      printf '%s' '{"state":"OPEN","isDraft":false,"author":{"login":"some-contributor"},"reviewRequests":[],"latestReviews":[]}'
    fi
    ;;
  *"pulls/77/files"*)
    fcount=$(cat "$GH_STUB_FILES_COUNT" 2>/dev/null || echo 0)
    fcount=$((fcount + 1))
    printf '%s' "$fcount" > "$GH_STUB_FILES_COUNT"
    if [ "$fcount" = 2 ] && [ -n "$GH_STUB_SECOND_FILES" ]; then
      printf '%s' "$GH_STUB_SECOND_FILES"
    else
      printf '%s' 'packages/core/src/foo.ts'
    fi
    ;;
  *"/collaborators/"*"/permission"*) printf '%s' 'write' ;;
  *"--assignee wenshao"*"--json number"*) printf '%s' '0' ;;
  *"issue list"*"--json number"*) printf '%s' '5' ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GH_STUB_LOG: log,
      GH_STUB_VIEW_COUNT: join(dir, 'view-count'),
      GH_STUB_FILES_COUNT: join(dir, 'files-count'),
      GH_STUB_FIRST_PR: firstPrJson,
      GH_STUB_SECOND_PR: secondPrJson,
      GH_STUB_SECOND_FILES: secondFiles,
      GITHUB_REPOSITORY: 'QwenLM/qwen-code',
      GITHUB_STEP_SUMMARY: '',
      PR_NUMBER: '77',
      DRY_RUN: String(dryRun),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return { log: readFileSync(log, 'utf8'), stdout: result.stdout };
}

describe('assign-pr-reviewer: apply boundary', () => {
  it('sources the changed-file list from the paginated files endpoint', () => {
    // `gh pr view --json files` silently caps at 100 entries, so the routing
    // must read the REST endpoint that follows pagination instead.
    const { log } = runRequest(false);
    assert.match(
      log,
      /api repos\/QwenLM\/qwen-code\/pulls\/77\/files --paginate/,
    );
    assert.doesNotMatch(log, /--json [^\n]*files/);
  });

  it('verifies push access before requesting', () => {
    const { log } = runRequest(false);
    assert.match(log, /collaborators\/wenshao\/permission/);
  });

  it('performs no mutation in dry-run mode', () => {
    const { log, stdout } = runRequest(true);
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /dry-run — would request @wenshao/);
  });

  it('requests the least loaded eligible owner', () => {
    const { log, stdout } = runRequest(false);
    assert.match(log, /pr edit 77 .*--add-reviewer wenshao/);
    assert.match(stdout, /requested @wenshao/);
  });

  it('re-checks coverage immediately before requesting', () => {
    const { log, stdout } = runRequest(false, {
      secondPrJson:
        '{"state":"OPEN","isDraft":false,"author":{"login":"some-contributor"},"reviewRequests":[{"login":"wenshao"}],"latestReviews":[]}',
    });
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /already reviewing/);
  });

  it('re-checks the diff immediately before requesting', () => {
    const { log, stdout } = runRequest(false, {
      secondFiles: 'packages/cli/src/index.ts',
    });
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /PR files changed/);
  });
});

const doc = parse(
  readFileSync(
    join(repoRoot, '.github', 'workflows', 'assign-pr-reviewer.yml'),
    'utf8',
  ),
);
const requestJob = doc.jobs['request-review'];
const checkoutStep = requestJob.steps.find((s) =>
  s.uses?.startsWith('actions/checkout@'),
);
const requestStep = requestJob.steps.find(
  (s) => s.name === 'Request area reviewer',
);

describe('assign-pr-reviewer: workflow invariants', () => {
  it('runs only on the canonical repository', () => {
    assert.equal(
      String(requestJob.if),
      "${{ github.repository == 'QwenLM/qwen-code' }}",
    );
  });

  it('grants pull-requests:write to the job, not the whole workflow', () => {
    assert.deepEqual(doc.permissions, { contents: 'read' });
    assert.deepEqual(requestJob.permissions, {
      contents: 'read',
      // issues:read — openIssueCount() lists issues for every eligible owner
      // before any write, and the Issues API 403s without the scope.
      issues: 'read',
      'pull-requests': 'write',
    });
  });

  it('scopes the write token to the step and keeps checkout credential-free', () => {
    assert.equal(
      requestJob.env,
      undefined,
      'job-level env exposes GH_TOKEN to every step',
    );
    assert.equal(requestStep.env.GH_TOKEN, '${{ github.token }}');
    assert.equal(requestStep.env.DRY_RUN, "${{ inputs.dry_run || 'false' }}");
    assert.equal(
      requestStep.env.PR_NUMBER,
      '${{ github.event.pull_request.number || inputs.number }}',
    );
    assert.equal(checkoutStep.with['persist-credentials'], false);
  });

  it('never runs a model or reads PR text', () => {
    const serialized = JSON.stringify(doc);
    assert.doesNotMatch(
      serialized,
      /OPENAI_API_KEY|qwen --|github\.event\.pull_request\.(title|body)/,
    );
  });

  it('fires on PR updates without cancelling an in-flight request', () => {
    assert.deepEqual(doc.on.pull_request.types, [
      'opened',
      'synchronize',
      'ready_for_review',
    ]);
    assert.equal(
      doc.concurrency.group,
      'assign-pr-reviewer-${{ github.event.pull_request.number || inputs.number }}',
    );
    assert.equal(doc.concurrency['cancel-in-progress'], false);
  });
});

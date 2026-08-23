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
  codeownersForFiles,
  matchAreaByPath,
  parseCodeowners,
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
// The checked-in CODEOWNERS owners for the changed paths: GitHub requests all
// of them automatically the second a PR opens, so the routing must exclude
// them from both the coverage pool and the pick.
const repoCodeownersRules = parseCodeowners(
  readFileSync(join(repoRoot, '.github', 'CODEOWNERS'), 'utf8'),
);
const coreCodeOwners = codeownersForFiles(repoCodeownersRules, corePr.files);

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
      /paths must be repo-root-relative directory prefixes/,
    );

    const blank = JSON.parse(ownersRaw);
    blank.areas[0].paths = ['packages/core/', ''];
    assert.throws(
      () => loadPolicy(JSON.stringify(blank)),
      /paths must be repo-root-relative directory prefixes/,
    );

    const notStrings = JSON.parse(ownersRaw);
    notStrings.areas[0].paths = [42];
    assert.throws(
      () => loadPolicy(JSON.stringify(notStrings)),
      /paths must be repo-root-relative directory prefixes/,
    );
  });

  it('rejects a prefix without a trailing slash that would leak into siblings', () => {
    // matchAreaByPath uses startsWith, so "packages/cli" would also match
    // packages/cli-extras/file.ts and misroute a sibling directory's PRs;
    // require the directory boundary instead of trusting the entry's shape.
    const loose = JSON.parse(ownersRaw);
    loose.areas[0].paths = ['packages/cli'];
    assert.throws(
      () => loadPolicy(JSON.stringify(loose)),
      /paths must be repo-root-relative directory prefixes/,
    );
  });

  it('rejects a leading-slash prefix that can never match', () => {
    // Changed-file paths come back repo-root-relative with no leading slash,
    // so the CODEOWNERS spelling "/packages/core/" would silently and
    // permanently unroute the area.
    const anchored = JSON.parse(ownersRaw);
    anchored.areas[0].paths = ['/packages/core/'];
    assert.throws(
      () => loadPolicy(JSON.stringify(anchored)),
      /paths must be repo-root-relative directory prefixes/,
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

describe('assign-pr-reviewer: CODEOWNERS matching', () => {
  const rules = parseCodeowners(
    [
      '# header comment',
      '',
      '/packages/core/ @alice @bob',
      'packages/core/src/special.ts @carol',
      'docs/ @org/docs-team dave@example.com',
      'docs/*.txt @doc-txt',
      '*.md @erin',
      'generated/ @gen-owner',
    ].join('\n'),
  );

  function ownersFor(path) {
    return [...codeownersForFiles(rules, [{ path }])].sort();
  }

  it('drops team and email owners, keeping nothing requestable', () => {
    // Only the directory rule reaches nested files, and both of its owners
    // are a team and an email address.
    assert.deepEqual(ownersFor('docs/sub/guide.txt'), []);
  });

  it('never lets a single * cross a directory separator', () => {
    assert.deepEqual(ownersFor('docs/guide.txt'), ['doc-txt']);
  });

  it('applies the last matching rule per file', () => {
    assert.deepEqual(ownersFor('packages/core/src/foo.ts'), ['alice', 'bob']);
    assert.deepEqual(ownersFor('packages/core/src/special.ts'), ['carol']);
  });

  it('anchors slashed patterns and floats bare directories', () => {
    assert.deepEqual(ownersFor('vendor/packages/core/foo.ts'), []);
    assert.deepEqual(ownersFor('deep/generated/file.js'), ['gen-owner']);
  });

  it('excludes the CODEOWNERS owners of the mapped core paths', () => {
    assert.ok(
      coreCodeOwners.size > 0,
      'expected packages/core/ to have CODEOWNERS entries',
    );
    assert.deepEqual([...coreCodeOwners].sort(), [
      'doudououc',
      'lazzyman',
      'tanzhenxin',
      'wenshao',
      'yiliang114',
    ]);
  });
});

describe('assign-pr-reviewer: idempotency', () => {
  it('collects every mapped owner into the coverage pool', () => {
    const pool = allOwners(policy);
    assert.ok(pool.includes('wenshao'));
    assert.ok(pool.length >= policy.areas[0].owners.length);
  });

  it('does not treat CODEOWNERS auto-requests as coverage', () => {
    // GitHub requests every code owner for packages/core/ the second the PR
    // opens; that must not suppress this routing's targeted request.
    assert.equal(
      alreadyCovered(
        policy,
        {
          ...corePr,
          reviewRequests: [...coreCodeOwners].map((login) => ({ login })),
        },
        coreCodeOwners,
      ),
      false,
    );
  });

  it('treats a pending request for any other mapped owner as covered', () => {
    const owner = policy.areas[0].owners.find(
      (login) => !coreCodeOwners.has(login.toLowerCase()),
    );
    assert.ok(
      alreadyCovered(
        policy,
        { ...corePr, reviewRequests: [{ login: owner }] },
        coreCodeOwners,
      ),
    );
  });

  it('matches requested reviewers against the map case-insensitively', () => {
    // The checked-in map spells the owner LaZzyMan; a pending request in any
    // casing must count as coverage, or the routing stacks a second request
    // on another owner and breaks the one-request-per-PR guarantee.
    assert.equal(
      alreadyCovered(policy, {
        ...corePr,
        reviewRequests: [{ login: 'lazzyman' }],
      }),
      true,
    );
    assert.equal(
      alreadyCovered(policy, {
        ...corePr,
        reviewRequests: [{ login: 'LaZzyMan' }],
      }),
      true,
    );
  });

  it('treats a submitted review by any other mapped owner as covered', () => {
    const owner = policy.areas[0].owners.find(
      (login) => !coreCodeOwners.has(login.toLowerCase()),
    );
    assert.ok(
      alreadyCovered(
        policy,
        {
          ...corePr,
          latestReviews: [{ author: { login: owner }, state: 'COMMENTED' }],
        },
        coreCodeOwners,
      ),
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

// The stub reports DennisYu07 as the least loaded owner so the pick is
// unambiguous regardless of the rotation offset for PR 77 (DennisYu07 is also
// not a CODEOWNERS owner for packages/core/, so the exclusion never drops
// it). Changed files come from the paginated REST files endpoint, not from
// `pr view`, so the stub serves them separately and can vary them between the
// two reads.
function runRequest(dryRun, options = {}) {
  const {
    firstPrJson = '',
    secondPrJson = '',
    secondFiles = '',
    zeroLoadOwner = 'DennisYu07',
  } = options;
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
  *"--assignee ${zeroLoadOwner}"*"--json number"*) printf '%s' '0' ;;
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
    assert.match(log, /collaborators\/DennisYu07\/permission/);
  });

  it('performs no mutation in dry-run mode', () => {
    const { log, stdout } = runRequest(true);
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /dry-run — would request @DennisYu07/);
  });

  it('requests the least loaded eligible owner', () => {
    const { log, stdout } = runRequest(false);
    assert.match(log, /pr edit 77 .*--add-reviewer DennisYu07/);
    assert.match(stdout, /requested @DennisYu07/);
  });

  it('requests on top of CODEOWNERS auto-requests', () => {
    // Every code owner for packages/core/ is already requested by GitHub's
    // automatic CODEOWNERS handling; the routing must still add one of the
    // remaining mapped owners, never a duplicate of them.
    const withCodeownerRequests = JSON.stringify({
      state: 'OPEN',
      isDraft: false,
      author: { login: 'some-contributor' },
      reviewRequests: [...coreCodeOwners].map((login) => ({ login })),
      latestReviews: [],
    });
    // zeroLoadOwner=wenshao makes a code owner the least-loaded candidate, so
    // the assertion proves the exclusion keeps it out of the pick, not just
    // lucky rotation.
    const { log, stdout } = runRequest(false, {
      firstPrJson: withCodeownerRequests,
      secondPrJson: withCodeownerRequests,
      zeroLoadOwner: 'wenshao',
    });
    assert.match(log, /pr edit 77 .*--add-reviewer pomelo-nwu/);
    assert.match(stdout, /requested @pomelo-nwu/);
    assert.doesNotMatch(
      log,
      /--add-reviewer (wenshao|tanzhenxin|yiliang114|LaZzyMan|doudouOUC)\b/,
    );
  });

  it('never requests the PR author to review their own work', () => {
    // The live shape: a maintainer who is a mapped core owner opens a
    // packages/core/ PR. zeroLoadOwner=DennisYu07 makes the author the
    // would-be pick, so the assertion proves the exclusion filter dropped
    // them rather than lucky rotation.
    const maintainerAuthor = JSON.stringify({
      state: 'OPEN',
      isDraft: false,
      author: { login: 'DennisYu07' },
      reviewRequests: [],
      latestReviews: [],
    });
    const { log, stdout } = runRequest(false, {
      firstPrJson: maintainerAuthor,
      secondPrJson: maintainerAuthor,
      zeroLoadOwner: 'DennisYu07',
    });
    assert.match(log, /pr edit 77 .*--add-reviewer BenGuanRan/);
    assert.match(stdout, /requested @BenGuanRan/);
    assert.doesNotMatch(log, /--add-reviewer DennisYu07\b/);
  });

  it('re-checks coverage immediately before requesting', () => {
    const { log, stdout } = runRequest(false, {
      secondPrJson:
        '{"state":"OPEN","isDraft":false,"author":{"login":"some-contributor"},"reviewRequests":[{"login":"pomelo-nwu"}],"latestReviews":[]}',
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

  it('checks out CODEOWNERS so the routing can exclude auto-requested owners', () => {
    assert.match(
      checkoutStep.with['sparse-checkout'],
      /^\.github\/CODEOWNERS$/m,
    );
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

  it('defaults manual dispatches to report-only', () => {
    // The DRY_RUN step env consumes inputs.dry_run; if the input definition
    // flips or disappears, `inputs.dry_run || 'false'` collapses to 'false'
    // and a report-only manual dispatch performs a real reviewer request.
    assert.equal(requestStep.env.DRY_RUN, "${{ inputs.dry_run || 'false' }}");
    assert.equal(doc.on.workflow_dispatch.inputs.dry_run.default, true);
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
      'reopened',
      'ready_for_review',
    ]);
    assert.equal(
      doc.concurrency.group,
      'assign-pr-reviewer-${{ github.event.pull_request.number || inputs.number }}',
    );
    assert.equal(doc.concurrency['cancel-in-progress'], false);
  });
});

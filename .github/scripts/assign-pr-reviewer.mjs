#!/usr/bin/env node
// Request a review from an area owner on a PR, derived purely from the PR's
// changed file paths.
//
// This is the PR-side companion to assign-issue-owner.mjs. It never reads PR
// title, body, or comments, so untrusted PR text cannot steer who gets
// requested. The diff's file paths are matched against the optional `paths`
// list of each area in .github/issue-owners.json (first area wins, same
// precedence as labels); the reviewer is the area's least loaded eligible
// owner, rotated by PR number on ties. Push access is re-verified against the
// live collaborator API before every write, and this routing adds at most one
// request per PR ON TOP of the automatic CODEOWNERS requests: owners that
// CODEOWNERS already requests for the changed paths are excluded from
// consideration entirely, and if any remaining mapped owner is already a
// requested reviewer or has submitted a review, the script no-ops.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  loadPolicy,
  openIssueCount,
  pickOwner,
} from './assign-issue-owner.mjs';

const OWNERS_FILE = '.github/issue-owners.json';
const CODEOWNERS_FILE = '.github/CODEOWNERS';
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const BOT_LOGIN = /(\[bot\]|-bot)$/;
// Only plain @logins can equal a mapped owner; teams (@org/team) and email
// owners are dropped because they can never be requested by login here.
const CODEOWNER_LOGIN = /^@([A-Za-z0-9-]+)$/;

// Returns a human-readable reason to skip, or null to proceed. Ordered so the
// most informative reason wins when several apply.
export function skipPrReason(pr) {
  if (pr.state !== 'OPEN') return 'PR is not open';
  if (pr.isDraft) return 'PR is a draft';
  if (BOT_LOGIN.test(pr.author.login)) return 'authored by a bot';
  return null;
}

// First area whose paths prefix any changed file wins, so file order is the
// documented precedence — identical to label matching. Areas without a paths
// list never match.
export function matchAreaByPath(policy, files) {
  return (
    policy.areas.find((area) =>
      area.paths?.some((prefix) =>
        files.some((file) => file.path.startsWith(prefix)),
      ),
    ) ?? null
  );
}

// Every owner in the map, so the one-request-per-PR idempotency check holds
// even if a later push moves the PR between areas.
export function allOwners(policy) {
  return policy.areas.flatMap((area) => area.owners);
}

// A requested reviewer or a submitted review by any mapped owner means this
// routing already happened; never stack a second request. Owners in
// `codeOwners` (lowercase) were requested by GitHub's automatic CODEOWNERS
// handling, not by this routing, so they never count as coverage.
export function alreadyCovered(policy, pr, codeOwners = new Set()) {
  const pool = new Set(
    allOwners(policy)
      .map((login) => login.toLowerCase())
      .filter((login) => !codeOwners.has(login)),
  );
  const involved = [
    ...pr.reviewRequests.map((request) => request.login),
    ...pr.latestReviews.map((review) => review.author?.login),
  ];
  return involved.some((login) => login && pool.has(login.toLowerCase()));
}

// Translate one CODEOWNERS pattern to a regex, following the gitignore-style
// rules GitHub documents: a leading or interior slash anchors the pattern to
// the repo root, `*` never crosses a directory separator while `**` does,
// and a pattern covers the matched path plus everything below it.
function codeownersPatternRegex(pattern) {
  let body = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  let anchored = body.startsWith('/');
  if (anchored) body = body.slice(1);
  if (body.includes('/')) anchored = true;
  let translated = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === '*') {
      if (body[i + 1] === '*') {
        translated += '.*';
        i += 1;
      } else {
        translated += '[^/]*';
      }
    } else if (char === '?') {
      translated += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      translated += `\\${char}`;
    } else {
      translated += char;
    }
  }
  return new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${translated}(?:/.*)?$`);
}

// Parses a CODEOWNERS file into ordered { regex, logins } rules; comments
// and blank lines are dropped.
export function parseCodeowners(text) {
  const rules = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    const logins = [];
    for (const owner of owners) {
      const match = CODEOWNER_LOGIN.exec(owner);
      if (match) logins.push(match[1].toLowerCase());
    }
    rules.push({ regex: codeownersPatternRegex(pattern), logins });
  }
  return rules;
}

// GitHub applies the LAST matching rule per file, so later entries override
// earlier ones; returns the lowercase logins owning any changed file.
export function codeownersForFiles(rules, files) {
  const owners = new Set();
  for (const file of files) {
    let matched = null;
    for (const rule of rules) {
      if (rule.regex.test(file.path)) matched = rule;
    }
    for (const login of matched?.logins ?? []) owners.add(login);
  }
  return owners;
}

function loadCodeownersRules() {
  try {
    return parseCodeowners(readFileSync(CODEOWNERS_FILE, 'utf8'));
  } catch {
    // No CODEOWNERS means no automatic requests to exclude.
    return [];
  }
}

function gh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function record(lines) {
  const body = `${lines.join('\n')}\n`;
  process.stdout.write(body);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  }
}

// Same stale-entry tolerance as the issue script: a candidate who lost push
// access is dropped with a warning, not a failed run.
function canWrite(repository, login) {
  try {
    return WRITE_PERMISSIONS.has(
      gh([
        'api',
        `repos/${repository}/collaborators/${login}/permission`,
        '--jq',
        '.permission',
      ]),
    );
  } catch (error) {
    console.warn(
      `::warning::Cannot verify push access for @${login}: ${error.message}`,
    );
    return false;
  }
}

// `gh pr view --json files` caps at 100 entries and exposes no pagination
// cursor, so a large PR's area match would silently run on a truncated list;
// the REST files endpoint pages through every changed file instead.
function changedFiles(repository, prNumber) {
  return gh([
    'api',
    `repos/${repository}/pulls/${prNumber}/files`,
    '--paginate',
    '--jq',
    '.[].filename',
  ])
    .split('\n')
    .filter(Boolean)
    .map((filename) => ({ path: filename }));
}

function viewPr(repository, prNumber) {
  const pr = JSON.parse(
    gh([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repository,
      '--json',
      'state,isDraft,author,reviewRequests,latestReviews',
    ]),
  );
  pr.files = changedFiles(repository, prNumber);
  return pr;
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const prNumber = Number(process.env.PR_NUMBER);
  const dryRun = process.env.DRY_RUN === 'true';
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('Invalid repository');
  }
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error('Invalid PR number');
  }

  const policy = loadPolicy(readFileSync(OWNERS_FILE, 'utf8'));
  const codeownersRules = loadCodeownersRules();
  const pr = viewPr(repository, prNumber);

  const skip = skipPrReason(pr);
  if (skip) {
    record([`Review request: skipped — ${skip}`]);
    return;
  }
  // Owners that GitHub's automatic CODEOWNERS handling already requests for
  // these paths: they are never picked (that would only duplicate CODEOWNERS)
  // and never count as coverage (this routing has not happened yet), so the
  // targeted request still fires on top of the auto-requests.
  const codeOwners = codeownersForFiles(codeownersRules, pr.files);
  if (alreadyCovered(policy, pr, codeOwners)) {
    record(['Review request: skipped — a mapped owner is already reviewing']);
    return;
  }

  const area = matchAreaByPath(policy, pr.files);
  if (!area) {
    record(['Review request: skipped — no area path matched']);
    return;
  }

  // Never request the PR author to review their own work, and never pick an
  // owner CODEOWNERS already requested for these paths.
  const eligible = area.owners.filter(
    (owner) =>
      owner.toLowerCase() !== pr.author.login.toLowerCase() &&
      !codeOwners.has(owner.toLowerCase()) &&
      canWrite(repository, owner),
  );
  if (eligible.length === 0) {
    console.warn(
      `::warning::No owner of area ${area.name} besides the author has push access; check ${OWNERS_FILE}.`,
    );
    record([
      `Review request: skipped — no eligible owner for area ${area.name}`,
    ]);
    return;
  }

  const loadByOwner = new Map(
    eligible.map((owner) => [owner, openIssueCount(repository, owner)]),
  );
  const reviewer = pickOwner(eligible, loadByOwner, prNumber);

  if (dryRun) {
    record([
      `Area: ${area.name}`,
      `Review request: dry-run — would request @${reviewer} (${loadByOwner.get(reviewer)} open)`,
    ]);
    return;
  }

  const latestPr = viewPr(repository, prNumber);
  const latestSkip = skipPrReason(latestPr);
  if (latestSkip) {
    record([`Review request: skipped — ${latestSkip}`]);
    return;
  }
  const latestCodeOwners = codeownersForFiles(codeownersRules, latestPr.files);
  if (alreadyCovered(policy, latestPr, latestCodeOwners)) {
    record(['Review request: skipped — a mapped owner is already reviewing']);
    return;
  }
  if (matchAreaByPath(policy, latestPr.files)?.name !== area.name) {
    record(['Review request: skipped — PR files changed']);
    return;
  }

  try {
    gh([
      'pr',
      'edit',
      String(prNumber),
      '--repo',
      repository,
      '--add-reviewer',
      reviewer,
    ]);
  } catch (error) {
    // Fork PRs run this workflow with a read-only GITHUB_TOKEN, so the write
    // 403s. That is expected, not a failure — CODEOWNERS still covers forks.
    if (
      /permission|403|resource not accessible by integration/i.test(
        error.message,
      )
    ) {
      record([
        `Review request: skipped — token cannot request reviewers (fork PR?)`,
      ]);
      return;
    }
    throw error;
  }
  record([
    `Area: ${area.name}`,
    `Review request: requested @${reviewer} (${loadByOwner.get(reviewer)} open)`,
  ]);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

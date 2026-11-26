import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeRepo, candidateFromPull, checkCandidate, findHotspots, indexClaims, isTestPath } from '../src/analyze.js';
import { LONG_BODY, issue, pull, snapshot } from './fixtures.js';

test('classifies issues as contested, claimed, unclaimed and possibly resolved', () => {
  const snap = snapshot({
    issues: [issue(1), issue(2), issue(3), issue(4), issue(5)],
    openPulls: [
      pull(10, { body: 'Fixes #1' }),
      pull(11, { closingIssues: [1] }),
      pull(12, { body: 'Refs #2' }),
      pull(13, { body: 'Related discussion in #5' }),
    ],
    mergedPulls: [pull(9, { state: 'MERGED', body: 'Fixes #3', files: [] })],
  });
  const report = analyzeRepo(snap);

  assert.deepEqual(report.contested.map((c) => c.issue.number), [1]);
  assert.deepEqual(report.contested[0]?.openPulls.map((p) => p.number), [10, 11]);
  assert.deepEqual(report.claimed.map((c) => c.issue.number), [5, 2]);
  assert.equal(report.claimed[0]?.openPulls[0]?.strength, 'mentioned');
  assert.deepEqual(report.possiblyResolved.map((c) => c.issue.number), [3]);
  assert.deepEqual(report.unclaimed.map((i) => i.number), [4]);
});

test('a mention alone does not make an issue contested', () => {
  const snap = snapshot({
    issues: [issue(1)],
    openPulls: [pull(10, { body: 'Fixes #1' }), pull(11, { body: 'Unlike #1, this keeps the cache' })],
  });
  const report = analyzeRepo(snap);
  assert.equal(report.contested.length, 0);
  assert.deepEqual(report.claimed.map((c) => c.issue.number), [1]);
});

test('a PR does not claim its own number and ignores PR-to-PR refs', () => {
  const snap = snapshot({ issues: [issue(1)], openPulls: [pull(10, { body: 'Fixes #10, follows #11' })] });
  const claims = indexClaims(snap);
  assert.equal(claims.get(1)?.openPulls.length, 0);
  assert.equal(claims.has(10), false);
});

test('hotspots need enough PRs and skip ignored paths', () => {
  const pulls = [
    pull(1, { files: ['src/a.ts', '.changeset/x.md', 'pnpm-lock.yaml'] }),
    pull(2, { files: ['src/a.ts', '.changeset/y.md', 'pnpm-lock.yaml'] }),
    pull(3, { files: ['src/a.ts', 'src/b.ts', '.changeset/z.md'] }),
  ];
  assert.deepEqual(findHotspots(pulls), [{ path: 'src/a.ts', pulls: [1, 2, 3] }]);
  assert.deepEqual(findHotspots(pulls, { minHotspotPulls: 2, ignorePaths: [], maxReviewableLines: 600, changesets: 'auto' }).map((h) => h.path), [
    'src/a.ts',
    'pnpm-lock.yaml',
  ]);
});

test('checklist passes for a focused, tested, linked PR', () => {
  const mine = pull(20, {
    body: `Fixes #1\n\n${LONG_BODY}`,
    files: ['src/parser.ts', 'test/parser.test.ts', '.changeset/fix.md'],
  });
  const snap = snapshot({ issues: [issue(1)], openPulls: [mine] });
  const check = checkCandidate(candidateFromPull(mine, snap), snap);

  assert.equal(check.score, 100);
  assert.deepEqual(check.checklist.map((c) => c.id), ['linked-issue', 'tests', 'changeset', 'description', 'size', 'no-competition']);
  assert.deepEqual(check.linkedIssues, [1]);
});

test('checklist flags competition, overlaps and missing pieces', () => {
  const mine = pull(20, {
    body: '<!-- describe your change -->\nFixes #1',
    files: ['src/parser.ts', 'src/lexer.ts'],
    additions: 900,
    deletions: 50,
  });
  const rival = pull(21, { body: 'Closes #1', files: ['src/parser.ts', '.changeset/a.md'] });
  const neighbour = pull(22, { files: ['src/lexer.ts', 'src/parser.ts', 'README.md'] });
  const unrelated = pull(23, { files: ['docs/index.md'] });
  const snap = snapshot({ issues: [issue(1)], openPulls: [mine, rival, neighbour, unrelated] });
  const check = checkCandidate(candidateFromPull(mine, snap), snap);

  const failed = check.checklist.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(failed, ['tests', 'changeset', 'description', 'size', 'no-competition']);
  assert.deepEqual(check.competing, [{ issue: 1, pulls: [21] }]);
  assert.deepEqual(
    check.overlaps.map((o) => [o.number, o.shared]),
    [
      [22, ['src/lexer.ts', 'src/parser.ts']],
      [21, ['src/parser.ts']],
    ],
  );
  assert.equal(check.score, 17);
});

test('changeset check is skipped for repos that do not use changesets', () => {
  const mine = pull(20, { body: LONG_BODY, files: ['lib/x.py', 'tests/test_x.py'] });
  const snap = snapshot({ openPulls: [mine] });
  const check = checkCandidate(candidateFromPull(mine, snap), snap);
  assert.equal(check.checklist.some((c) => c.id === 'changeset'), false);
});

test('branch checks warn when the repo does not take your PR', () => {
  const policy = { isArchived: false, viewerPermission: 'READ', contributingPath: 'CONTRIBUTING.md', contributingText: 'Pull requests are limited to repository collaborators.' };
  const snap = snapshot({ viewer: 'sam', policy, issues: [issue(1)] });
  const branch = { ...candidateFromPull(pull(0, { body: `Fixes #1\n${LONG_BODY}`, files: ['test/a.test.ts'] }), snap), exclude: [], checkPolicy: true };

  const blocked = checkCandidate(branch, snap);
  assert.equal(blocked.checklist[0]?.id, 'policy');
  assert.equal(blocked.checklist[0]?.ok, false);
  assert.match(blocked.checklist[0]?.detail ?? '', /CONTRIBUTING.md: "Pull requests are limited to repository collaborators."/);

  const asMember = checkCandidate(branch, { ...snap, policy: { ...policy, viewerPermission: 'MAINTAIN' } });
  assert.equal(asMember.checklist[0]?.ok, true);

  const firstStep = { ...snap, policy: { ...policy, contributingText: 'Please open an issue first.' } };
  assert.equal(checkCandidate(branch, firstStep).checklist[0]?.ok, true, 'linked issue satisfies the first step');
  assert.equal(checkCandidate({ ...branch, linkedIssues: [] }, firstStep).checklist[0]?.ok, false);

  const prCheck = checkCandidate(candidateFromPull(pull(5), snap), snap);
  assert.equal(prCheck.checklist.some((c) => c.id === 'policy'), false, 'existing PRs are not policy-checked');
});

test('truncated file lists are reported', () => {
  const big = pull(20, { files: ['a.ts'], changedFiles: 250 });
  const snap = snapshot({ openPulls: [big] });
  assert.equal(checkCandidate(candidateFromPull(big, snap), snap).filesTruncated, true);
});

test('recognises common test file layouts', () => {
  for (const p of ['test/a.ts', 'packages/x/tests/b.js', 'src/__tests__/c.tsx', 'src/d.test.ts', 'e.spec.mjs', 'pkg/f_test.go', 'tests/test_g.py', 'h/test_i.py']) {
    assert.equal(isTestPath(p), true, p);
  }
  for (const p of ['src/testing.ts', 'docs/test-plan.md', 'src/latest.ts']) {
    assert.equal(isTestPath(p), false, p);
  }
});

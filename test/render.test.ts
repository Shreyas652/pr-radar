import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeRepo, candidateFromPull, checkCandidate } from '../src/analyze.js';
import { assessPolicy } from '../src/policy.js';
import { COMMENT_MARKER, cell, renderPolicy, renderPullCheck, renderRepoReport } from '../src/render.js';
import { issue, pull, snapshot } from './fixtures.js';

test('cell escapes pipes, backslashes and newlines', () => {
  assert.equal(cell('a | b\\c\nd'), 'a \\| b\\\\c d');
});

test('repo report lists every section and caps rows', () => {
  const snap = snapshot({
    issues: [issue(1, { title: 'Crash | on start', labels: ['bug'] }), issue(2), issue(3)],
    openPulls: [pull(10, { body: 'Fixes #1' }), pull(11, { body: 'Fixes #1', isDraft: true })],
  });
  const md = renderRepoReport(analyzeRepo(snap), 1);

  for (const heading of ['Contested issues (1)', 'Possibly resolved (0)', 'Unclaimed issues (2)', 'Claimed issues (0)', 'Conflict hotspots (0)', 'Open PR checklist (2)']) {
    assert.ok(md.includes(`## ${heading}`), heading);
  }
  assert.ok(md.includes('#1 Crash \\| on start | #10 (@dev10), #11 (@dev11, draft)'));
  assert.ok(md.includes('…and 1 more'));
});

test('policy renders verdict, source, access and quotes', () => {
  const policy = assessPolicy(
    { isArchived: false, viewerPermission: 'READ', contributingPath: '.github/CONTRIBUTING.md', contributingText: 'We are not accepting pull requests. Sign the CLA.' },
    'sam',
  );
  const md = renderPolicy(policy, 'acme/widgets');
  assert.ok(md.startsWith('# pr-radar policy: acme/widgets'));
  assert.ok(md.includes('**⛔ Outside PRs not accepted.**'));
  assert.ok(md.includes('Guide: `.github/CONTRIBUTING.md` · Your access: READ (@sam)'));
  assert.ok(md.includes('> We are not accepting pull requests.'));
  assert.ok(md.includes('- Requires a CLA or DCO sign-off.'));

  const scan = renderRepoReport(analyzeRepo(snapshot({ policy: { isArchived: false, contributingText: 'PRs welcome' } })));
  assert.ok(scan.includes('## Contribution policy\n\n**✅ Open to your PRs.**'));
});

test('pull check starts with the sticky-comment marker', () => {
  const mine = pull(20, { body: 'Fixes #1', files: ['src/a.ts'] });
  const other = pull(21, { files: ['src/a.ts'] });
  const snap = snapshot({ issues: [issue(1)], openPulls: [mine, other] });
  const md = renderPullCheck(checkCandidate(candidateFromPull(mine, snap), snap), 'acme/widgets');

  assert.ok(md.startsWith(COMMENT_MARKER));
  assert.ok(md.includes('✅ **Linked issue**: #1'));
  assert.ok(md.includes('⚠️ **Tests**: no test files changed'));
  assert.ok(md.includes('| #21 PR 21 (@dev21) | `src/a.ts` |'));
});

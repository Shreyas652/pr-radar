import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessContributingText, assessPolicy } from '../src/policy.js';

const status = (text: string) => assessContributingText(text).status;

test('detects guides that close the door to outside PRs', () => {
  const closed = [
    // Wording from openai/openai-agents-js CONTRIBUTING.md, including its bold markup.
    '**Pull requests are limited to repository collaborators. We do not accept pull requests from non-collaborators**, including documentation or example changes.',
    'We are not accepting pull requests at this time.',
    "We don't accept pull requests.",
    'This project is not currently accepting external contributions.',
    'We only accept pull requests from members of the core team.',
    'We will not merge PRs from outside contributors.',
    "We won't accept PRs from the community.",
    'PRs from non-members are closed automatically.',
  ];
  for (const text of closed) assert.equal(status(text), 'closed', text);
});

test('detects guides that ask for a first step', () => {
  const restricted = [
    'Please open an issue first so we can agree on the approach.',
    'Before submitting a pull request, open an issue to discuss the change.',
    'Large changes should be discussed in an issue before you open a PR.',
    'Unsolicited pull requests may be closed.',
    'We do not accept pull requests that only fix typos.',
    'Pull requests without a linked issue will be closed.',
    // ghostty-org/ghostty's vouch system, with its mid-sentence line break.
    "If you aren't vouched, any pull requests you open will be\nautomatically closed.",
    '5. Once approved, you can submit PRs',
  ];
  for (const text of restricted) assert.equal(status(text), 'restricted', text);
});

test('welcoming guides are open', () => {
  const open = [
    'We welcome contributions from the community! Fork the repo and open a pull request.',
    'Pull requests are welcome. Run the tests before submitting.',
    'Contributions from outside contributors are very welcome.',
    'Stale pull requests will be closed after 30 days of inactivity.',
    'We do not review draft PRs.',
  ];
  for (const text of open) assert.equal(status(text), 'open', text);
});

test('ignores comments and code blocks, quotes evidence, and notes CLAs', () => {
  const text = [
    '<!-- We do not accept pull requests. (template example) -->',
    '```',
    'echo "We are not accepting pull requests"',
    '```',
    'You need to sign the [Contributor License Agreement](https://cla.example) first.',
  ].join('\n');
  const result = assessContributingText(text);
  assert.equal(result.status, 'open');
  assert.deepEqual(result.notes, ['Requires a CLA or DCO sign-off.']);

  const closed = assessContributingText('# Contributing\n\nThanks!\n\nWe are not accepting pull requests at this time.');
  assert.deepEqual(closed.evidence, ['We are not accepting pull requests at this time.']);
});

test('missing guide is unknown', () => {
  assert.equal(assessContributingText(undefined).status, 'unknown');
  assert.equal(assessPolicy({ isArchived: false, viewerPermission: 'READ' }).verdict, 'unknown');
});

test('verdict depends on who is asking', () => {
  const closedGuide = 'Pull requests are limited to repository collaborators.';
  const outsider = assessPolicy({ isArchived: false, viewerPermission: 'READ', contributingPath: 'CONTRIBUTING.md', contributingText: closedGuide }, 'sam');
  assert.equal(outsider.verdict, 'blocked');
  assert.equal(outsider.isCollaborator, false);
  assert.match(outsider.summary, /@sam is not one/);

  const member = assessPolicy({ isArchived: false, viewerPermission: 'WRITE', contributingText: closedGuide }, 'sam');
  assert.equal(member.verdict, 'ok');
  assert.equal(member.isCollaborator, true);

  assert.equal(assessPolicy({ isArchived: true, viewerPermission: 'ADMIN', contributingText: 'PRs welcome' }).verdict, 'blocked');
  assert.equal(assessPolicy({ isArchived: false, contributingText: 'Open an issue first.' }).verdict, 'caution');
  assert.equal(assessPolicy(undefined).verdict, 'unknown');
});

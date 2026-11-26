import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractIssueRefs } from '../src/refs.js';

const refs = (text: string) => extractIssueRefs(text, 'acme', 'widgets');

test('linking words mark refs as linked', () => {
  assert.deepEqual(refs('Fixes #12'), { linked: [12], mentioned: [] });
  assert.deepEqual(refs('Refs #7'), { linked: [7], mentioned: [] });
  assert.deepEqual(refs('closes #1, #2 and #3'), { linked: [1, 2, 3], mentioned: [] });
  assert.deepEqual(refs('Part of #40'), { linked: [40], mentioned: [] });
});

test('refs without a linking word are mentions', () => {
  assert.deepEqual(refs('Matches the behaviour from #2278'), { linked: [], mentioned: [2278] });
});

test('a sentence break ends the linking clause', () => {
  assert.deepEqual(refs('Fixes #1. Similar to #2'), { linked: [1], mentioned: [2] });
});

test('a number both linked and mentioned counts as linked', () => {
  assert.deepEqual(refs('See #5\nFixes #5'), { linked: [5], mentioned: [] });
});

test('qualified refs and URLs count only for the same repo', () => {
  assert.deepEqual(refs('Fixes acme/widgets#9 and other/repo#10'), { linked: [9], mentioned: [] });
  assert.deepEqual(refs('Fixes ACME/Widgets#11'), { linked: [11], mentioned: [] });
  assert.deepEqual(refs('fixes https://github.com/acme/widgets/issues/21'), { linked: [21], mentioned: [] });
  assert.deepEqual(refs('fixes https://github.com/other/repo/issues/22'), { linked: [], mentioned: [] });
});

test('ignores HTML comments, code, entities and mid-word hashes', () => {
  const text = [
    '<!-- Fixes #123 (replace with your issue) -->',
    '```\nfixes #55\n```',
    'Use `fixes #66` syntax',
    'It&#39;s fine, color abc#77',
  ].join('\n');
  assert.deepEqual(refs(text), { linked: [], mentioned: [] });
});

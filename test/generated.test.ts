import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeneratedMatcher, parseGitattributes, patternToRegExp } from '../src/generated.js';

test('gitattributes patterns match like git does', () => {
  const cases: [string, string, boolean][] = [
    ['*.min.js', 'vendor/jquery.min.js', true],
    ['*.min.js', 'src/app.js', false],
    ['go.sum', 'tools/go.sum', true],
    ['dist/**', 'dist/src/cli.js', true],
    ['dist/**', 'packages/a/dist/x.js', false],
    ['**/dist/**', 'packages/a/dist/x.js', true],
    ['**/dist/**', 'src/distance.ts', false],
    ['/generated/*.ts', 'generated/api.ts', true],
    ['/generated/*.ts', 'generated/deep/api.ts', false],
    ['docs/api/', 'docs/api/index.md', true],
    ['file?.txt', 'file1.txt', true],
    ['a+b.txt', 'a+b.txt', true],
  ];
  for (const [pattern, path, expected] of cases) assert.equal(patternToRegExp(pattern).test(path), expected, `${pattern} ~ ${path}`);
});

test('reads linguist-generated settings and skips everything else', () => {
  const text = [
    '# comment',
    '* text=auto eol=lf',
    'dist/** linguist-generated=true',
    'api/*.pb.go linguist-generated',
    'vendor/** -linguist-generated',
    'docs/gen/** linguist-generated=false',
    '[attr]binary -diff -merge -text',
    '*.png binary',
  ].join('\r\n');
  assert.deepEqual(parseGitattributes(text), [
    { pattern: 'dist/**', generated: true },
    { pattern: 'api/*.pb.go', generated: true },
    { pattern: 'vendor/**', generated: false },
    { pattern: 'docs/gen/**', generated: false },
  ]);
});

test('defaults cover build output, lockfiles and snapshots, but not build/', () => {
  const m = GeneratedMatcher.forRepo();
  for (const p of ['dist/index.js', 'packages/core/dist/a.d.ts', 'pnpm-lock.yaml', 'apps/web/package-lock.json', 'src/__snapshots__/a.test.ts.snap', 'assets/app.min.css', 'out/app.js.map']) {
    assert.equal(m.isGenerated(p), true, p);
  }
  for (const p of ['src/index.ts', 'build/gulpfile.js', 'README.md', 'distribution.md']) {
    assert.equal(m.isGenerated(p), false, p);
  }
});

test('later rules win: the repo and extra patterns override defaults', () => {
  const m = GeneratedMatcher.forRepo('dist/** -linguist-generated\nsrc/gen/** linguist-generated', ['schema/*.json']);
  assert.equal(m.isGenerated('dist/index.js'), false);
  assert.equal(m.isGenerated('packages/a/dist/index.js'), true, 'only the root dist was switched off');
  assert.equal(m.isGenerated('src/gen/client.ts'), true);
  assert.equal(m.isGenerated('schema/v1.json'), true);
});

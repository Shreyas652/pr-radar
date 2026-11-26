import assert from 'node:assert/strict';
import { test } from 'node:test';
import { command, getInput, readPullEvent, runAction, upsertComment, type ActionIO } from '../src/action.js';
import { GitHubClient } from '../src/github.js';
import { COMMENT_MARKER, noMention, renderPullCheck } from '../src/render.js';
import { checkCandidate, candidateFromPull } from '../src/analyze.js';
import { pull, snapshot } from './fixtures.js';

interface Call {
  method: string;
  url: string;
  body?: { query?: string; variables?: Record<string, unknown>; body?: string };
}

const empty = { pageInfo: { hasNextPage: false, endCursor: null } };

function rawPull(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `u${number}`,
    isDraft: false,
    body: '',
    headRefName: `b${number}`,
    createdAt: 'c',
    updatedAt: 'u',
    additions: 5,
    deletions: 1,
    changedFiles: 1,
    author: { login: `dev${number}` },
    closingIssuesReferences: { nodes: [] },
    files: { nodes: [{ path: 'src/a.ts' }] },
    ...extra,
  };
}

/**
 * A fake GitHub. GraphQL answers come from the query text; REST answers from `rest`,
 * keyed by "METHOD path", returning [status, body].
 */
function fakeGitHub(options: { rest?: Record<string, [number, unknown]>; openPulls?: unknown[]; target?: unknown } = {}) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Call['body']) : undefined;
    calls.push({ method: String(init.method), url, body });
    if (url.endsWith('/graphql')) {
      const q = body?.query ?? '';
      let data: unknown;
      if (q.includes('isArchived')) data = { repository: { isArchived: false, viewerPermission: 'WRITE', c2: { text: 'PRs welcome' } } };
      else if (q.includes('viewer {')) return new Response(JSON.stringify({ errors: [{ message: 'Resource not accessible by integration' }] }));
      else if (q.includes('pullRequest(number')) data = { repository: { pullRequest: options.target ?? { state: 'OPEN', ...rawPull(7, { body: 'Fixes #1' }) } } };
      else if (q.includes('issues(')) data = { repository: { issues: { ...empty, nodes: [] } } };
      else if (q.includes('MERGED')) data = { repository: { pullRequests: { ...empty, nodes: [] } } };
      else data = { repository: { pullRequests: { ...empty, nodes: options.openPulls ?? [] } } };
      return new Response(JSON.stringify({ data }));
    }
    const key = `${init.method} ${url.replace('https://api.example.test', '')}`;
    const [status, payload] = options.rest?.[key] ?? [200, {}];
    return new Response(JSON.stringify(payload), { status });
  };
  return { impl, calls };
}

function memoryIO(files: Record<string, string> = {}) {
  const lines: string[] = [];
  const io: ActionIO = {
    log: (line) => lines.push(line),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    appendFile: (path, text) => {
      files[path] = (files[path] ?? '') + text;
    },
  };
  return { io, lines, files };
}

const EVENT = JSON.stringify({ pull_request: { number: 7 }, repository: { full_name: 'acme/widgets' } });
const baseEnv = {
  GITHUB_EVENT_PATH: 'event.json',
  GITHUB_API_URL: 'https://api.example.test',
  GITHUB_STEP_SUMMARY: 'summary.md',
  GITHUB_OUTPUT: 'output.txt',
  'INPUT_GITHUB-TOKEN': 'tok',
};
const commentsPath = '/repos/acme/widgets/issues/7/comments?per_page=100&page=1';

test('reads inputs the way Actions passes them', () => {
  assert.equal(getInput({ 'INPUT_GITHUB-TOKEN': ' t ' }, 'github-token'), 't');
  assert.equal(getInput({ INPUT_MY_INPUT: 'x' }, 'my input'), 'x');
  assert.equal(getInput({}, 'comment'), '');
});

test('escapes workflow command messages', () => {
  assert.equal(command('warning', '50% done\nnext'), '::warning::50%25 done%0Anext');
});

test('reads the PR from pull_request events and ignores other events', () => {
  const { io } = memoryIO({ 'e.json': EVENT, 'push.json': '{"ref":"refs/heads/main"}' });
  assert.deepEqual(readPullEvent({ GITHUB_EVENT_PATH: 'e.json' }, io), { owner: 'acme', name: 'widgets', number: 7 });
  assert.equal(readPullEvent({ GITHUB_EVENT_PATH: 'push.json' }, io), undefined);
  assert.equal(readPullEvent({}, io), undefined);
});

test('skips with a warning outside pull request events', async () => {
  const { io, lines } = memoryIO({ 'event.json': '{"ref":"refs/heads/main"}' });
  assert.equal(await runAction(baseEnv, fakeGitHub().impl, io), 0);
  assert.match(lines[0] ?? '', /^::warning::pr-radar only runs on pull_request/);
});

test('creates a comment, writes the summary and outputs, and compares against other PRs', async () => {
  const { impl, calls } = fakeGitHub({
    openPulls: [rawPull(8, { body: 'Closes #1', author: { login: 'rival' } }), rawPull(9)],
    rest: { [`GET ${commentsPath}`]: [200, [{ id: 1, body: 'Nice work!' }]] },
  });
  const { io, files, lines } = memoryIO({ 'event.json': EVENT });

  assert.equal(await runAction(baseEnv, impl, io), 0);

  const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/7/comments'));
  assert.ok(post, 'posts a new comment');
  const body = post.body?.body ?? '';
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.ok(body.includes('#1 also targeted by #8'));
  assert.ok(body.includes('(rival)'), 'author shown without an @ mention');
  assert.equal(body.includes('@rival'), false);
  assert.equal(files['summary.md'], `${body}\n`);
  assert.match(files['output.txt'] ?? '', /^score=\d+\ncompeting=1\noverlaps=2\n$/);
  assert.ok(lines.includes('pr-radar: created the PR comment.'));
  assert.ok(calls.every((c) => c.url.startsWith('https://api.example.test')), 'uses GITHUB_API_URL');
});

test('updates the earlier pr-radar comment instead of adding another', async () => {
  const { impl, calls } = fakeGitHub({
    rest: { [`GET ${commentsPath}`]: [200, [{ id: 1, body: 'hi' }, { id: 42, body: `${COMMENT_MARKER}\nold report` }]] },
  });
  const { io } = memoryIO({ 'event.json': EVENT });
  assert.equal(await runAction(baseEnv, impl, io), 0);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/issues/comments/42')));
  assert.equal(calls.some((c) => c.method === 'POST' && c.url.endsWith('/comments')), false);
});

test('skips a marked comment it cannot edit and creates its own', async () => {
  const client = new GitHubClient(
    't',
    fakeGitHub({
      rest: {
        [`GET ${commentsPath}`]: [200, [{ id: 5, body: `${COMMENT_MARKER} copied by a human` }]],
        'PATCH /repos/acme/widgets/issues/comments/5': [403, { message: 'Forbidden' }],
      },
    }).impl,
    { apiUrl: 'https://api.example.test' },
  );
  assert.equal(await upsertComment(client, { owner: 'acme', name: 'widgets', number: 7 }, 'x'), 'created');
});

test('pages through long comment threads', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'chatter' }));
  const { impl, calls } = fakeGitHub({
    rest: {
      [`GET ${commentsPath}`]: [200, page1],
      'GET /repos/acme/widgets/issues/7/comments?per_page=100&page=2': [200, [{ id: 500, body: COMMENT_MARKER }]],
    },
  });
  const client = new GitHubClient('t', impl, { apiUrl: 'https://api.example.test' });
  assert.equal(await upsertComment(client, { owner: 'acme', name: 'widgets', number: 7 }, 'x'), 'updated');
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/comments/500')));
});

test('a read-only token (fork PR) warns instead of failing', async () => {
  const { impl } = fakeGitHub({
    rest: {
      [`GET ${commentsPath}`]: [200, []],
      'POST /repos/acme/widgets/issues/7/comments': [403, { message: 'Resource not accessible by integration' }],
    },
  });
  const { io, lines, files } = memoryIO({ 'event.json': EVENT });
  assert.equal(await runAction(baseEnv, impl, io), 0);
  assert.ok(lines.some((l) => l.startsWith('::warning::pr-radar could not comment')));
  assert.ok(files['summary.md']?.startsWith(COMMENT_MARKER), 'summary still written');
});

test('other API errors still fail the run', async () => {
  const { impl } = fakeGitHub({ rest: { [`GET ${commentsPath}`]: [500, { message: 'boom' }] } });
  const { io } = memoryIO({ 'event.json': EVENT });
  await assert.rejects(runAction(baseEnv, impl, io), /500 boom/);
});

test('fail-under fails low scores, and comment=false skips commenting', async () => {
  const { impl, calls } = fakeGitHub();
  const { io, lines } = memoryIO({ 'event.json': EVENT });
  const code = await runAction({ ...baseEnv, 'INPUT_FAIL-UNDER': '100', INPUT_COMMENT: 'false' }, impl, io);
  assert.equal(code, 1);
  // Workflow commands escape "%" as "%25"; the runner shows it as "%".
  assert.ok(lines.some((l) => /^::error::pr-radar score \d+%25 is below the required 100%25\./.test(l)));
  assert.equal(calls.some((c) => !c.url.endsWith('/graphql')), false, 'no REST calls');
});

test('rejects bad numeric inputs', async () => {
  const { io } = memoryIO({ 'event.json': EVENT });
  await assert.rejects(runAction({ ...baseEnv, 'INPUT_MAX-PRS': 'lots' }, fakeGitHub().impl, io), /"max-prs" must be a non-negative integer/);
});

test('the PR under review is checked even when it is outside the open PR window', async () => {
  const { impl, calls } = fakeGitHub({ openPulls: [rawPull(8, { body: 'Fixes #1' })] });
  const { io, files } = memoryIO({ 'event.json': EVENT });
  await runAction({ ...baseEnv, INPUT_COMMENT: 'false' }, impl, io);
  assert.ok(calls.some((c) => c.body?.query?.includes('pullRequest(number') && c.body.variables?.number === 7));
  assert.ok(files['summary.md']?.includes('### pr-radar: #7 PR 7'));
  assert.ok(files['summary.md']?.includes('#1 also targeted by #8'));
});

test('comment mode neutralises mentions in titles and details', () => {
  assert.equal(noMention('cc @octocat and @org/team, mail a@b.c'), 'cc @​octocat and @​org/team, mail a@​b.c');
  const mine = pull(20, { title: 'Ping @everyone', files: ['src/a.ts'] });
  const other = pull(21, { title: 'Also @octocat', author: 'octo', files: ['src/a.ts'] });
  const snap = snapshot({ openPulls: [mine, other] });
  const md = renderPullCheck(checkCandidate(candidateFromPull(mine, snap), snap), 'acme/widgets', { mentions: false });
  assert.equal(/@(?=\w)/.test(md), false, md);
  assert.ok(md.includes('(octo)'));
});

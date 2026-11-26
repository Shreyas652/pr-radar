import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGitHubRemote, parseNumstat } from '../src/git.js';
import { CONTRIBUTING_PATHS, GitHubClient, collectPages, fetchPolicyInfo, fetchSnapshot, resolveToken } from '../src/github.js';

function fakeFetch(handler: (body: { query: string; variables: Record<string, unknown> }) => unknown) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const impl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    return new Response(JSON.stringify(handler(body)), { status: 200 });
  };
  return { impl, calls };
}

test('collectPages follows cursors and stops at the limit', async () => {
  const pages: Record<string, { nodes: number[]; next: string | null }> = {
    start: { nodes: [1, 2], next: 'c1' },
    c1: { nodes: [3, 4], next: 'c2' },
    c2: { nodes: [5], next: null },
  };
  const { impl, calls } = fakeFetch(({ variables }) => {
    const page = pages[(variables.cursor as string | null) ?? 'start']!;
    return { data: { items: { nodes: page.nodes, pageInfo: { hasNextPage: page.next !== null, endCursor: page.next } } } };
  });
  const client = new GitHubClient('t', impl);
  type D = { items: { nodes: number[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };

  assert.deepEqual(await collectPages(client, 'q', {}, (d: D) => d.items, 10), [1, 2, 3, 4, 5]);
  assert.equal(calls.length, 3);
  assert.deepEqual(await collectPages(client, 'q', {}, (d: D) => d.items, 3), [1, 2, 3]);
});

test('GraphQL errors surface as exceptions', async () => {
  const { impl } = fakeFetch(() => ({ errors: [{ message: 'Bad credentials' }] }));
  await assert.rejects(new GitHubClient('t', impl).graphql('q', {}), /Bad credentials/);
});

test('fetchSnapshot maps raw nodes and tolerates a missing viewer', async () => {
  const empty = { pageInfo: { hasNextPage: false, endCursor: null } };
  const { impl } = fakeFetch(({ query }) => {
    if (query.includes('isArchived')) {
      return { data: { repository: { isArchived: false, viewerPermission: 'READ', c0: null, c1: null, c2: { text: 'PRs welcome' } } } };
    }
    if (query.includes('viewer {')) return { errors: [{ message: 'no viewer for app tokens' }] };
    if (query.includes('issues(')) {
      return {
        data: {
          repository: {
            issues: {
              ...empty,
              nodes: [
                {
                  number: 1,
                  title: 'Bug',
                  url: 'u',
                  createdAt: 'c',
                  updatedAt: 'u',
                  author: null,
                  labels: { nodes: [{ name: 'bug' }] },
                  assignees: { nodes: [] },
                  comments: { totalCount: 3 },
                },
              ],
            },
          },
        },
      };
    }
    const merged = query.includes('MERGED');
    return {
      data: {
        repository: {
          pullRequests: {
            ...empty,
            nodes: [
              {
                number: merged ? 5 : 6,
                title: 'PR',
                url: 'u',
                isDraft: false,
                body: null,
                headRefName: 'h',
                createdAt: 'c',
                updatedAt: 'u',
                additions: 1,
                deletions: 1,
                changedFiles: 1,
                author: { login: 'dev' },
                closingIssuesReferences: { nodes: [{ number: 1 }] },
                ...(merged ? {} : { files: { nodes: [{ path: 'a.ts' }] } }),
              },
            ],
          },
        },
      },
    };
  });

  const snap = await fetchSnapshot(new GitHubClient('t', impl), 'acme', 'widgets', undefined, () => new Date('2026-11-26T00:00:00Z'));
  assert.equal(snap.viewer, undefined);
  assert.deepEqual(snap.policy, { isArchived: false, viewerPermission: 'READ', contributingPath: 'CONTRIBUTING.md', contributingText: 'PRs welcome' });
  assert.equal(snap.fetchedAt, '2026-11-26T00:00:00.000Z');
  assert.deepEqual(snap.issues[0], {
    number: 1,
    title: 'Bug',
    url: 'u',
    author: 'ghost',
    labels: ['bug'],
    assignees: [],
    comments: 3,
    createdAt: 'c',
    updatedAt: 'u',
  });
  assert.deepEqual(snap.openPulls[0]?.files, ['a.ts']);
  assert.equal(snap.openPulls[0]?.body, '');
  assert.equal(snap.mergedPulls[0]?.state, 'MERGED');
  assert.deepEqual(snap.mergedPulls[0]?.files, []);
  assert.deepEqual(snap.mergedPulls[0]?.closingIssues, [1]);
});

test('missing repository gives a clear error', async () => {
  const { impl } = fakeFetch(({ query }) => (query.includes('viewer {') ? { data: { viewer: { login: 'me' } } } : { data: { repository: null } }));
  await assert.rejects(fetchSnapshot(new GitHubClient('t', impl), 'acme', 'nope'), /acme\/nope not found/);
  await assert.rejects(fetchPolicyInfo(new GitHubClient('t', impl), 'acme', 'nope'), /acme\/nope not found/);
});

test('fetchPolicyInfo takes the first guide in GitHub lookup order', async () => {
  const { impl, calls } = fakeFetch(() => ({
    data: { repository: { isArchived: true, viewerPermission: null, c0: null, c1: { text: 'from .github' }, c2: { text: 'from root' } } },
  }));
  const info = await fetchPolicyInfo(new GitHubClient('t', impl), 'acme', 'widgets');
  assert.deepEqual(info, { isArchived: true, viewerPermission: undefined, contributingPath: CONTRIBUTING_PATHS[1], contributingText: 'from .github' });
  assert.ok(calls[0]?.query.includes('"HEAD:.github/CONTRIBUTING.md"'));
  assert.equal(calls.length, 1, 'no owner fallback when the repo has its own guide');
});

test('fetchPolicyInfo falls back to the owner .github repository', async () => {
  const { impl, calls } = fakeFetch(({ query }) =>
    query.includes('isArchived')
      ? { data: { repository: { isArchived: false, viewerPermission: 'READ' } } }
      : { data: { repository: { c3: { text: 'org-wide guide' } } } },
  );
  const info = await fetchPolicyInfo(new GitHubClient('t', impl), 'acme', 'widgets');
  assert.equal(info.contributingPath, 'acme/.github:contributing.md');
  assert.equal(info.contributingText, 'org-wide guide');
  assert.deepEqual(calls[1]?.variables, { owner: 'acme' });
});

test('fetchPolicyInfo survives a missing owner .github repository', async () => {
  const { impl } = fakeFetch(({ query }) =>
    query.includes('isArchived') ? { data: { repository: { isArchived: false, viewerPermission: 'READ' } } } : { errors: [{ message: 'not found' }] },
  );
  assert.deepEqual(await fetchPolicyInfo(new GitHubClient('t', impl), 'acme', 'widgets'), { isArchived: false, viewerPermission: 'READ' });
});

test('resolveToken prefers environment variables', () => {
  assert.equal(resolveToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }), 'a');
  assert.equal(resolveToken({ GH_TOKEN: 'b' }), 'b');
});

test('parses GitHub remotes and numstat output', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/openai/openai-agents-js.git'), { owner: 'openai', name: 'openai-agents-js' });
  assert.deepEqual(parseGitHubRemote('git@github.com:acme/widgets.git'), { owner: 'acme', name: 'widgets' });
  assert.deepEqual(parseGitHubRemote('https://github.com/acme/widgets/'), { owner: 'acme', name: 'widgets' });
  assert.equal(parseGitHubRemote('https://gitlab.com/acme/widgets.git'), undefined);
  assert.deepEqual(parseNumstat('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n\n10\t0\tdir with\ttab.ts'), {
    files: ['src/a.ts', 'logo.png', 'dir with\ttab.ts'],
    additions: 13,
    deletions: 1,
  });
});

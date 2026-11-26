import { execFileSync } from 'node:child_process';
import type { Issue, PullRequest, RepoPolicyInfo, RepoSnapshot } from './types.js';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function resolveToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (token) return token;
  } catch {
    // gh is not installed or not logged in; fall through to the error below.
  }
  throw new Error('No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.');
}

export interface ClientUrls {
  /** REST base URL. Actions sets GITHUB_API_URL, which also covers GitHub Enterprise Server. */
  apiUrl?: string;
  /** GraphQL endpoint. Actions sets GITHUB_GRAPHQL_URL. */
  graphqlUrl?: string;
}

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class GitHubClient {
  private readonly apiUrl: string;
  private readonly graphqlUrl: string;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    urls: ClientUrls = {},
  ) {
    this.apiUrl = (urls.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.graphqlUrl = urls.graphqlUrl ?? `${this.apiUrl}/graphql`;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `bearer ${this.token}`,
      'content-type': 'application/json',
      accept: 'application/vnd.github+json',
      'user-agent': 'pr-radar',
    };
  }

  async rest<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let message = res.statusText;
      try {
        message = (JSON.parse(detail) as { message?: string }).message ?? message;
      } catch {
        // Not JSON; keep the status text.
      }
      throw new GitHubRequestError(`GitHub ${method} ${path} failed: ${res.status} ${message}`, res.status);
    }
    return (await res.json()) as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.graphqlUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new GitHubRequestError(`GitHub GraphQL request failed: ${res.status} ${res.statusText}`, res.status);
    }
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data) throw new Error('GitHub GraphQL response had no data');
    return json.data;
  }
}

interface Connection<N> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: N[];
}

/** Follows GraphQL cursors until `limit` nodes are collected or pages run out. */
export async function collectPages<D, N>(
  client: GitHubClient,
  query: string,
  variables: Record<string, unknown>,
  select: (data: D) => Connection<N>,
  limit: number,
): Promise<N[]> {
  const out: N[] = [];
  let cursor: string | null = null;
  while (out.length < limit) {
    const data: D = await client.graphql<D>(query, { ...variables, cursor });
    const conn = select(data);
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out.slice(0, limit);
}

const ISSUES_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url createdAt updatedAt
        author { login }
        labels(first: 20) { nodes { name } }
        assignees(first: 10) { nodes { login } }
        comments { totalCount }
      }
    }
  }
}`;

const PR_FIELDS = `
  number title url isDraft body headRefName createdAt updatedAt additions deletions changedFiles
  author { login }
  closingIssuesReferences(first: 10) { nodes { number } }`;

const OPEN_PRS_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 25, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${PR_FIELDS}
        files(first: 100) { nodes { path } }
      }
    }
  }
}`;

const MERGED_PRS_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }
  }
}`;

const PULL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      ${PR_FIELDS}
      files(first: 100) { nodes { path } }
    }
  }
}`;

const VIEWER_QUERY = `query { viewer { login } }`;

/** Where GitHub looks for a contributing guide, in its own lookup order. */
export const CONTRIBUTING_PATHS = [
  '.github/CONTRIBUTING.md',
  '.github/contributing.md',
  'CONTRIBUTING.md',
  'contributing.md',
  'CONTRIBUTING.rst',
  'CONTRIBUTING',
  'docs/CONTRIBUTING.md',
  'docs/contributing.md',
];

const GUIDE_FIELDS = CONTRIBUTING_PATHS.map(
  (p, i) => `c${i}: object(expression: ${JSON.stringify(`HEAD:${p}`)}) { ... on Blob { text } }`,
).join('\n    ');

const POLICY_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    isArchived
    viewerPermission
    ${GUIDE_FIELDS}
  }
}`;

/** GitHub shows an owner's `.github` repository guide for repos that have none. */
const OWNER_DEFAULTS_QUERY = `
query($owner: String!) {
  repository(owner: $owner, name: ".github") {
    ${GUIDE_FIELDS}
  }
}`;

type GuideFields = Record<string, { text?: string | null } | null | boolean | string>;
type PolicyData = { repository: ({ isArchived: boolean; viewerPermission: string | null } & GuideFields) | null };

function firstGuide(fields: GuideFields | null | undefined): { path: string; text: string } | undefined {
  if (!fields) return undefined;
  for (const [i, path] of CONTRIBUTING_PATHS.entries()) {
    const blob = fields[`c${i}`];
    if (blob && typeof blob === 'object' && typeof blob.text === 'string') return { path, text: blob.text };
  }
  return undefined;
}

export async function fetchPolicyInfo(client: GitHubClient, owner: string, name: string): Promise<RepoPolicyInfo> {
  const data = await client.graphql<PolicyData>(POLICY_QUERY, { owner, name });
  const repo = data.repository;
  if (!repo) throw new Error(`Repository ${owner}/${name} not found or not accessible`);

  const info: RepoPolicyInfo = { isArchived: repo.isArchived, viewerPermission: repo.viewerPermission ?? undefined };
  let guide = firstGuide(repo);
  let source = guide?.path;
  if (!guide && name !== '.github') {
    const defaults = await client
      .graphql<{ repository: GuideFields | null }>(OWNER_DEFAULTS_QUERY, { owner })
      .catch(() => ({ repository: null }));
    guide = firstGuide(defaults.repository);
    source = guide && `${owner}/.github:${guide.path}`;
  }
  if (guide) {
    info.contributingPath = source;
    info.contributingText = guide.text;
  }
  return info;
}

/** Fetches one PR with its files, whatever its age, so the PR under review is never cut off by limits. */
export async function fetchPull(client: GitHubClient, owner: string, name: string, number: number): Promise<PullRequest | undefined> {
  const data = await client.graphql<{ repository: { pullRequest: (RawPull & { state: string }) | null } | null }>(PULL_QUERY, {
    owner,
    name,
    number,
  });
  if (!data.repository) throw new Error(`Repository ${owner}/${name} not found or not accessible`);
  const raw = data.repository.pullRequest;
  return raw ? toPull(raw, raw.state === 'MERGED' ? 'MERGED' : 'OPEN') : undefined;
}

export async function fetchViewer(client: GitHubClient): Promise<string | undefined> {
  return client
    .graphql<{ viewer: { login: string } }>(VIEWER_QUERY, {})
    .then((d) => d.viewer.login)
    .catch(() => undefined);
}

interface RawIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  assignees: { nodes: { login: string }[] };
  comments: { totalCount: number };
}

interface RawPull {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  body: string | null;
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  author: { login: string } | null;
  closingIssuesReferences: { nodes: { number: number }[] };
  files?: { nodes: { path: string }[] } | null;
}

type RepoData<K extends string, N> = { repository: Record<K, Connection<N>> | null };

function toIssue(raw: RawIssue): Issue {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? 'ghost',
    labels: raw.labels.nodes.map((l) => l.name),
    assignees: raw.assignees.nodes.map((a) => a.login),
    comments: raw.comments.totalCount,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function toPull(raw: RawPull, state: PullRequest['state']): PullRequest {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? 'ghost',
    state,
    isDraft: raw.isDraft,
    body: raw.body ?? '',
    headRefName: raw.headRefName,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    files: raw.files?.nodes.map((f) => f.path) ?? [],
    closingIssues: raw.closingIssuesReferences.nodes.map((n) => n.number),
  };
}

function repoConnection<K extends string, N>(key: K, owner: string, name: string) {
  return (data: RepoData<K, N>): Connection<N> => {
    if (!data.repository) throw new Error(`Repository ${owner}/${name} not found or not accessible`);
    return data.repository[key];
  };
}

export interface SnapshotLimits {
  maxIssues: number;
  maxOpenPulls: number;
  maxMergedPulls: number;
}

export const DEFAULT_LIMITS: SnapshotLimits = {
  maxIssues: 500,
  maxOpenPulls: 200,
  maxMergedPulls: 150,
};

export async function fetchSnapshot(
  client: GitHubClient,
  owner: string,
  name: string,
  limits: SnapshotLimits = DEFAULT_LIMITS,
  now: () => Date = () => new Date(),
): Promise<RepoSnapshot> {
  const vars = { owner, name };
  const [issues, openPulls, mergedPulls, viewer, policy] = await Promise.all([
    collectPages(client, ISSUES_QUERY, vars, repoConnection<'issues', RawIssue>('issues', owner, name), limits.maxIssues),
    collectPages(client, OPEN_PRS_QUERY, vars, repoConnection<'pullRequests', RawPull>('pullRequests', owner, name), limits.maxOpenPulls),
    collectPages(client, MERGED_PRS_QUERY, vars, repoConnection<'pullRequests', RawPull>('pullRequests', owner, name), limits.maxMergedPulls),
    fetchViewer(client),
    fetchPolicyInfo(client, owner, name).catch(() => undefined),
  ]);
  return {
    owner,
    name,
    fetchedAt: now().toISOString(),
    viewer,
    policy,
    issues: issues.map(toIssue),
    openPulls: openPulls.map((p) => toPull(p, 'OPEN')),
    mergedPulls: mergedPulls.map((p) => toPull(p, 'MERGED')),
  };
}

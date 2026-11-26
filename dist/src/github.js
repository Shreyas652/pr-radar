import { execFileSync } from 'node:child_process';
export function resolveToken(env = process.env) {
    const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (fromEnv)
        return fromEnv;
    try {
        const token = execFileSync('gh', ['auth', 'token'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (token)
            return token;
    }
    catch {
        // gh is not installed or not logged in; fall through to the error below.
    }
    throw new Error('No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.');
}
export class GitHubRequestError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
export class GitHubClient {
    token;
    fetchImpl;
    apiUrl;
    graphqlUrl;
    constructor(token, fetchImpl = fetch, urls = {}) {
        this.token = token;
        this.fetchImpl = fetchImpl;
        this.apiUrl = (urls.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
        this.graphqlUrl = urls.graphqlUrl ?? `${this.apiUrl}/graphql`;
    }
    headers() {
        return {
            authorization: `bearer ${this.token}`,
            'content-type': 'application/json',
            accept: 'application/vnd.github+json',
            'user-agent': 'pr-radar',
        };
    }
    async rest(method, path, body) {
        const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
            method,
            headers: this.headers(),
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            let message = res.statusText;
            try {
                message = JSON.parse(detail).message ?? message;
            }
            catch {
                // Not JSON; keep the status text.
            }
            throw new GitHubRequestError(`GitHub ${method} ${path} failed: ${res.status} ${message}`, res.status);
        }
        return (await res.json());
    }
    async graphql(query, variables) {
        const res = await this.fetchImpl(this.graphqlUrl, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ query, variables }),
        });
        if (!res.ok) {
            throw new GitHubRequestError(`GitHub GraphQL request failed: ${res.status} ${res.statusText}`, res.status);
        }
        const json = (await res.json());
        if (json.errors?.length) {
            throw new Error(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
        }
        if (!json.data)
            throw new Error('GitHub GraphQL response had no data');
        return json.data;
    }
}
/** Follows GraphQL cursors until `limit` nodes are collected or pages run out. */
export async function collectPages(client, query, variables, select, limit) {
    const out = [];
    let cursor = null;
    while (out.length < limit) {
        const data = await client.graphql(query, { ...variables, cursor });
        const conn = select(data);
        out.push(...conn.nodes);
        if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor)
            break;
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
        files(first: 100) { nodes { path additions deletions } }
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
      files(first: 100) { nodes { path additions deletions } }
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
const GUIDE_FIELDS = CONTRIBUTING_PATHS.map((p, i) => `c${i}: object(expression: ${JSON.stringify(`HEAD:${p}`)}) { ... on Blob { text } }`).join('\n    ');
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
function firstGuide(fields) {
    if (!fields)
        return undefined;
    for (const [i, path] of CONTRIBUTING_PATHS.entries()) {
        const blob = fields[`c${i}`];
        if (blob && typeof blob === 'object' && typeof blob.text === 'string')
            return { path, text: blob.text };
    }
    return undefined;
}
export async function fetchPolicyInfo(client, owner, name) {
    const data = await client.graphql(POLICY_QUERY, { owner, name });
    const repo = data.repository;
    if (!repo)
        throw new Error(`Repository ${owner}/${name} not found or not accessible`);
    const info = { isArchived: repo.isArchived, viewerPermission: repo.viewerPermission ?? undefined };
    let guide = firstGuide(repo);
    let source = guide?.path;
    if (!guide && name !== '.github') {
        const defaults = await client
            .graphql(OWNER_DEFAULTS_QUERY, { owner })
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
export async function fetchPull(client, owner, name, number) {
    const data = await client.graphql(PULL_QUERY, {
        owner,
        name,
        number,
    });
    if (!data.repository)
        throw new Error(`Repository ${owner}/${name} not found or not accessible`);
    const raw = data.repository.pullRequest;
    return raw ? toPull(raw, raw.state === 'MERGED' ? 'MERGED' : 'OPEN') : undefined;
}
const GITATTRIBUTES_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: "HEAD:.gitattributes") { ... on Blob { text } }
  }
}`;
/** The root .gitattributes text, or undefined when there is none or it cannot be read. */
export async function fetchGitattributes(client, owner, name) {
    return client
        .graphql(GITATTRIBUTES_QUERY, { owner, name })
        .then((d) => d.repository?.object?.text ?? undefined)
        .catch(() => undefined);
}
export async function fetchViewer(client) {
    return client
        .graphql(VIEWER_QUERY, {})
        .then((d) => d.viewer.login)
        .catch(() => undefined);
}
function toIssue(raw) {
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
function toPull(raw, state) {
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
        ...(raw.files ? { fileStats: raw.files.nodes.map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })) } : {}),
        closingIssues: raw.closingIssuesReferences.nodes.map((n) => n.number),
    };
}
function repoConnection(key, owner, name) {
    return (data) => {
        if (!data.repository)
            throw new Error(`Repository ${owner}/${name} not found or not accessible`);
        return data.repository[key];
    };
}
export const DEFAULT_LIMITS = {
    maxIssues: 500,
    maxOpenPulls: 200,
    maxMergedPulls: 150,
};
export async function fetchSnapshot(client, owner, name, limits = DEFAULT_LIMITS, now = () => new Date()) {
    const vars = { owner, name };
    const [issues, openPulls, mergedPulls, viewer, policy, gitattributes] = await Promise.all([
        collectPages(client, ISSUES_QUERY, vars, repoConnection('issues', owner, name), limits.maxIssues),
        collectPages(client, OPEN_PRS_QUERY, vars, repoConnection('pullRequests', owner, name), limits.maxOpenPulls),
        collectPages(client, MERGED_PRS_QUERY, vars, repoConnection('pullRequests', owner, name), limits.maxMergedPulls),
        fetchViewer(client),
        fetchPolicyInfo(client, owner, name).catch(() => undefined),
        fetchGitattributes(client, owner, name),
    ]);
    return {
        owner,
        name,
        fetchedAt: now().toISOString(),
        viewer,
        policy,
        ...(gitattributes === undefined ? {} : { gitattributes }),
        issues: issues.map(toIssue),
        openPulls: openPulls.map((p) => toPull(p, 'OPEN')),
        mergedPulls: mergedPulls.map((p) => toPull(p, 'MERGED')),
    };
}

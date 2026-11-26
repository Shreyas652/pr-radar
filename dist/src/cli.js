#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_OPTIONS, analyzeRepo, candidateFromPull, checkCandidate } from './analyze.js';
import { readLocalBranch, remoteRepo } from './git.js';
import { DEFAULT_LIMITS, GitHubClient, fetchPolicyInfo, fetchSnapshot, fetchViewer, resolveToken } from './github.js';
import { assessPolicy } from './policy.js';
import { extractIssueRefs } from './refs.js';
import { renderPolicy, renderPullCheck, renderRepoReport } from './render.js';
const USAGE = `pr-radar: spot duplicate work, unclaimed issues and conflict hotspots in a GitHub repo.

Usage:
  pr-radar policy [owner/repo]                    Does this repo take PRs from you? (one quick API call)
  pr-radar scan  [owner/repo] [options]           Report for the whole repository
  pr-radar check [owner/repo] --pr <number>       Check one open PR
  pr-radar check [owner/repo] --branch [--base X] Check your local branch before opening a PR

When owner/repo is omitted it is read from the git remote (--remote, default "origin").

Options:
  --json                  Print JSON instead of Markdown
  --out <file>            Write the report to a file instead of stdout
  --limit <n>             Rows per Markdown section (default 25)
  --from-snapshot <file>  Analyse a saved snapshot instead of calling GitHub
  --save-snapshot <file>  Save the fetched snapshot for later runs
  --max-issues <n>        Open issues to fetch (default ${DEFAULT_LIMITS.maxIssues})
  --max-prs <n>           Open PRs to fetch (default ${DEFAULT_LIMITS.maxOpenPulls})
  --max-merged <n>        Recently merged PRs to fetch (default ${DEFAULT_LIMITS.maxMergedPulls})
  --min-hotspot <n>       Open PRs on one file to call it a hotspot (default ${DEFAULT_OPTIONS.minHotspotPulls})
  --fail-under <score>    check: exit 1 when the score is below this percentage
  --remote <name>         Git remote used to infer owner/repo (default origin)
  --cwd <dir>             Git working directory for --branch (default current)
  -h, --help              Show this help

Authentication: GITHUB_TOKEN or GH_TOKEN, falling back to \`gh auth token\`.
`;
function positiveInt(value, flag, fallback) {
    if (value === undefined)
        return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0)
        throw new UsageError(`${flag} must be a non-negative integer`);
    return n;
}
class UsageError extends Error {
}
function parseRepo(arg, remote, cwd) {
    if (arg) {
        const [owner, name, ...rest] = arg.split('/');
        if (!owner || !name || rest.length)
            throw new UsageError(`Expected owner/repo, got "${arg}"`);
        return { owner, name };
    }
    const inferred = remoteRepo(remote, cwd);
    if (!inferred)
        throw new UsageError(`Could not read owner/repo from git remote "${remote}". Pass it explicitly.`);
    return inferred;
}
function parseCli(argv) {
    try {
        return parseCliStrict(argv);
    }
    catch (err) {
        if (err instanceof TypeError)
            throw new UsageError(err.message);
        throw err;
    }
}
function parseCliStrict(argv) {
    return parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            json: { type: 'boolean', default: false },
            out: { type: 'string' },
            limit: { type: 'string' },
            'from-snapshot': { type: 'string' },
            'save-snapshot': { type: 'string' },
            'max-issues': { type: 'string' },
            'max-prs': { type: 'string' },
            'max-merged': { type: 'string' },
            'min-hotspot': { type: 'string' },
            'fail-under': { type: 'string' },
            pr: { type: 'string' },
            branch: { type: 'boolean', default: false },
            base: { type: 'string', default: 'main' },
            remote: { type: 'string', default: 'origin' },
            cwd: { type: 'string', default: process.cwd() },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
}
export async function main(argv) {
    const { values, positionals } = parseCli(argv);
    const [command, repoArg] = positionals;
    if (values.help || !command) {
        process.stdout.write(USAGE);
        return values.help ? 0 : 2;
    }
    if (command !== 'scan' && command !== 'check' && command !== 'policy')
        throw new UsageError(`Unknown command "${command}"`);
    if (command === 'check' && !values.pr === !values.branch)
        throw new UsageError('check needs exactly one of --pr <number> or --branch');
    const opts = { ...DEFAULT_OPTIONS, minHotspotPulls: positiveInt(values['min-hotspot'], '--min-hotspot', DEFAULT_OPTIONS.minHotspotPulls) };
    if (command === 'policy' && !values['from-snapshot']) {
        const { owner, name } = parseRepo(repoArg, values.remote, values.cwd);
        const client = new GitHubClient(resolveToken());
        const [info, viewer] = await Promise.all([fetchPolicyInfo(client, owner, name), fetchViewer(client)]);
        return emit(assessPolicy(info, viewer), `${owner}/${name}`, values);
    }
    let snapshot;
    if (values['from-snapshot']) {
        snapshot = JSON.parse(readFileSync(values['from-snapshot'], 'utf8'));
        if (repoArg && `${snapshot.owner}/${snapshot.name}`.toLowerCase() !== repoArg.toLowerCase()) {
            throw new UsageError(`Snapshot is for ${snapshot.owner}/${snapshot.name}, not ${repoArg}`);
        }
    }
    else {
        const { owner, name } = parseRepo(repoArg, values.remote, values.cwd);
        const client = new GitHubClient(resolveToken());
        snapshot = await fetchSnapshot(client, owner, name, {
            maxIssues: positiveInt(values['max-issues'], '--max-issues', DEFAULT_LIMITS.maxIssues),
            maxOpenPulls: positiveInt(values['max-prs'], '--max-prs', DEFAULT_LIMITS.maxOpenPulls),
            maxMergedPulls: positiveInt(values['max-merged'], '--max-merged', DEFAULT_LIMITS.maxMergedPulls),
        });
    }
    if (values['save-snapshot'])
        writeFileSync(values['save-snapshot'], JSON.stringify(snapshot, null, 2));
    const repo = `${snapshot.owner}/${snapshot.name}`;
    if (command === 'policy')
        return emit(assessPolicy(snapshot.policy, snapshot.viewer), repo, values);
    let output;
    let exitCode = 0;
    if (command === 'scan') {
        const report = analyzeRepo(snapshot, opts);
        output = values.json ? JSON.stringify(report, null, 2) + '\n' : renderRepoReport(report, positiveInt(values.limit, '--limit', 25));
    }
    else {
        let candidate;
        if (values.pr) {
            const number = positiveInt(values.pr, '--pr', 0);
            const pull = snapshot.openPulls.find((p) => p.number === number);
            if (!pull)
                throw new UsageError(`PR #${number} is not among the open PRs fetched for ${repo}`);
            candidate = candidateFromPull(pull, snapshot);
        }
        else {
            const local = readLocalBranch(values.base, values.cwd);
            const own = snapshot.openPulls.filter((p) => p.headRefName === local.branch && (!snapshot.viewer || p.author === snapshot.viewer));
            candidate = {
                number: 0,
                title: local.branch,
                url: '',
                author: snapshot.viewer ?? 'you',
                isDraft: false,
                body: local.messages,
                files: local.files,
                changedFiles: local.files.length,
                additions: local.additions,
                deletions: local.deletions,
                linkedIssues: extractIssueRefs(local.messages, snapshot.owner, snapshot.name).linked,
                exclude: own.map((p) => p.number),
                checkPolicy: true,
            };
        }
        const check = checkCandidate(candidate, snapshot, undefined, opts);
        output = values.json ? JSON.stringify(check, null, 2) + '\n' : renderPullCheck(check, repo);
        const failUnder = values['fail-under'] === undefined ? undefined : positiveInt(values['fail-under'], '--fail-under', 0);
        if (failUnder !== undefined && check.score < failUnder)
            exitCode = 1;
    }
    if (values.out)
        writeFileSync(values.out, output);
    else
        process.stdout.write(output);
    return exitCode;
}
function emit(policy, repo, values) {
    const output = values.json ? JSON.stringify(policy, null, 2) + '\n' : renderPolicy(policy, repo);
    if (values.out)
        writeFileSync(values.out, output);
    else
        process.stdout.write(output);
    return 0;
}
main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
}, (err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pr-radar: ${message}\n`);
    if (err instanceof UsageError)
        process.stderr.write('Run `pr-radar --help` for usage.\n');
    process.exitCode = err instanceof UsageError ? 2 : 1;
});

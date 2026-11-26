import { GeneratedMatcher } from './generated.js';
import { assessPolicy } from './policy.js';
import { extractIssueRefs, stripNoise } from './refs.js';
export const DEFAULT_OPTIONS = {
    minHotspotPulls: 3,
    ignorePaths: ['.changeset/'],
    maxReviewableLines: 600,
    changesets: 'auto',
    generatedPatterns: [],
};
/**
 * Splits a change's size into reviewable and generated lines. Without per-file counts
 * (older snapshots) every line counts as reviewable, as before. When the file list was
 * cut off at 100 files, only the listed generated files are subtracted.
 */
export function reviewableSize(candidate, matcher) {
    const total = candidate.additions + candidate.deletions;
    let generatedLines = 0;
    let generatedFiles = 0;
    for (const f of candidate.fileStats ?? []) {
        if (!matcher.isGenerated(f.path))
            continue;
        generatedLines += f.additions + f.deletions;
        generatedFiles += 1;
    }
    return { lines: Math.max(0, total - generatedLines), generatedLines, generatedFiles };
}
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
export function isTestPath(path) {
    return TEST_PATH.test(path);
}
export function pullIssueRefs(pull, owner, name) {
    const refs = extractIssueRefs(`${pull.title}\n${pull.body}`, owner, name);
    const linked = new Set([...pull.closingIssues, ...refs.linked]);
    const mentioned = new Set(refs.mentioned.filter((n) => !linked.has(n)));
    linked.delete(pull.number);
    mentioned.delete(pull.number);
    return { linked, mentioned };
}
function toRef(pull, strength) {
    return { number: pull.number, title: pull.title, url: pull.url, author: pull.author, isDraft: pull.isDraft, strength };
}
/** Maps each open issue number to the open and merged PRs that point at it. */
export function indexClaims(snapshot) {
    const claims = new Map();
    for (const issue of snapshot.issues)
        claims.set(issue.number, { issue, openPulls: [], mergedPulls: [] });
    const add = (pulls, key) => {
        for (const pull of pulls) {
            const { linked, mentioned } = pullIssueRefs(pull, snapshot.owner, snapshot.name);
            for (const n of linked)
                claims.get(n)?.[key].push(toRef(pull, 'linked'));
            for (const n of mentioned)
                claims.get(n)?.[key].push(toRef(pull, 'mentioned'));
        }
    };
    add(snapshot.openPulls, 'openPulls');
    add(snapshot.mergedPulls, 'mergedPulls');
    return claims;
}
function relevantFiles(pull, ignore) {
    return pull.files.filter((f) => !ignore.some((p) => f.startsWith(p)));
}
export function findHotspots(pulls, opts = DEFAULT_OPTIONS) {
    const byPath = new Map();
    for (const pull of pulls) {
        for (const path of relevantFiles(pull, opts.ignorePaths)) {
            const list = byPath.get(path) ?? [];
            list.push(pull.number);
            byPath.set(path, list);
        }
    }
    return [...byPath]
        .filter(([, nums]) => nums.length >= opts.minHotspotPulls)
        .map(([path, nums]) => ({ path, pulls: nums.sort((a, b) => a - b) }))
        .sort((a, b) => b.pulls.length - a.pulls.length || a.path.localeCompare(b.path));
}
export function usesChangesets(snapshot, opts) {
    if (opts.changesets !== 'auto')
        return opts.changesets;
    return snapshot.openPulls.some((p) => p.files.some((f) => f.startsWith('.changeset/') && f.endsWith('.md')));
}
export function candidateFromPull(pull, snapshot) {
    const { linked } = pullIssueRefs(pull, snapshot.owner, snapshot.name);
    return {
        number: pull.number,
        title: pull.title,
        url: pull.url,
        author: pull.author,
        isDraft: pull.isDraft,
        body: pull.body,
        files: pull.files,
        ...(pull.fileStats ? { fileStats: pull.fileStats } : {}),
        changedFiles: pull.changedFiles,
        additions: pull.additions,
        deletions: pull.deletions,
        linkedIssues: [...linked].sort((a, b) => a - b),
        exclude: [pull.number],
    };
}
/**
 * Maps every issue number that open PRs link (not just mention) to those PRs. Unlike
 * `indexClaims` it does not need the issue list, so it also covers closed issues and
 * issues outside the fetched window.
 */
export function indexOpenLinks(snapshot) {
    const links = new Map();
    for (const pull of snapshot.openPulls) {
        for (const n of pullIssueRefs(pull, snapshot.owner, snapshot.name).linked) {
            const list = links.get(n) ?? [];
            list.push(pull.number);
            links.set(n, list);
        }
    }
    return links;
}
export function checkCandidate(candidate, snapshot, openLinks = indexOpenLinks(snapshot), opts = DEFAULT_OPTIONS) {
    const excluded = new Set(candidate.exclude);
    const competing = [];
    for (const n of candidate.linkedIssues) {
        const others = (openLinks.get(n) ?? []).filter((p) => !excluded.has(p)).sort((a, b) => a - b);
        if (others.length)
            competing.push({ issue: n, pulls: others });
    }
    const mine = new Set(relevantFiles(candidate, opts.ignorePaths));
    const overlaps = snapshot.openPulls
        .filter((p) => !excluded.has(p.number))
        .map((p) => ({ number: p.number, title: p.title, author: p.author, shared: relevantFiles(p, opts.ignorePaths).filter((f) => mine.has(f)) }))
        .filter((o) => o.shared.length > 0)
        .sort((a, b) => b.shared.length - a.shared.length || a.number - b.number);
    const size = reviewableSize(candidate, GeneratedMatcher.forRepo(snapshot.gitattributes, opts.generatedPatterns));
    const generatedNote = size.generatedFiles
        ? `, not counting ${size.generatedLines} in ${size.generatedFiles} generated file${size.generatedFiles === 1 ? '' : 's'}`
        : '';
    const tests = candidate.files.filter(isTestPath);
    const description = stripNoise(candidate.body).replace(/\s+/g, ' ').trim();
    const checklist = [];
    if (candidate.checkPolicy) {
        const policy = assessPolicy(snapshot.policy, snapshot.viewer);
        const ok = policy.verdict === 'blocked' ? false : policy.verdict === 'caution' ? candidate.linkedIssues.length > 0 : true;
        const quote = policy.evidence[0] ? ` ${policy.source ?? 'Guide'}: "${policy.evidence[0]}"` : '';
        checklist.push({ id: 'policy', label: 'Repo takes your PR', ok, detail: `${policy.summary}${quote}` });
    }
    checklist.push({
        id: 'linked-issue',
        label: 'Linked issue',
        ok: candidate.linkedIssues.length > 0,
        detail: candidate.linkedIssues.length ? candidate.linkedIssues.map((n) => `#${n}`).join(', ') : 'no "Fixes #N" or "Refs #N" found',
    }, {
        id: 'tests',
        label: 'Tests',
        ok: tests.length > 0,
        detail: tests.length ? `${tests.length} test file${tests.length === 1 ? '' : 's'} changed` : 'no test files changed',
    });
    if (usesChangesets(snapshot, opts)) {
        const has = candidate.files.some((f) => f.startsWith('.changeset/') && f.endsWith('.md'));
        checklist.push({ id: 'changeset', label: 'Changeset', ok: has, detail: has ? 'included' : 'repo uses changesets but none added' });
    }
    checklist.push({
        id: 'description',
        label: 'Description',
        ok: description.length >= 80,
        detail: `${description.length} characters after removing template comments`,
    }, {
        id: 'size',
        label: 'Reviewable size',
        ok: size.lines <= opts.maxReviewableLines,
        detail: `${size.lines} lines changed${generatedNote}`,
    }, {
        id: 'no-competition',
        label: 'No competing PR',
        ok: competing.length === 0,
        detail: competing.length
            ? competing.map((c) => `#${c.issue} also targeted by ${c.pulls.map((n) => `#${n}`).join(', ')}`).join('; ')
            : 'no other open PR targets the same issue',
    });
    const passed = checklist.filter((c) => c.ok).length;
    return {
        number: candidate.number,
        title: candidate.title,
        url: candidate.url,
        author: candidate.author,
        isDraft: candidate.isDraft,
        linkedIssues: candidate.linkedIssues,
        competing,
        overlaps,
        checklist,
        score: Math.round((passed / checklist.length) * 100),
        filesTruncated: candidate.changedFiles > candidate.files.length,
    };
}
export function analyzeRepo(snapshot, opts = DEFAULT_OPTIONS) {
    const claims = indexClaims(snapshot);
    const openLinks = indexOpenLinks(snapshot);
    const all = [...claims.values()];
    const newestFirst = (a, b) => b.issue.number - a.issue.number;
    const contested = all.filter((c) => c.openPulls.filter((p) => p.strength === 'linked').length >= 2).sort(newestFirst);
    const contestedSet = new Set(contested.map((c) => c.issue.number));
    const possiblyResolved = all
        .filter((c) => c.mergedPulls.some((p) => p.strength === 'linked') && c.openPulls.length === 0)
        .sort(newestFirst);
    const claimed = all.filter((c) => c.openPulls.length > 0 && !contestedSet.has(c.issue.number)).sort(newestFirst);
    const unclaimed = all
        .filter((c) => c.openPulls.length === 0 && c.mergedPulls.length === 0)
        .map((c) => c.issue)
        .sort((a, b) => b.number - a.number);
    return {
        repo: `${snapshot.owner}/${snapshot.name}`,
        fetchedAt: snapshot.fetchedAt,
        totals: {
            openIssues: snapshot.issues.length,
            openPulls: snapshot.openPulls.length,
            mergedPullsScanned: snapshot.mergedPulls.length,
        },
        policy: assessPolicy(snapshot.policy, snapshot.viewer),
        contested,
        possiblyResolved,
        unclaimed,
        claimed,
        hotspots: findHotspots(snapshot.openPulls, opts),
        pullChecks: snapshot.openPulls.map((p) => checkCandidate(candidateFromPull(p, snapshot), snapshot, openLinks, opts)),
    };
}

const PR = String.raw `(?:pull requests?|PRs?|patch(?:es)?|code contributions?|contributions)`;
const AUDIENCE = String.raw `\b(?:non-?collaborators?|collaborators?|external|outside|third[- ]party|community|non-?members?|members?|employees?|maintainers?|core team|the team|staff|the public|anyone)\b`;
/** Sentences that close the door on their own. */
const CLOSED_PATTERNS = [
    new RegExp(String.raw `\b${PR}\s+(?:are|is)\s+(?:limited|restricted)\s+to\b`, 'i'),
    new RegExp(String.raw `\b${PR}\s+from\s+(?:non-?collaborators?|non-?members?)\b`, 'i'),
    new RegExp(String.raw `\b(?:not|no longer)\s+(?:currently\s+)?(?:accepting|open to|taking)\s+(?:any\s+)?(?:external\s+|outside\s+|community\s+|new\s+)?${PR}`, 'i'),
    new RegExp(String.raw `\bonly\s+(?:accepts?|accepting|takes?|reviews?|merges?)\s+${PR}\s+(?:from|by)\s+${AUDIENCE}`, 'i'),
    new RegExp(String.raw `\b${PR}\s+(?:are|is)\s+(?:only\s+)?accepted\s+only\s+from\b`, 'i'),
];
/** "We do not accept PRs ..." is closed only with an audience or nothing after it. */
const REFUSAL = new RegExp(String.raw `\b(?:do|does|will|wo|can|ca|are|is)\s*(?:not|n't|n’t)\s+(?:currently\s+)?(?:accept|accepting|review|merge|take|taking)\s+(?:any\s+)?(?:external\s+|outside\s+|unsolicited\s+)?${PR}`, 'i');
const RESTRICTED_PATTERNS = [
    /\b(?:open|file|create|start with)\s+an?\s+(?:issue|discussion)\s+(?:first|before)\b/i,
    new RegExp(String.raw `\bbefore\s+(?:opening|submitting|sending|starting work on)\s+an?\s+(?:large\s+|new\s+)?${PR}[^.]*\b(?:issue|discuss|discussion|approval|agree)`, 'i'),
    new RegExp(String.raw `\bdiscuss(?:ed)?\b[^.]{0,40}\bbefore\b[^.]{0,30}${PR}`, 'i'),
    new RegExp(String.raw `\bunsolicited\s+${PR}`, 'i'),
    new RegExp(String.raw `\b${PR}\b[^.]{0,60}\bwithout\s+(?:a\s+|an\s+)?(?:linked|approved|accepted|associated)\s+issue`, 'i'),
    // "If you aren't vouched, any pull requests you open will be automatically closed."
    new RegExp(String.raw `\b${PR}\b[^.]{0,60}\b(?:will|may|might|are|is)\s+(?:be\s+)?(?:automatically\s+|immediately\s+)?(?:closed|rejected)\b`, 'i'),
    new RegExp(String.raw `\b(?:approved|vouched)\b[^.]{0,40}\b(?:you can|you may)\s+(?:submit|open)\s+${PR}`, 'i'),
];
/** Housekeeping rules ("stale PRs are closed after 30 days") say nothing about who may contribute. */
const HOUSEKEEPING = /\b(?:stale|inactive|abandoned|idle|outdated|draft)\b|\bafter\s+\d+\s+(?:days?|weeks?|months?)\b/i;
const CLA = /\b(?:CLA|contributor license agreement|developer certificate of origin|DCO)\b/i;
function sentences(text) {
    return text
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .split(/\n\s*\n|(?<=[.!?])\s+|\n(?=\s*(?:[-*+]|\d+\.)\s)|\n(?=#)/)
        .map((s) => s
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim())
        .filter((s) => s.length > 0);
}
function clip(sentence) {
    return sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence;
}
function isClosed(sentence) {
    if (CLOSED_PATTERNS.some((p) => p.test(sentence)))
        return true;
    const refusal = REFUSAL.exec(sentence);
    if (!refusal)
        return false;
    const rest = sentence.slice(refusal.index + refusal[0].length);
    // "We do not accept pull requests." / "...at this time." / "...from non-collaborators".
    if (/^\s*(?:at (?:this|the moment|present)|right now|currently)?\s*[.!]?\s*$/i.test(rest))
        return true;
    return new RegExp(AUDIENCE, 'i').test(sentence);
}
export function assessContributingText(text) {
    if (text === undefined)
        return { status: 'unknown', evidence: [], notes: [] };
    const closed = [];
    const restricted = [];
    const notes = new Set();
    for (const sentence of sentences(text)) {
        if (isClosed(sentence))
            closed.push(clip(sentence));
        else if (!HOUSEKEEPING.test(sentence) && (REFUSAL.test(sentence) || RESTRICTED_PATTERNS.some((p) => p.test(sentence)))) {
            restricted.push(clip(sentence));
        }
        if (CLA.test(sentence))
            notes.add('Requires a CLA or DCO sign-off.');
    }
    if (closed.length)
        return { status: 'closed', evidence: closed.slice(0, 3), notes: [...notes] };
    if (restricted.length)
        return { status: 'restricted', evidence: restricted.slice(0, 3), notes: [...notes] };
    return { status: 'open', evidence: [], notes: [...notes] };
}
const WRITE_PERMISSIONS = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);
/** Combines the guide's wording with who is asking, since a closed repo is still open to its collaborators. */
export function assessPolicy(info, viewer) {
    const base = assessContributingText(info?.contributingText);
    const isCollaborator = WRITE_PERMISSIONS.has(info?.viewerPermission ?? '');
    const isArchived = info?.isArchived ?? false;
    const who = viewer ? `@${viewer}` : 'you';
    let verdict;
    let summary;
    if (!info) {
        verdict = 'unknown';
        summary = 'Contribution policy was not fetched (older snapshot or lookup failed).';
    }
    else if (isArchived) {
        verdict = 'blocked';
        summary = 'The repository is archived and read-only, so it cannot take PRs.';
    }
    else if (base.status === 'closed' && isCollaborator) {
        verdict = 'ok';
        summary = `The guide limits PRs to collaborators, and ${who} ${viewer ? 'has' : 'have'} ${info.viewerPermission} access.`;
    }
    else if (base.status === 'closed') {
        verdict = 'blocked';
        summary = `The guide says it does not take PRs from non-collaborators, and ${who} ${viewer ? 'is' : 'are'} not one. Contribute through issues instead.`;
    }
    else if (base.status === 'restricted') {
        verdict = 'caution';
        summary = 'PRs are welcome after a first step, usually an issue or discussion. Do that before writing code.';
    }
    else if (base.status === 'open') {
        verdict = 'ok';
        summary = 'The contributing guide does not restrict outside PRs.';
    }
    else {
        verdict = 'unknown';
        summary = 'No contributing guide found. Check the README or ask in an issue before a large PR.';
    }
    return {
        ...base,
        verdict,
        summary,
        source: info?.contributingPath,
        viewer,
        viewerPermission: info?.viewerPermission,
        isCollaborator,
        isArchived,
    };
}

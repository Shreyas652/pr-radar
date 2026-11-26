import type { IssueClaim, PullCheck, PullRef, RepoReport } from './analyze.js';

export const COMMENT_MARKER = '<!-- pr-radar -->';

export function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function ageDays(from: string, now: string): number {
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(from)) / 86_400_000));
}

function pullList(refs: PullRef[]): string {
  return refs
    .map((p) => {
      const notes = [`@${p.author}`];
      if (p.isDraft) notes.push('draft');
      if (p.strength === 'mentioned') notes.push('mention only');
      return `#${p.number} (${notes.join(', ')})`;
    })
    .join(', ');
}

function issueCell(c: IssueClaim | { issue: IssueClaim['issue'] }): string {
  return `#${c.issue.number} ${cell(c.issue.title)}`;
}

function section(title: string, blurb: string, header: string[], rows: string[][], limit: number): string[] {
  const out = [`## ${title} (${rows.length})`, '', blurb, ''];
  if (!rows.length) return [...out, '_None._', ''];
  out.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows.slice(0, limit)) out.push(`| ${row.join(' | ')} |`);
  if (rows.length > limit) out.push('', `_…and ${rows.length - limit} more. Use \`--json\` for the full list._`);
  return [...out, ''];
}

export function renderRepoReport(report: RepoReport, limit = 25): string {
  const t = report.totals;
  const out = [
    `# pr-radar: ${report.repo}`,
    '',
    `_Snapshot ${report.fetchedAt} · ${t.openIssues} open issues · ${t.openPulls} open PRs · ${t.mergedPullsScanned} recently merged PRs scanned_`,
    '',
  ];

  out.push(
    ...section(
      'Contested issues',
      'Two or more open PRs link the same issue. Maintainers can pick one; contributors should coordinate before pushing more work.',
      ['Issue', 'Open PRs'],
      report.contested.map((c) => [issueCell(c), pullList(c.openPulls)]),
      limit,
    ),
    ...section(
      'Possibly resolved',
      'Still-open issues linked from a merged PR. Check whether they can be closed.',
      ['Issue', 'Merged PR'],
      report.possiblyResolved.map((c) => [issueCell(c), pullList(c.mergedPulls.filter((p) => p.strength === 'linked'))]),
      limit,
    ),
    ...section(
      'Unclaimed issues',
      'No open or recently merged PR references these. Good places to contribute.',
      ['Issue', 'Labels', 'Age', 'Comments'],
      report.unclaimed.map((i) => [
        `#${i.number} ${cell(i.title)}`,
        cell(i.labels.join(', ')) || '-',
        `${ageDays(i.createdAt, report.fetchedAt)}d`,
        String(i.comments),
      ]),
      limit,
    ),
    ...section(
      'Claimed issues',
      'One open PR references these already.',
      ['Issue', 'Open PR'],
      report.claimed.map((c) => [issueCell(c), pullList(c.openPulls)]),
      limit,
    ),
    ...section(
      'Conflict hotspots',
      'Files touched by several open PRs at once. Changes here are likely to conflict.',
      ['File', 'Open PRs'],
      report.hotspots.map((h) => [`\`${cell(h.path)}\``, h.pulls.map((n) => `#${n}`).join(', ')]),
      limit,
    ),
    ...section(
      'Open PR checklist',
      'Signals that make a PR quick to review. A low score is a prompt, not a verdict.',
      ['PR', 'Author', 'Score', 'Missing'],
      [...report.pullChecks]
        .sort((a, b) => a.score - b.score || a.number - b.number)
        .map((p) => [
          `#${p.number} ${cell(p.title)}${p.isDraft ? ' (draft)' : ''}`,
          `@${p.author}`,
          `${p.score}%`,
          p.checklist.filter((c) => !c.ok).map((c) => c.label).join(', ') || '-',
        ]),
      limit,
    ),
  );
  return out.join('\n').trimEnd() + '\n';
}

export function renderPullCheck(check: PullCheck, repo: string): string {
  const passed = check.checklist.filter((c) => c.ok).length;
  const heading = check.number > 0 ? `#${check.number} ${check.title}` : `local branch: ${check.title}`;
  const out = [
    COMMENT_MARKER,
    `### pr-radar: ${cell(heading)}`,
    '',
    `**Score:** ${check.score}% (${passed}/${check.checklist.length} checks) · ${repo}`,
    '',
    ...check.checklist.map((c) => `- ${c.ok ? '✅' : '⚠️'} **${c.label}**: ${c.detail}`),
    '',
  ];

  if (check.competing.length) {
    out.push('#### Competing PRs', '');
    for (const c of check.competing) out.push(`- #${c.issue} is also targeted by ${c.pulls.map((n) => `#${n}`).join(', ')}`);
    out.push('');
  }

  out.push('#### File overlaps with other open PRs', '');
  if (!check.overlaps.length) {
    out.push('_None. This change is unlikely to conflict with open work._');
  } else {
    out.push('| PR | Shared files |', '| --- | --- |');
    for (const o of check.overlaps.slice(0, 15)) {
      const files = o.shared.slice(0, 5).map((f) => `\`${cell(f)}\``).join(', ');
      const more = o.shared.length > 5 ? ` +${o.shared.length - 5} more` : '';
      out.push(`| #${o.number} ${cell(o.title)} (@${o.author}) | ${files}${more} |`);
    }
    if (check.overlaps.length > 15) out.push('', `_…and ${check.overlaps.length - 15} more PRs._`);
  }
  if (check.filesTruncated) {
    out.push('', '_Only the first 100 changed files were checked for overlaps._');
  }
  return out.join('\n').trimEnd() + '\n';
}

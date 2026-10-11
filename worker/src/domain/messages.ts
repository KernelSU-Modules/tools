// Telegram review message text (HTML parse mode; every interpolated value is escaped with h()).
import type { OpenRequest } from '@kernelsu-modules/schema';
import { precheckSummary, type PrecheckResult } from './precheck.ts';
import { h, type InlineKeyboard } from './telegram.ts';

export const KIND_LABEL: Record<OpenRequest['kind'], string> = {
  submit: 'New module',
  transfer: 'Ownership transfer',
};

/** Telegram callback_data actions: v1:{action}:{submissionId}, ≤ 64 bytes (Telegram's callback_data limit). */
export const CALLBACK_ACTIONS = {
  ap: { decision: 'approve' },
  rs: { decision: 'reject', reasonCode: 'spam' },
  rv: { decision: 'reject', reasonCode: 'violation' },
  ri: { decision: 'reject', reasonCode: 'bad-id' },
  rq: { decision: 'reject', reasonCode: 'squatting' },
} as const;
export type CallbackAction = keyof typeof CALLBACK_ACTIONS;

export function parseCallbackData(data: string | undefined): { action: CallbackAction; submissionId: string } | null {
  const m = /^v1:(ap|rs|rv|ri|rq):([a-z0-9]{10})$/.exec(data ?? '');
  return m ? { action: m[1] as CallbackAction, submissionId: m[2]! } : null;
}

export const requestUrl = (portalUrl: string, submissionId: string) => `${portalUrl.replace(/\/$/, '')}/admin/requests/${submissionId}`;

export function reviewKeyboard(portalUrl: string, submissionId: string): InlineKeyboard {
  const cb = (a: CallbackAction) => `v1:${a}:${submissionId}`;
  return [
    [{ text: '✅ Approve', callback_data: cb('ap') }],
    [
      { text: '🚫 Spam', callback_data: cb('rs') },
      { text: '⚠️ Violation', callback_data: cb('rv') },
    ],
    [
      { text: '🏷 Bad ID', callback_data: cb('ri') },
      { text: '🏴 Squatting', callback_data: cb('rq') },
    ],
    [{ text: 'Open in Portal', url: requestUrl(portalUrl, submissionId) }],
  ];
}

export interface ReviewMessageInput {
  kind: OpenRequest['kind'];
  id: string;
  submissionId: string;
  fullName: string;
  previousFullName?: string | null;
  submitter: { id: number; login: string; createdAt?: string | null };
  precheck?: PrecheckResult | null;
  portalUrl: string;
}

function header(i: Pick<ReviewMessageInput, 'kind' | 'id' | 'fullName' | 'previousFullName' | 'submitter'>): string[] {
  const lines = [
    `<b>${h(KIND_LABEL[i.kind])}</b>: <code>${h(i.id)}</code>`,
    `Repo: <a href="https://github.com/${h(i.fullName)}">${h(i.fullName)}</a>`,
  ];
  if (i.previousFullName) lines.push(`Previous repo: <a href="https://github.com/${h(i.previousFullName)}">${h(i.previousFullName)}</a>`);
  const created = i.submitter.createdAt ? ` (account created ${h(i.submitter.createdAt.slice(0, 10))})` : '';
  lines.push(`Submitter: <a href="https://github.com/${h(i.submitter.login)}">@${h(i.submitter.login)}</a> [${h(i.submitter.id)}]${created}`);
  return lines;
}

export function reviewMessage(i: ReviewMessageInput): string {
  const lines = header(i);
  const rel = i.precheck?.latestRelease;
  if (rel) lines.push(`Latest release: ${h(rel.tag)}${rel.immutable ? '' : ' (not immutable)'}${rel.asset ? ` · ${h(rel.asset.name)}` : ''}`);
  else lines.push('Latest release: none');
  lines.push(`Precheck: ${h(precheckSummary(i.precheck ?? null))} (ZIP is validated by the sync Check Run)`);
  lines.push(`Submission: <code>${h(i.submissionId)}</code> · <a href="${h(requestUrl(i.portalUrl, i.submissionId))}">Portal</a>`);
  return lines.join('\n');
}

export interface DecisionNote {
  outcome: 'approved' | 'rejected' | 'expired' | 'closed';
  by: string; // "@login" or "cron"
  via: string;
  at: string;
  reason?: string | null;
}

/** Text for editMessageText after a decision (keyboard removed by the caller). */
export function decidedMessage(id: string, req: OpenRequest, d: DecisionNote, portalUrl: string): string {
  const lines = header({
    kind: req.kind,
    id,
    fullName: req.source.fullName,
    submitter: { id: req.submittedBy, login: req.submittedByLogin ?? String(req.submittedBy) },
  });
  const icon = d.outcome === 'approved' ? '✅' : d.outcome === 'rejected' ? '❌' : '⌛';
  lines.push('');
  lines.push(`${icon} <b>${h(d.outcome.toUpperCase())}</b> by ${h(d.by)} via ${h(d.via)} at ${h(d.at.replace('T', ' ').replace(/\.\d+Z$/, 'Z'))}`);
  if (d.reason) lines.push(`Reason: ${h(d.reason)}`);
  lines.push(`Submission: <code>${h(req.submissionId)}</code> · <a href="${h(requestUrl(portalUrl, req.submissionId))}">Portal</a>`);
  return lines.join('\n');
}

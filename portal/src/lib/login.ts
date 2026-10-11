/**
 * Sign-in URL. `next` (same-origin path) lets the Worker return the user to a deep link,
 * e.g. /admin/requests/:submissionId opened from Telegram. Workers that ignore it simply
 * land on "/".
 */
export function loginUrl(next?: string): string {
  if (!next || next === '/' || !next.startsWith('/') || next.startsWith('//')) return '/auth/login';
  return `/auth/login?next=${encodeURIComponent(next)}`;
}

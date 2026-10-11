// Non-secret defaults. lib/env.js (generated at deploy time, git-ignored) overrides PORTAL_URL when set.
export const DEFAULT_PORTAL_URL = 'https://developers.kernelsu.org';
export const FORWARD_PATH = '/internal/telegram';
/** Give up waiting for the Worker after this long and answer with a fallback text. */
export const FORWARD_TIMEOUT_MS = 8000;
export const USER_AGENT = 'kernelsu-tgcloud-forwarder/1';

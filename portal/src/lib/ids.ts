/** Mirror of @kernelsu-modules/schema MODULE_ID_PATTERN (kept local so zod stays out of the bundle; a test checks they match). */
export const MODULE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]+$/;
export const MODULE_ID_MIN = 2;
export const MODULE_ID_MAX = 64;

export type IdFormatError = 'empty' | 'tooShort' | 'tooLong' | 'pattern';

export function idFormatError(id: string): IdFormatError | null {
  if (!id) return 'empty';
  if (id.length < MODULE_ID_MIN) return 'tooShort';
  if (id.length > MODULE_ID_MAX) return 'tooLong';
  if (!MODULE_ID_PATTERN.test(id)) return 'pattern';
  return null;
}

/** Suggests a module id from a repo name ("owner/My Module" -> "My_Module"-ish). */
export function suggestId(fullName: string): string {
  const name = fullName.split('/').pop() ?? '';
  let s = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  s = s.replace(/^[^a-zA-Z]+/, '');
  return s.slice(0, MODULE_ID_MAX);
}

export const SUBMISSION_ID_PATTERN = /^[a-z0-9]{10}$/;

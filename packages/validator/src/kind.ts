import type { ManifestKind } from '@kernelsu-modules/schema';
import { issue, type Issue } from './issues.ts';
import { parseParams } from './params.ts';
import { isMetamoduleProp, isOneshotProp } from './prop.ts';
import type { ZipInspection } from './zip.ts';

/**
 * Root-level files a one-shot script must not ship: they only make sense for an installed module (boot stages,
 * metamodule hooks, system properties, sepolicy, mount control). A script that needs them is a module.
 */
export const SCRIPT_FORBIDDEN_FILES = [
  'post-fs-data.sh',
  'post-mount.sh',
  'service.sh',
  'boot-completed.sh',
  'uninstall.sh',
  'metamount.sh',
  'metainstall.sh',
  'metauninstall.sh',
  'system.prop',
  'sepolicy.rule',
  'skip_mount',
] as const;
/** Root-level directories a one-shot script must not ship (partition overlays, WebUI, Zygisk). */
export const SCRIPT_FORBIDDEN_DIRS = ['system', 'vendor', 'product', 'system_ext', 'odm', 'webroot', 'zygisk'] as const;

export interface ReleaseKindInput {
  /** module.yaml `kind`; undefined when unknown (then module.prop `oneshot` decides which rules apply). */
  kind: ManifestKind | undefined;
  /** module.prop key/values (parseModuleProp). */
  props: Record<string, string>;
  /** From inspectZip. */
  zip: Pick<ZipInspection, 'files' | 'paramsJson'>;
}

/**
 * Entry-kind rules for one release ZIP (sync and the author-side action):
 *  - manifest-kind-mismatch: module.yaml kind and module.prop `oneshot` (isOneshotProp) disagree;
 *  - script entries: root action.sh required (script-missing-action), no module-only files (script-forbidden-file),
 *    not a metamodule (script-metamodule), a valid params.json when present (script-params-invalid);
 *  - module entries: a root params.json is ignored (params-ignored, warning).
 * The script rules apply when module.yaml says `script` (or, with kind unknown, when module.prop is oneshot).
 */
export function checkReleaseKind(input: ReleaseKindInput): Issue[] {
  const issues: Issue[] = [];
  const oneshot = isOneshotProp(input.props);
  const kind: ManifestKind = input.kind ?? (oneshot ? 'script' : 'module');
  if (kind === 'script' && !oneshot)
    issues.push(
      issue(
        'manifest-kind-mismatch',
        'module.yaml has kind: script but module.prop does not set oneshot=1 or true, so managers would install it as a regular module.',
        'error',
        'kind',
      ),
    );
  if (kind === 'module' && oneshot)
    issues.push(
      issue(
        'manifest-kind-mismatch',
        'module.prop declares oneshot=1/true (a one-shot script) but module.yaml has kind: module (or no kind). Set kind: script in module.yaml or remove oneshot from module.prop.',
        'error',
        'kind',
      ),
    );

  const files = input.zip.files;
  const hasFile = (p: string) => files.includes(p);
  if (kind === 'module') {
    if (input.zip.paramsJson)
      issues.push(issue('params-ignored', 'The ZIP has a root params.json, but only script entries (kind: script) use it; it is ignored.', 'warning', 'params.json'));
    return issues;
  }

  if (!hasFile('action.sh'))
    issues.push(
      issue('script-missing-action', files.includes('action.sh/') ? 'The ZIP root action.sh is a directory, not a file.' : 'The ZIP has no action.sh at its root; script entries run it.', 'error', 'action.sh'),
    );
  const forbidden: string[] = [];
  for (const f of SCRIPT_FORBIDDEN_FILES) if (hasFile(f) || hasFile(`${f}/`)) forbidden.push(f);
  for (const d of SCRIPT_FORBIDDEN_DIRS) if (files.some((p) => p.startsWith(`${d}/`))) forbidden.push(`${d}/`);
  for (const f of forbidden)
    issues.push(issue('script-forbidden-file', `The ZIP contains ${f} at its root; script entries are run once and never installed, so it would have no effect.`, 'error', f));
  if (isMetamoduleProp(input.props))
    issues.push(issue('script-metamodule', 'module.prop declares metamodule=1/true; a script entry cannot be a metamodule.', 'error', 'metamodule'));

  const pj = input.zip.paramsJson;
  if (pj) {
    if ('error' in pj) issues.push(issue('script-params-invalid', pj.error, 'error', 'params.json'));
    else issues.push(...parseParams(pj.text).issues.map((i) => ({ ...i, path: i.path ? `params.json: ${i.path}` : 'params.json' })));
  }
  return issues;
}

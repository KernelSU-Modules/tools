export type Severity = 'error' | 'warning';
export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
}
export interface Result<T> {
  ok: boolean;
  value?: T;
  issues: Issue[];
}

interface IssueDef {
  /** What went wrong (one line). */
  summary: string;
  /** How to fix it (one line). */
  fix: string;
}

/**
 * Every issue code the validator (and, where marked "caller", its consumers) emits.
 * Codes are stable kebab-case identifiers; docs anchor: https://developers.kernelsu.org/docs/checks#<code>
 */
export const ISSUE_DEFS = {
  /* ---------------- module ID ---------------- */
  'id-invalid': {
    summary: 'The module ID does not match ^[a-zA-Z][a-zA-Z0-9._-]+$ or is not 2-64 characters long.',
    fix: 'Choose an ID that starts with a letter and only uses letters, digits, ".", "_" and "-".',
  },
  'id-reserved': {
    summary: 'The module ID is reserved (reserved ID or reserved prefix, compared case-insensitively).',
    fix: 'Pick a different ID.',
  },
  'id-reserved-suffix': {
    summary: 'The module ID ends with a file suffix KernelSU Modules reserves for its own files (.json, .html, .htm, .md, .xml, .txt; case-insensitive).',
    fix: 'Pick an ID without such a suffix, e.g. "foo-json" or "foo.tools" instead of "foo.json".',
  },
  'id-collision': {
    summary: 'The module ID differs only in letter case from an ID that is already registered.',
    fix: 'Pick an ID that is not a case variant of an existing module ID.',
  },

  /* ---------------- repository / content (emitted by sync) ---------------- */
  'repo-not-found': {
    summary: '(caller) The bound repository no longer exists or the KernelSU Modules app cannot see it.',
    fix: 'Restore the repository or reinstall the KernelSU Modules GitHub App on it; use the Transfer flow if the module moved.',
  },
  'repo-private': {
    summary: '(caller) The bound repository is private; only public repositories can be listed.',
    fix: 'Make the repository public.',
  },
  'owner-changed': {
    summary: '(caller) The repository owner changed since the module was bound; this is treated as an ownership transfer.',
    fix: 'Request a transfer in the Developer Portal so maintainers can confirm the new owner.',
  },
  'ref-not-found': {
    summary: '(caller) The configured branch (or the default branch) could not be resolved.',
    fix: 'Recreate the branch or update the tracked ref in the Developer Portal.',
  },
  'tag-not-found': {
    summary: "(caller) The release's tag could not be resolved to a commit.",
    fix: 'Immutable releases keep their tag; if the tag is gone, publish a new release with a higher versionCode.',
  },
  'content-not-file': {
    summary: '(caller) A path referenced by KernelSU Modules (module.yaml, icon or description) is a directory, symlink or submodule, not a regular file.',
    fix: 'Point the path at a regular file committed in the repository.',
  },
  'content-too-large': {
    summary: '(caller) A repository file used by KernelSU Modules (manifest, document or image) exceeds its size limit from policy.yaml.',
    fix: 'Shrink the file (compress images, split long documents).',
  },

  /* ---------------- module.yaml ---------------- */
  'manifest-missing': {
    summary: '(caller) module.yaml was not found at the configured path on the tracked branch.',
    fix: 'Commit a module.yaml at the repository root (or the registered manifest path).',
  },
  'manifest-too-large': {
    summary: 'module.yaml exceeds the size limit from policy.yaml.',
    fix: 'Keep module.yaml small; move long text into the Markdown description documents.',
  },
  'manifest-yaml': {
    summary: 'module.yaml is not valid YAML (syntax error, duplicate key, multiple documents or too many aliases).',
    fix: 'Fix the YAML syntax; validate the file locally with the module-release action.',
  },
  'manifest-unsupported-version': {
    summary: 'module.yaml declares a schemaVersion KernelSU Modules does not support.',
    fix: 'Set schemaVersion: 1.',
  },
  'manifest-schema': {
    summary: 'module.yaml does not match the schema (wrong type, unknown field, missing field or invalid value).',
    fix: 'Correct the field named in the message; version-like and text values must be strings.',
  },
  'manifest-id-mismatch': {
    summary: '(caller) The id in module.yaml differs from the registered module ID.',
    fix: 'Set id in module.yaml to exactly the registered ID.',
  },
  'manifest-path-missing': {
    summary: '(caller) A path referenced by module.yaml (icon or a locale description) does not exist at the synced commit.',
    fix: 'Commit the referenced file or fix the path (paths are relative to the repository root).',
  },

  'manifest-paths-unchecked': {
    summary: '(caller, Portal precheck) Some files referenced by module.yaml were not checked by the Portal precheck; the sync job verifies them after submission.',
    fix: 'Nothing to do now; make sure every referenced file is committed. Problems show up in the content Check Run and in the Portal.',
  },
  'manifest-metamodule-mismatch': {
    summary: '(caller, sync) metamodule in module.yaml disagrees with module.prop as KernelSU reads it (metamodule=1 or true, case-insensitive, trimmed).',
    fix: 'Set metamodule: true in module.yaml exactly when module.prop has metamodule=1 (or true), or vice versa.',
  },

  /* ---------------- release selection ---------------- */
  'release-none': {
    summary: '(caller) The repository has no published non-prerelease release yet.',
    fix: 'Publish an immutable release that contains the module ZIP.',
  },
  'release-rejected': {
    summary: '(caller) The release was rejected for a reason not covered by a more specific code.',
    fix: 'Open the Check Run details for the full message; publish a new release with a higher versionCode after fixing it.',
  },
  'release-exists': {
    summary: '(caller, author action) A release for this tag already exists.',
    fix: 'Bump the version and versionCode and push a new tag; immutable releases cannot be replaced.',
  },
  'previous-release-unreadable': {
    summary: '(caller, author action) The newest existing release could not be read to compare versionCode.',
    fix: 'Usually harmless; make sure the new versionCode is higher than every published release.',
  },
  'release-draft': {
    summary: 'The release is a draft.',
    fix: 'Publish the release.',
  },
  'release-not-published': {
    summary: 'The release has no publication date.',
    fix: 'Publish the release.',
  },
  'release-not-immutable': {
    summary: 'The release is not immutable; KernelSU Modules only accepts immutable releases.',
    fix: 'Enable release immutability in the repository settings, then publish a new release with a higher versionCode.',
  },
  'asset-pattern-invalid': {
    summary: 'release.assetPattern is empty or contains a path separator.',
    fix: 'Use a file-name glob with only "*" and "?" wildcards, e.g. "mymodule-*.zip".',
  },
  'asset-none': {
    summary: 'No release asset matches release.assetPattern (or, without a pattern, the release has no .zip asset).',
    fix: 'Upload the module ZIP to the release, or fix release.assetPattern in module.yaml.',
  },
  'asset-multiple': {
    summary: 'More than one release asset matches release.assetPattern (or, without a pattern, the release has several .zip assets).',
    fix: 'Set release.assetPattern in module.yaml so that exactly one asset matches.',
  },
  'asset-not-uploaded': {
    summary: 'A release asset is not in the "uploaded" state.',
    fix: 'Wait for the upload to finish or publish a new release.',
  },
  'asset-url-invalid': {
    summary: 'The asset download URL is not https://github.com/{owner}/{repo}/releases/download/... of the bound repository.',
    fix: 'Upload the ZIP as an asset of a release in the registered repository.',
  },
  'asset-download-failed': {
    summary: '(caller) The release asset could not be downloaded.',
    fix: 'Usually transient; use "Sync now" to retry. Make sure the repository and release are public.',
  },
  'asset-size-mismatch': {
    summary: '(caller) The downloaded asset size differs from the size reported by the GitHub API.',
    fix: 'Usually transient; retry. If it persists, publish a new release.',
  },
  'asset-digest-mismatch': {
    summary: '(caller) The sha256 of the downloaded asset differs from the digest reported by the GitHub API.',
    fix: 'Usually transient; retry. If it persists, publish a new release.',
  },

  /* ---------------- version rules ---------------- */
  'version-not-newer': {
    summary: '(caller) The versionCode is lower than the currently published stable versionCode.',
    fix: 'Publish a new release whose module.prop versionCode is greater than the published one.',
  },

  /* ---------------- ZIP structure ---------------- */
  'zip-too-large': {
    summary: 'The ZIP file is larger than the size limit from policy.yaml.',
    fix: 'Reduce the module size.',
  },
  'zip-not-zip': {
    summary: 'The asset is not a ZIP archive (no valid end-of-central-directory record).',
    fix: 'Upload a regular ZIP file; do not append data after the archive.',
  },
  'zip-corrupt': {
    summary: 'The ZIP structure is inconsistent (central directory bounds, signatures, sizes or offsets).',
    fix: 'Re-create the ZIP with a standard tool (zip, 7z, the module-release action).',
  },
  'zip-multi-disk': {
    summary: 'Split / multi-disk ZIP archives are not supported.',
    fix: 'Create a single-file ZIP.',
  },
  'zip64-invalid': {
    summary: 'The ZIP64 records or extra fields are missing or contradict the regular ZIP headers.',
    fix: 'Re-create the ZIP with a standard tool.',
  },
  'zip-too-many-entries': {
    summary: 'The ZIP contains more entries than allowed by policy.yaml.',
    fix: 'Reduce the number of files in the module.',
  },
  'zip-uncompressed-too-large': {
    summary: 'The total declared uncompressed size exceeds the limit from policy.yaml.',
    fix: 'Reduce the size of the module contents.',
  },
  'zip-bomb-ratio': {
    summary: 'The compression ratio (whole archive or a single large entry) exceeds the limit from policy.yaml.',
    fix: 'Remove highly compressible filler data (e.g. zero-filled images) from the module.',
  },
  'zip-overlapping-entries': {
    summary: 'Two or more ZIP entries share or overlap the same local data.',
    fix: 'Re-create the ZIP with a standard tool.',
  },
  'zip-path-traversal': {
    summary: 'A ZIP entry name contains a ".." path segment.',
    fix: 'Re-create the ZIP from inside the module directory so that names are relative.',
  },
  'zip-absolute-path': {
    summary: 'A ZIP entry name is absolute (leading "/" or a drive letter such as "C:").',
    fix: 'Re-create the ZIP from inside the module directory so that names are relative.',
  },
  'zip-backslash-path': {
    summary: 'A ZIP entry name contains a backslash; ZIP paths must use "/".',
    fix: 'Re-create the ZIP with a tool that writes "/" separators.',
  },
  'zip-path-invalid': {
    summary: 'A ZIP entry name is empty, resolves to no file name (e.g. "."), contains control characters, is not valid UTF-8, or has an invalid or conflicting Unicode path field.',
    fix: 'Rename the file and re-create the ZIP.',
  },
  'zip-duplicate-entry': {
    summary: 'Two ZIP entries extract to the same path (compared after dropping "." and empty segments, e.g. "a/b", "./a/b" and "a//b").',
    fix: 'Re-create the ZIP so each path appears once.',
  },
  'zip-encrypted': {
    summary: 'The ZIP contains encrypted entries.',
    fix: 'Create the ZIP without a password.',
  },
  'zip-unsupported-method': {
    summary: 'A ZIP entry uses a compression method KernelSU cannot extract (supported: 0 stored, 8 deflate, 9 deflate64, 14 LZMA, 95 XZ), or module.prop is not stored/deflated.',
    fix: 'Re-create the ZIP using deflate or no compression.',
  },
  'zip-entry-corrupt': {
    summary: 'The module.prop entry data is corrupt (local header mismatch, inflate error, size or CRC-32 mismatch).',
    fix: 'Re-create the ZIP with a standard tool.',
  },

  /* ---------------- module.prop ---------------- */
  'prop-missing': {
    summary: 'The ZIP has no module.prop at its root.',
    fix: 'Put module.prop at the top level of the ZIP.',
  },
  'prop-not-at-root': {
    summary: 'module.prop exists only inside a sub-directory of the ZIP (the module folder itself was zipped).',
    fix: 'Zip the contents of the module directory, not the directory itself.',
  },
  'prop-duplicate': {
    summary: 'More than one ZIP entry extracts to the root module.prop (e.g. "module.prop" and "./module.prop", or a "module.prop/" directory).',
    fix: 'Re-create the ZIP with a single module.prop.',
  },
  'prop-too-large': {
    summary: 'module.prop exceeds the size limit from policy.yaml.',
    fix: 'Keep module.prop small; it only needs the standard key=value lines.',
  },
  'prop-encoding': {
    summary: 'module.prop is not valid UTF-8.',
    fix: 'Save module.prop as UTF-8.',
  },
  'prop-line-invalid': {
    summary: 'A module.prop line only works because of Java-properties syntax (":" or whitespace instead of "=") or is dropped by KernelSU (line continuation at end of file).',
    fix: 'Use plain key=value lines; start comments with "#" and do not end the file with a backslash.',
  },
  'prop-syntax': {
    summary: 'module.prop contains a malformed \\uXXXX escape (also in comments); KernelSU refuses to install such a module.',
    fix: 'Write the character directly in UTF-8 or use a valid four-digit \\uXXXX escape (no surrogates).',
  },
  'prop-duplicate-key': {
    summary: 'A key appears more than once in module.prop; KernelSU uses the last one (error for id/name/version/versionCode/author/description).',
    fix: 'Keep a single line per key.',
  },
  'prop-missing-field': {
    summary: 'module.prop lacks one of id, name, version, versionCode, author, description, or its value is empty.',
    fix: 'Add the missing key=value line to module.prop.',
  },
  'prop-id-invalid': {
    summary: 'The id in module.prop does not match ^[a-zA-Z][a-zA-Z0-9._-]+$ (2-64 characters).',
    fix: 'Use the registered module ID as id in module.prop.',
  },
  'prop-id-mismatch': {
    summary: 'The id in module.prop differs from the registered module ID (comparison is case-sensitive).',
    fix: 'Set id in module.prop to exactly the registered ID and publish a new release.',
  },
  'prop-versioncode-invalid': {
    summary: 'versionCode in module.prop is not a decimal integer.',
    fix: 'Use a plain decimal integer such as versionCode=12.',
  },
  'prop-versioncode-range': {
    summary: 'versionCode in module.prop is outside 1..2147483647 (int32).',
    fix: 'Use a positive versionCode not greater than 2147483647.',
  },
} as const satisfies Record<string, IssueDef>;

export type IssueCode = keyof typeof ISSUE_DEFS;

/** code -> one-line description followed by a fix hint. */
export const ISSUE_CODES: Record<string, string> = Object.fromEntries(
  Object.entries(ISSUE_DEFS).map(([code, d]) => [code, `${d.summary} Fix: ${d.fix}`]),
);

export function issue(code: IssueCode, message: string, severity: Severity = 'error', path?: string): Issue {
  return path === undefined ? { code, severity, message } : { code, severity, message, path };
}

export const hasErrors = (issues: readonly Issue[]): boolean => issues.some((i) => i.severity === 'error');

export function result<T>(issues: Issue[], value?: T): Result<T> {
  const ok = !hasErrors(issues);
  return ok && value !== undefined ? { ok, value, issues } : { ok, issues };
}

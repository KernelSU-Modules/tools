import { z } from 'zod';

/**
 * params.json (schemaVersion 1) at the root of a script entry's release ZIP: the parameters the manager asks for
 * before running action.sh. Each value reaches the script as the environment variable `KSU_PARAM_<key>`
 * (bool → "true" / "false", int → decimal, enum → the option value, string → as entered).
 *
 * Like module.yaml, objects are not strict: unknown fields are dropped (the validator warns), only an unsupported
 * `schemaVersion` is fatal. Cross-field rules (unique keys / option values, a pattern that compiles, a default that
 * satisfies its own constraints, min <= max) are checked by the validator (`parseParams`), not by this schema.
 */

export const PARAMS_SCHEMA_VERSION = 1;
export const SUPPORTED_PARAMS_VERSIONS = [1] as const;
/** params.json is read from the release ZIP; larger files are rejected. */
export const PARAMS_MAX_BYTES = 64 * 1024;
export const PARAMS_MAX = 16;
export const PARAM_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
export const PARAM_TEXT_MAX = 200;
export const PARAM_OPTION_VALUE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const PARAM_OPTIONS_MAX = 32;
export const PARAM_STRING_MAX_LENGTH = 1024;
export const PARAM_PATTERN_MAX = 256;
export const PARAM_STRING_DEFAULT_MAX_LENGTH = 256;
/** int values are exchanged as 32-bit signed integers (Kotlin Int on the manager side). */
export const PARAM_INT_MIN = -2147483648;
export const PARAM_INT_MAX = 2147483647;

/** Labels and descriptions are single-language, like module content. */
const Text = z.string().trim().min(1).max(PARAM_TEXT_MAX);

const ParamInt = z.number().int().min(PARAM_INT_MIN).max(PARAM_INT_MAX);

const common = {
  key: z.string().regex(PARAM_KEY_PATTERN, 'must match ^[A-Z][A-Z0-9_]{0,31}$'),
  label: Text,
  description: Text.optional(),
};

export const BoolParam = z.object({
  ...common,
  type: z.literal('bool'),
  default: z.boolean().default(false),
});

export const EnumOption = z.object({
  value: z.string().regex(PARAM_OPTION_VALUE_PATTERN, 'must match ^[A-Za-z0-9._-]{1,64}$'),
  label: Text.optional(),
});

export const EnumParam = z.object({
  ...common,
  type: z.literal('enum'),
  options: z.array(EnumOption).min(1).max(PARAM_OPTIONS_MAX),
  /** One of the option values; default: the first option. */
  default: z.string().optional(),
});

export const StringParam = z.object({
  ...common,
  type: z.literal('string'),
  default: z.string().default(''),
  maxLength: z.number().int().min(1).max(PARAM_STRING_MAX_LENGTH).default(PARAM_STRING_DEFAULT_MAX_LENGTH),
  /** JavaScript RegExp source; clients require a full match. Keep to the common ECMAScript / Java subset. */
  pattern: z.string().min(1).max(PARAM_PATTERN_MAX).optional(),
  /** false: the empty string is always accepted (the pattern only applies to non-empty values). */
  required: z.boolean().default(false),
});

export const IntParam = z.object({
  ...common,
  type: z.literal('int'),
  /** Default: `min`, or 0 without `min`. */
  default: ParamInt.optional(),
  min: ParamInt.optional(),
  max: ParamInt.optional(),
});

export const ScriptParam = z.discriminatedUnion('type', [BoolParam, EnumParam, StringParam, IntParam]);
export type ScriptParam = z.infer<typeof ScriptParam>;

export const ScriptParams = z.object({
  schemaVersion: z.literal(PARAMS_SCHEMA_VERSION),
  params: z.array(ScriptParam).max(PARAMS_MAX),
});
export type ScriptParams = z.infer<typeof ScriptParams>;

/** Known keys per object level (the validator warns about anything else). */
export const PARAMS_KNOWN_KEYS = {
  root: Object.keys(ScriptParams.shape),
  bool: Object.keys(BoolParam.shape),
  enum: Object.keys(EnumParam.shape),
  string: Object.keys(StringParam.shape),
  int: Object.keys(IntParam.shape),
  option: Object.keys(EnumOption.shape),
} as const;

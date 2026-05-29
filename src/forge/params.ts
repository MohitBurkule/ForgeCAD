/**
 * ForgeCAD Parameter System
 *
 * param() calls during script execution register parameters that
 * auto-generate slider UI. The runtime collects them, and the UI
 * renders controls. When a slider changes, the script re-executes
 * with the new value.
 */

export interface ParamDef {
  name: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  integer?: boolean;
  reverse?: boolean;
  boolean?: boolean;
  /** Discriminator for non-numeric parameter kinds. Numeric params leave this undefined. */
  kind?: 'number' | 'bool' | 'string' | 'choice' | 'list';
  /** Current value for string/choice params. */
  stringValue?: string;
  stringDefault?: string;
  /** Allowed labels for choice params. */
  choices?: string[];
  /** Max length for string params. */
  maxLength?: number;
  /** Current/default items for list params. */
  listValue?: unknown[];
  listDefault?: unknown[];
}

interface ParamScope {
  namePrefix?: string;
  localOverrides?: Record<string, number>;
  /** Keys from localOverrides that were consumed by param()/boolParam() calls */
  consumedKeys?: Set<string>;
}

let _params: ParamDef[] = [];
let _overrides: Record<string, number> = {};
let _scopeStack: ParamScope[] = [];

/** Called before each script execution to reset collected params */
export function resetParams() {
  _params = [];
  _scopeStack = [];
}

/** Set parameter overrides (from slider UI) */
export function setParamOverrides(overrides: Record<string, number>) {
  _overrides = overrides;
}

/** Get all params collected during last execution */
export function getCollectedParams(): ParamDef[] {
  return _params;
}

/** Execute code inside a parameter scope (used by require() with param overrides). */
export function runWithParamScope<T>(scope: ParamScope, fn: () => T): T {
  _scopeStack.push(scope);
  try {
    return fn();
  } finally {
    _scopeStack.pop();
  }
}

function hasOwn(obj: Record<string, number>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Declare a parameter. Returns the current value (default or overridden).
 * Each call registers the param for UI generation.
 */
export function param(
  name: string,
  defaultValue: number,
  opts: { min?: number; max?: number; step?: number; unit?: string; integer?: boolean; reverse?: boolean } = {},
): number {
  const scope = _scopeStack[_scopeStack.length - 1];
  const scopedName = scope?.namePrefix ? `${scope.namePrefix} / ${name}` : name;
  const scopedLocal = scope?.localOverrides;
  const hasLocalOverride = !!(scopedLocal && hasOwn(scopedLocal, name));

  if (hasLocalOverride) scope!.consumedKeys?.add(name);

  const raw = (hasLocalOverride ? scopedLocal![name] : undefined) ?? _overrides[scopedName] ?? _overrides[name] ?? defaultValue;
  const integer = opts.integer ?? false;
  const value = integer ? Math.round(raw) : raw;
  const min = opts.min ?? 0;
  const max = opts.max ?? defaultValue * 4;
  const step = opts.step ?? (integer ? 1 : max - min > 100 ? 1 : 0.1);

  if (!hasLocalOverride) {
    const def = integer ? Math.round(defaultValue) : defaultValue;
    _params.push({ name: scopedName, value, defaultValue: def, min, max, step, unit: opts.unit, integer, reverse: opts.reverse });
  }
  return value;
}

/**
 * Declare a boolean parameter. Returns the current boolean value.
 * Renders as a checkbox in the UI.
 */
export function boolParam(name: string, defaultValue: boolean): boolean {
  const scope = _scopeStack[_scopeStack.length - 1];
  const scopedName = scope?.namePrefix ? `${scope.namePrefix} / ${name}` : name;
  const scopedLocal = scope?.localOverrides;
  const hasLocalOverride = !!(scopedLocal && hasOwn(scopedLocal, name));

  if (hasLocalOverride) scope!.consumedKeys?.add(name);

  const numDefault = defaultValue ? 1 : 0;
  const raw = (hasLocalOverride ? scopedLocal![name] : undefined) ?? _overrides[scopedName] ?? _overrides[name] ?? numDefault;
  const value = raw >= 0.5 ? 1 : 0;

  if (!hasLocalOverride) {
    _params.push({ name: scopedName, value, defaultValue: numDefault, min: 0, max: 1, step: 1, boolean: true });
  }
  return value === 1;
}

/** String-valued overrides (from UI/CLI/require), keyed by param name. */
let _stringOverrides: Record<string, string> = {};

/** Set string-valued parameter overrides (for Param.string / Param.choice). */
export function setStringParamOverrides(overrides: Record<string, string>) {
  _stringOverrides = overrides ?? {};
}

function hasOwnStr(obj: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function scopedParamName(name: string): string {
  const scope = _scopeStack[_scopeStack.length - 1];
  return scope?.namePrefix ? `${scope.namePrefix} / ${name}` : name;
}

/**
 * Declare a string parameter that renders as a text input. Returns the current value.
 */
export function stringParam(name: string, defaultValue: string, opts: { maxLength?: number } = {}): string {
  const scope = _scopeStack[_scopeStack.length - 1];
  const scopedName = scopedParamName(name);
  const scopedLocal = scope?.localOverrides;
  // String params consume string overrides; mark the key consumed if present (numeric scope tracking).
  if (scopedLocal && hasOwn(scopedLocal, name)) scope!.consumedKeys?.add(name);

  let value =
    (hasOwnStr(_stringOverrides, scopedName) ? _stringOverrides[scopedName] : undefined) ??
    (hasOwnStr(_stringOverrides, name) ? _stringOverrides[name] : undefined) ??
    defaultValue;
  if (typeof opts.maxLength === 'number' && value.length > opts.maxLength) value = value.slice(0, opts.maxLength);

  _params.push({
    name: scopedName,
    value: 0,
    defaultValue: 0,
    min: 0,
    max: 0,
    step: 0,
    kind: 'string',
    stringValue: value,
    stringDefault: defaultValue,
    maxLength: opts.maxLength,
  });
  return value;
}

/**
 * Declare a choice parameter that renders as a dropdown. Returns the selected label.
 * Overrides may be a label string or a numeric index.
 */
export function choiceParam(name: string, defaultValue: string, choices: string[]): string {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`Param.choice("${name}"): choices must be a non-empty array of strings`);
  }
  if (!choices.includes(defaultValue)) {
    throw new Error(`Param.choice("${name}"): defaultValue "${defaultValue}" must be one of ${JSON.stringify(choices)}`);
  }
  const scope = _scopeStack[_scopeStack.length - 1];
  const scopedName = scopedParamName(name);
  const scopedLocal = scope?.localOverrides;

  let value = defaultValue;
  // Numeric override = index into choices.
  const numOverride = scopedLocal && hasOwn(scopedLocal, name) ? scopedLocal[name] : (_overrides[scopedName] ?? _overrides[name]);
  if (typeof numOverride === 'number' && Number.isFinite(numOverride)) {
    const idx = Math.round(numOverride);
    if (idx >= 0 && idx < choices.length) value = choices[idx];
    if (scopedLocal && hasOwn(scopedLocal, name)) scope!.consumedKeys?.add(name);
  }
  // String override = label (takes precedence).
  const strOverride =
    (hasOwnStr(_stringOverrides, scopedName) ? _stringOverrides[scopedName] : undefined) ??
    (hasOwnStr(_stringOverrides, name) ? _stringOverrides[name] : undefined);
  if (typeof strOverride === 'string' && choices.includes(strOverride)) value = strOverride;

  _params.push({
    name: scopedName,
    value: choices.indexOf(value),
    defaultValue: choices.indexOf(defaultValue),
    min: 0,
    max: choices.length - 1,
    step: 1,
    kind: 'choice',
    stringValue: value,
    stringDefault: defaultValue,
    choices: [...choices],
  });
  return value;
}

/**
 * Declare a list parameter — an array of struct items. Returns the current items.
 * The UI override mechanism for lists is not yet wired; this returns a clone of the defaults.
 */
export function listParam<T extends Record<string, number | boolean | string>>(
  name: string,
  defaultItems: T[],
  _opts: { fields?: unknown; minItems?: number; maxItems?: number } = {},
): T[] {
  const items = defaultItems.map((it) => ({ ...it }));
  _params.push({
    name: scopedParamName(name),
    value: items.length,
    defaultValue: defaultItems.length,
    min: 0,
    max: defaultItems.length,
    step: 1,
    kind: 'list',
    listValue: items,
    listDefault: defaultItems.map((it) => ({ ...it })),
  });
  return items;
}

/**
 * `Param.*` namespace — the parameter-declaration API surface.
 * `Param.number`/`Param.bool` are aliases of the standalone `param`/`boolParam` functions.
 */
export const Param = {
  number: param,
  string: stringParam,
  bool: boolParam,
  choice: choiceParam,
  list: listParam,
} as const;

/**
 * Create a scope with consumed-key tracking enabled.
 * Pass the returned scope to runWithParamScope(), then call
 * validateConsumedOverrides() after execution completes.
 */
export function createTrackedScope(namePrefix: string, localOverrides: Record<string, number>): ParamScope {
  return { namePrefix, localOverrides, consumedKeys: new Set() };
}

/**
 * After executing an imported file, check that every key in localOverrides
 * was consumed by a param()/boolParam() call. Throws if any keys were not
 * recognized, with fuzzy-match suggestions.
 */
export function validateConsumedOverrides(scope: ParamScope, importKind: string, resolvedPath: string): void {
  const overrides = scope.localOverrides;
  const consumed = scope.consumedKeys;
  if (!overrides || !consumed) return;

  const unconsumed = Object.keys(overrides).filter((k) => !consumed.has(k));
  if (unconsumed.length === 0) return;

  // Collect known param names for suggestions
  const knownNames = new Set<string>();
  for (const p of _params) {
    // Strip scope prefix to get local name
    const slashIdx = p.name.lastIndexOf(' / ');
    knownNames.add(slashIdx >= 0 ? p.name.slice(slashIdx + 3) : p.name);
  }
  // Also include consumed keys (they are valid names)
  for (const k of consumed) knownNames.add(k);

  const suggestions = unconsumed.map((name) => {
    const close = findClosestMatch(name, knownNames);
    return close ? `  "${name}" (did you mean "${close}"?)` : `  "${name}"`;
  });

  throw new Error(
    `${importKind}("${resolvedPath}"): unrecognized parameter override${unconsumed.length > 1 ? 's' : ''}:\n` +
      suggestions.join('\n') +
      `\n\nAvailable parameters: ${[...knownNames].map((n) => `"${n}"`).join(', ') || '(none)'}`,
  );
}

/** Simple Levenshtein-based closest match for typo suggestions. */
function findClosestMatch(input: string, candidates: Set<string>): string | null {
  const inputLower = input.toLowerCase();
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshtein(inputLower, candidate.toLowerCase());
    if (dist < bestDist && dist <= Math.max(input.length, candidate.length) * 0.5) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Lightweight authoring annotations that do not produce geometry.
 *
 * - `Viewport.label()` registers a viewport-only text label (an annotation that
 *   helps a viewer understand the model without becoming real geometry).
 * - `compareWith()` registers a comparison request against a reference asset,
 *   honored by the `inspect comparison` CLI command.
 *
 * Both are collected as side effects during script execution and surfaced to
 * tooling; they never throw for well-formed input so scripts keep running.
 */

export interface ViewportLabel {
  text: string;
  at?: [number, number, number];
  options?: Record<string, unknown>;
}

export interface ComparisonRequest {
  reference: string;
  options: Record<string, unknown>;
}

let _viewportLabels: ViewportLabel[] = [];
let _comparisons: ComparisonRequest[] = [];

export function resetAnnotations(): void {
  _viewportLabels = [];
  _comparisons = [];
}

export function getCollectedViewportLabels(): ViewportLabel[] {
  return _viewportLabels;
}

export function getCollectedComparisons(): ComparisonRequest[] {
  return _comparisons;
}

/**
 * `Viewport.*` — viewport-only annotations that aid understanding without
 * adding geometry. Use `Viewport.label()` for explanatory text.
 */
export const Viewport = {
  /** Register a viewport-only text label at an optional 3D anchor. */
  label(text: string, at?: [number, number, number], options: Record<string, unknown> = {}): void {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Viewport.label(text, at?, options?) requires a non-empty text string');
    }
    _viewportLabels.push({ text, at, options });
  },
} as const;

/**
 * Register a comparison of the current model against a reference asset
 * (an STL/3MF mesh or another .forge.js model). Honored by `inspect comparison`.
 */
export function compareWith(reference: string, options: Record<string, unknown> = {}): void {
  if (typeof reference !== 'string' || reference.length === 0) {
    throw new Error('compareWith(reference, options?) requires a non-empty reference path');
  }
  _comparisons.push({ reference, options: options ?? {} });
}

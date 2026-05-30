/**
 * Belt routing helpers: tangent loops and beltDrive.
 */

import type { Shape } from '../kernel';
import { difference2d } from '../sketch/booleans';
import type { Sketch } from '../sketch/core';
import { path, type PathBuilder } from '../sketch/path';

type BeltVec2 = [number, number];

export type BeltMode = 'open' | 'crossed';

export interface TangentCircle2D {
  name?: string;
  center: BeltVec2;
  radius: number;
}

export interface BeltPulley2D {
  name?: string;
  center: BeltVec2;
  pitchRadius: number;
}

export interface TangentLoop2DOptions {
  /** `open` uses external tangents; `crossed` uses internal tangents. */
  mode?: BeltMode;
}

export interface BeltDriveOptions {
  pulleys: BeltPulley2D[] | Record<string, Omit<BeltPulley2D, 'name'> & { name?: string }>;
  /** Belt width along +Z. */
  beltWidth: number;
  /** Belt thickness in the pulley plane. Default 2mm. */
  beltThickness?: number;
  /**
   * Reserved for multi-pulley route intent. The first implementation supports
   * two-pulley routes and rejects multi-pulley calls with explicit guidance.
   */
  route?: 'outer' | BeltRouteContact[];
  /** Visual stroke width for the returned pitch path sketch. Default 0.25mm. */
  pitchPathWidth?: number;
}

export interface BeltRouteContact {
  pulley: string;
  wrap?: 'cw' | 'ccw' | 'short' | 'long';
  tangentIn?: 'left' | 'right' | 'internal' | 'external';
  tangentOut?: 'left' | 'right' | 'internal' | 'external';
}

export interface BeltLineSpan {
  kind: 'line';
  fromPulley: string;
  toPulley: string;
  from: BeltVec2;
  to: BeltVec2;
  length: number;
}

export interface BeltWrapArc {
  kind: 'arc';
  pulley: string;
  center: BeltVec2;
  pitchRadius: number;
  from: BeltVec2;
  to: BeltVec2;
  sweepDeg: number;
  wrapDeg: number;
  length: number;
  tangentIn: BeltVec2;
  tangentOut: BeltVec2;
}

export type BeltPathSegment = BeltLineSpan | BeltWrapArc;

export interface BeltDriveResult {
  belt: Shape;
  beltProfile: Sketch;
  pitchPath: Sketch;
  route: TangentLoop2D;
  length: number;
  wraps: BeltWrapArc[];
  wrapByPulley: Record<string, BeltWrapArc>;
  straightSpans: BeltLineSpan[];
  skippedPulleys: string[];
}

interface TangentPair {
  a: BeltVec2;
  b: BeltVec2;
}

const EPS = 1e-9;

function assertFinitePositive(apiName: string, name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${apiName}: "${name}" must be a positive finite number.`);
  }
}

function add(a: BeltVec2, b: BeltVec2): BeltVec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

function sub(a: BeltVec2, b: BeltVec2): BeltVec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function scale(v: BeltVec2, s: number): BeltVec2 {
  return [v[0] * s, v[1] * s];
}

function dot(a: BeltVec2, b: BeltVec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

function len(v: BeltVec2): number {
  return Math.hypot(v[0], v[1]);
}

function dist(a: BeltVec2, b: BeltVec2): number {
  return len(sub(b, a));
}

function norm(v: BeltVec2): BeltVec2 {
  const l = len(v);
  if (l < EPS) throw new Error('beltDrive: coincident tangent points produced a zero-length direction.');
  return [v[0] / l, v[1] / l];
}

function angleOf(center: BeltVec2, point: BeltVec2): number {
  return Math.atan2(point[1] - center[1], point[0] - center[0]);
}

function normalizePositiveRadians(angle: number): number {
  let out = angle % (Math.PI * 2);
  if (out < 0) out += Math.PI * 2;
  return out;
}

function tangentAt(radiusAngle: number, clockwise: boolean): BeltVec2 {
  const cos = Math.cos(radiusAngle);
  const sin = Math.sin(radiusAngle);
  return clockwise ? [sin, -cos] : [-sin, cos];
}

function chooseSweepDeg(center: BeltVec2, start: BeltVec2, end: BeltVec2, incomingDir: BeltVec2): number {
  const startAngle = angleOf(center, start);
  const endAngle = angleOf(center, end);
  const cwTangent = tangentAt(startAngle, true);
  const ccwTangent = tangentAt(startAngle, false);
  const clockwise = dot(cwTangent, incomingDir) >= dot(ccwTangent, incomingDir);
  const sweep = clockwise ? -normalizePositiveRadians(startAngle - endAngle) : normalizePositiveRadians(endAngle - startAngle);
  return (sweep * 180) / Math.PI;
}

function normalizeCircle(input: TangentCircle2D, index: number, radiusOverride?: number): TangentCircle2D {
  const name = input.name ?? `pulley${index + 1}`;
  if (!Array.isArray(input.center) || input.center.length < 2) {
    throw new Error(`beltDrive: pulley "${name}" needs center: [x, y].`);
  }
  const center: BeltVec2 = [Number(input.center[0]), Number(input.center[1])];
  const radius = radiusOverride ?? Number(input.radius);
  if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) {
    throw new Error(`beltDrive: pulley "${name}" center coordinates must be finite numbers.`);
  }
  assertFinitePositive('beltDrive', `${name}.radius`, radius);
  return { name, center, radius };
}

function normalizePulleyList(input: BeltDriveOptions['pulleys']): BeltPulley2D[] {
  if (Array.isArray(input)) {
    return input.map((pulley, index) => ({
      name: pulley.name ?? `pulley${index + 1}`,
      center: [Number(pulley.center[0]), Number(pulley.center[1])],
      pitchRadius: Number(pulley.pitchRadius),
    }));
  }

  return Object.entries(input).map(([key, pulley]) => ({
    name: pulley.name ?? key,
    center: [Number(pulley.center[0]), Number(pulley.center[1])],
    pitchRadius: Number(pulley.pitchRadius),
  }));
}

function normalizePulleyAsCircle(pulley: BeltPulley2D, index: number, radiusOverride?: number): TangentCircle2D {
  return normalizeCircle(
    {
      name: pulley.name ?? `pulley${index + 1}`,
      center: pulley.center,
      radius: pulley.pitchRadius,
    },
    index,
    radiusOverride,
  );
}

function commonTangents(a: TangentCircle2D, b: TangentCircle2D, mode: BeltMode): TangentPair[] {
  const delta = sub(b.center, a.center);
  const z = dot(delta, delta);
  if (z < EPS) {
    throw new Error(`beltDrive: pulleys "${a.name}" and "${b.name}" have the same center.`);
  }

  const signedA = mode === 'open' ? 1 : -1;
  const r = signedA * a.radius - b.radius;
  const h2 = z - r * r;

  if (h2 <= EPS) {
    const centerDistance = Math.sqrt(z);
    if (mode === 'open') {
      throw new Error(
        `beltDrive: cannot create an open belt between "${a.name}" and "${b.name}". ` +
          `The pitch circles overlap or one contains the other. ` +
          `center distance: ${centerDistance.toFixed(3)} mm; required: > abs(${b.radius.toFixed(3)} - ${a.radius.toFixed(3)}) mm.`,
      );
    }
    throw new Error(
      `beltDrive: cannot create a crossed belt between "${a.name}" and "${b.name}". ` +
        `center distance: ${centerDistance.toFixed(3)} mm; required: > ${(a.radius + b.radius).toFixed(3)} mm.`,
    );
  }

  const h = Math.sqrt(h2);
  return [1, -1].map((side) => {
    const nx = (delta[0] * r - delta[1] * h * side) / z;
    const ny = (delta[1] * r + delta[0] * h * side) / z;
    const normal: BeltVec2 = [nx, ny];
    return {
      a: add(a.center, scale(normal, a.radius * signedA)),
      b: add(b.center, scale(normal, b.radius)),
    };
  });
}

function buildSegmentsForTangentOrder(a: TangentCircle2D, b: TangentCircle2D, t0: TangentPair, t1: TangentPair): BeltPathSegment[] {
  const span0Dir = norm(sub(t0.b, t0.a));
  const span1Dir = norm(sub(t1.a, t1.b));
  const bSweepDeg = chooseSweepDeg(b.center, t0.b, t1.b, span0Dir);
  const aSweepDeg = chooseSweepDeg(a.center, t1.a, t0.a, span1Dir);

  const span0: BeltLineSpan = {
    kind: 'line',
    fromPulley: a.name!,
    toPulley: b.name!,
    from: t0.a,
    to: t0.b,
    length: dist(t0.a, t0.b),
  };
  const wrapB: BeltWrapArc = {
    kind: 'arc',
    pulley: b.name!,
    center: b.center,
    pitchRadius: b.radius,
    from: t0.b,
    to: t1.b,
    sweepDeg: bSweepDeg,
    wrapDeg: Math.abs(bSweepDeg),
    length: Math.abs((bSweepDeg * Math.PI) / 180) * b.radius,
    tangentIn: t0.b,
    tangentOut: t1.b,
  };
  const span1: BeltLineSpan = {
    kind: 'line',
    fromPulley: b.name!,
    toPulley: a.name!,
    from: t1.b,
    to: t1.a,
    length: dist(t1.b, t1.a),
  };
  const wrapA: BeltWrapArc = {
    kind: 'arc',
    pulley: a.name!,
    center: a.center,
    pitchRadius: a.radius,
    from: t1.a,
    to: t0.a,
    sweepDeg: aSweepDeg,
    wrapDeg: Math.abs(aSweepDeg),
    length: Math.abs((aSweepDeg * Math.PI) / 180) * a.radius,
    tangentIn: t1.a,
    tangentOut: t0.a,
  };

  return [span0, wrapB, span1, wrapA];
}

function buildTwoPulleySegments(circles: [TangentCircle2D, TangentCircle2D], mode: BeltMode): BeltPathSegment[] {
  const [a, b] = circles;
  const [t0, t1] = commonTangents(a, b, mode);
  const candidateA = buildSegmentsForTangentOrder(a, b, t0, t1);
  const candidateB = buildSegmentsForTangentOrder(a, b, t1, t0);

  if (mode !== 'open' || Math.abs(a.radius - b.radius) < EPS) return candidateA;

  const larger = a.radius > b.radius ? a.name! : b.name!;
  const smaller = a.radius > b.radius ? b.name! : a.name!;
  const score = (segments: BeltPathSegment[]) => {
    const wraps = Object.fromEntries(
      segments.filter((segment): segment is BeltWrapArc => segment.kind === 'arc').map((wrap) => [wrap.pulley, wrap]),
    );
    return wraps[larger].wrapDeg - wraps[smaller].wrapDeg;
  };

  return score(candidateA) >= score(candidateB) ? candidateA : candidateB;
}

function pathFromSegments(segments: BeltPathSegment[]): PathBuilder {
  if (segments.length === 0 || segments[0].kind !== 'line') {
    throw new Error('beltDrive: internal route error, expected first segment to be a line.');
  }
  const builder = path().moveTo(segments[0].from[0], segments[0].from[1]);
  for (const segment of segments) {
    if (segment.kind === 'line') {
      builder.lineTo(segment.to[0], segment.to[1]);
    } else {
      builder.arcAround(segment.center[0], segment.center[1], segment.sweepDeg);
    }
  }
  return builder;
}

/**
 * Closed 2D route made from tangent line spans and circular wrap arcs.
 *
 * Returned by `lib.tangentLoop2d()` and `lib.beltDrive().route`. Use it when
 * you need measurements, a pitch-path sketch, or a belt band profile.
 */
export class TangentLoop2D {
  public readonly circles: TangentCircle2D[];
  public readonly mode: BeltMode;
  public readonly segments: BeltPathSegment[];
  public readonly straightSpans: BeltLineSpan[];
  public readonly wraps: BeltWrapArc[];
  public readonly wrapByPulley: Record<string, BeltWrapArc>;
  public readonly length: number;

  constructor(circles: TangentCircle2D[], options: TangentLoop2DOptions = {}) {
    if (circles.length !== 2) {
      throw new Error(
        `tangentLoop2d: expected exactly 2 circles for the first implementation, got ${circles.length}. ` +
          'For multi-pulley belts, pass an explicit ordered route once multi-contact routing is implemented.',
      );
    }
    this.circles = circles.map((circle, index) => normalizeCircle(circle, index)) as [TangentCircle2D, TangentCircle2D];
    this.mode = options.mode ?? 'open';
    this.segments = buildTwoPulleySegments(this.circles as [TangentCircle2D, TangentCircle2D], this.mode);
    this.straightSpans = this.segments.filter((segment): segment is BeltLineSpan => segment.kind === 'line');
    this.wraps = this.segments.filter((segment): segment is BeltWrapArc => segment.kind === 'arc');
    this.wrapByPulley = Object.fromEntries(this.wraps.map((wrap) => [wrap.pulley, wrap]));
    this.length = this.segments.reduce((sum, segment) => sum + segment.length, 0);
  }

  /** Convert the loop centerline into a thin visual sketch. */
  toSketch(width = 0.25): Sketch {
    assertFinitePositive('tangentLoop2d.toSketch()', 'width', width);
    return pathFromSegments(this.segments).stroke(width, 'Round');
  }

  /** Convert the loop into a filled profile using the pitch path itself as the boundary. */
  toProfile(): Sketch {
    return pathFromSegments(this.segments).close();
  }

  /** Build a belt band sketch by offsetting the route to inner and outer pulley radii. */
  offsetBand(thickness: number): Sketch {
    assertFinitePositive('tangentLoop2d.offsetBand()', 'thickness', thickness);
    const half = thickness / 2;
    const minRadius = Math.min(...this.circles.map((circle) => circle.radius));
    if (half >= minRadius) {
      throw new Error(`tangentLoop2d.offsetBand(): thickness ${thickness} is too large for the smallest pulley radius ${minRadius}.`);
    }
    const outer = tangentLoop2d(
      this.circles.map((circle) => ({ ...circle, radius: circle.radius + half })),
      { mode: this.mode },
    ).toProfile();
    const inner = tangentLoop2d(
      this.circles.map((circle) => ({ ...circle, radius: circle.radius - half })),
      { mode: this.mode },
    ).toProfile();
    return difference2d(outer, inner);
  }
}

/**
 * Build a closed 2D route made from common tangent spans and pulley wrap arcs.
 *
 * Use this when you need reusable belt/chain route geometry before creating a
 * solid body. The first implementation supports two circles. `mode: "open"`
 * uses external tangents; `mode: "crossed"` uses internal tangents.
 *
 * ```ts
 * const route = lib.tangentLoop2d([
 *   { center: [0, 0], radius: 12 },
 *   { center: [80, 0], radius: 28 },
 * ]);
 * const belt = route.offsetBand(2).extrude(8);
 * ```
 *
 * @category Belt Drives
 */
export function tangentLoop2d(circles: TangentCircle2D[], options: TangentLoop2DOptions = {}): TangentLoop2D {
  return new TangentLoop2D(circles, options);
}

/**
 * Create a flat open-belt body around two pulley pitch circles.
 *
 * The belt is generated as a tangent loop in the XY plane and extruded along
 * +Z by `beltWidth`. The result includes the solid belt, the 2D belt profile,
 * a thin pitch-path sketch for visualization, total belt length, tangent spans,
 * and wrap metadata for each pulley.
 *
 * For more than two pulleys, the API intentionally asks for route intent before
 * geometry is created. Use `route: "outer"` for the future outside-envelope
 * mode, or an ordered route for future serpentine/idler layouts.
 *
 * ```ts
 * const drive = lib.beltDrive({
 *   pulleys: [
 *     { name: "motor", center: [0, 0], pitchRadius: 12 },
 *     { name: "output", center: [80, 0], pitchRadius: 28 },
 *   ],
 *   beltWidth: 8,
 *   beltThickness: 2,
 * });
 * return drive.belt;
 * ```
 *
 * @category Belt Drives
 */
export function beltDrive(options: BeltDriveOptions): BeltDriveResult {
  const pulleys = normalizePulleyList(options.pulleys);
  assertFinitePositive('beltDrive', 'beltWidth', options.beltWidth);
  const beltThickness = options.beltThickness ?? 2;
  assertFinitePositive('beltDrive', 'beltThickness', beltThickness);

  if (pulleys.length !== 2) {
    const routeHint =
      options.route == null
        ? 'Use route: "outer" for the future outside-envelope mode, or pass an ordered route once multi-contact routing is implemented.'
        : 'Multi-pulley route intent was provided, but multi-contact belt routing is not implemented in this first pass.';
    throw new Error(`beltDrive: expected exactly 2 pulleys for the first implementation, got ${pulleys.length}. ${routeHint}`);
  }

  const circles = pulleys.map((pulley, index) => normalizePulleyAsCircle(pulley, index)) as [TangentCircle2D, TangentCircle2D];
  const route = tangentLoop2d(circles, { mode: 'open' });
  const beltProfile = route.offsetBand(beltThickness);
  const belt = beltProfile.extrude(options.beltWidth);

  return {
    belt,
    beltProfile,
    pitchPath: route.toSketch(options.pitchPathWidth ?? 0.25),
    route,
    length: route.length,
    wraps: route.wraps,
    wrapByPulley: route.wrapByPulley,
    straightSpans: route.straightSpans,
    skippedPulleys: [],
  };
}

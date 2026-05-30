import type { Shape } from '../kernel';
import { Curve3D, sweep, type SweepOptions } from './curves';
import { Sketch } from './core';
import { circle2d } from './primitives';

type Vec3 = [number, number, number];

function requireFinite(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where}: expected a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePositive(value: unknown, where: string): number {
  const v = requireFinite(value, where);
  if (!(v > 0)) throw new Error(`${where}: expected a positive number, got ${v}`);
  return v;
}

export interface HelixOptions {
  /** Radius from the central Z axis to the helix centerline. */
  radius: number;
  /** Axial distance per full turn. Provide any two of pitch, turns, and height. */
  pitch?: number;
  /** Number of full rotations around the axis. Provide any two of pitch, turns, and height. */
  turns?: number;
  /** Total height along +Z. Provide any two of pitch, turns, and height. */
  height?: number;
  /** Start angle in degrees. Default 0 starts on +X. */
  startAngle?: number;
  /** Reverse winding direction when viewed from +Z. */
  clockwise?: boolean;
  /** Point samples per turn for the metadata path. Default 32. */
  samplesPerTurn?: number;
}

export interface HelixCoilOptions extends HelixOptions {
  /** Radius of the circular wire profile. Required unless a custom profile is passed. */
  wireRadius?: number;
  /** Segment count for the default circular wire profile. Default 24. */
  profileSegments?: number;
  /** Sweep path samples per turn. Default 32. */
  divisionsPerTurn?: number;
}

/** Resolve the (pitch, turns, height) triple from any two supplied values. */
function resolveHelixGeometry(options: HelixOptions): { pitch: number; turns: number; height: number } {
  const hasPitch = options.pitch != null;
  const hasTurns = options.turns != null;
  const hasHeight = options.height != null;
  const supplied = [hasPitch, hasTurns, hasHeight].filter(Boolean).length;
  if (supplied < 2) {
    throw new Error('Helix: provide any two of `pitch`, `turns`, and `height`.');
  }

  let pitch: number;
  let turns: number;
  let height: number;
  if (hasTurns && hasPitch) {
    turns = requirePositive(options.turns, 'Helix.turns');
    pitch = requirePositive(options.pitch, 'Helix.pitch');
    height = pitch * turns;
  } else if (hasTurns && hasHeight) {
    turns = requirePositive(options.turns, 'Helix.turns');
    height = requirePositive(options.height, 'Helix.height');
    pitch = height / turns;
  } else {
    pitch = requirePositive(options.pitch, 'Helix.pitch');
    height = requirePositive(options.height, 'Helix.height');
    turns = height / pitch;
  }
  return { pitch, turns, height };
}

/**
 * Metadata-bearing helical curve around the Z axis. Use `Helix.path(...)` for sampling,
 * placement, or `sweep()`, and `Helix.coil(...)` for helix-oriented solids.
 */
export class HelixCurve extends Curve3D {
  public readonly radius: number;
  public readonly pitch: number;
  public readonly turns: number;
  public readonly height: number;
  public readonly startAngle: number;
  public readonly clockwise: boolean;

  constructor(options: HelixOptions) {
    const radius = requirePositive(options.radius, 'Helix.radius');
    const { pitch, turns, height } = resolveHelixGeometry(options);
    const startAngle = requireFinite(options.startAngle ?? 0, 'Helix.startAngle');
    const clockwise = options.clockwise === true;
    const samplesPerTurn = Math.max(3, Math.floor(options.samplesPerTurn ?? 32));

    const total = Math.max(2, Math.ceil(samplesPerTurn * turns) + 1);
    const start = (startAngle * Math.PI) / 180;
    const dir = clockwise ? -1 : 1;
    const points: Vec3[] = [];
    for (let i = 0; i < total; i++) {
      const t = i / (total - 1);
      const a = start + dir * 2 * Math.PI * turns * t;
      points.push([radius * Math.cos(a), radius * Math.sin(a), height * t]);
    }
    super(points, { closed: false, tension: 0.5 });

    this.radius = radius;
    this.pitch = pitch;
    this.turns = turns;
    this.height = height;
    this.startAngle = startAngle;
    this.clockwise = clockwise;
  }

  /** Exact analytic point on the helix at t in [0, 1]. */
  override pointAt(t: number): Vec3 {
    const tt = Math.max(0, Math.min(1, t));
    const start = (this.startAngle * Math.PI) / 180;
    const dir = this.clockwise ? -1 : 1;
    const a = start + dir * 2 * Math.PI * this.turns * tt;
    return [this.radius * Math.cos(a), this.radius * Math.sin(a), this.height * tt];
  }

  /** Exact analytic unit tangent at t in [0, 1]. */
  override tangentAt(t: number): Vec3 {
    const tt = Math.max(0, Math.min(1, t));
    const start = (this.startAngle * Math.PI) / 180;
    const dir = this.clockwise ? -1 : 1;
    const a = start + dir * 2 * Math.PI * this.turns * tt;
    const dx = -this.radius * Math.sin(a) * dir * 2 * Math.PI * this.turns;
    const dy = this.radius * Math.cos(a) * dir * 2 * Math.PI * this.turns;
    const dz = this.height;
    const len = Math.hypot(dx, dy, dz) || 1;
    return [dx / len, dy / len, dz / len];
  }

  /** Exact closed-form helix arc length. */
  override length(): number {
    const circ = 2 * Math.PI * this.radius * this.turns;
    return Math.hypot(circ, this.height);
  }
}

/**
 * Helical curve helpers.
 *
 * `Helix.path()` is the reusable centerline primitive; `Helix.coil()` sweeps a profile
 * along the same helix definition into a solid coil.
 */
export const Helix = {
  /** Create a metadata-bearing helical centerline around the Z axis. */
  path(options: HelixOptions): HelixCurve {
    if (options == null || typeof options !== 'object') {
      throw new Error('Helix.path: options object is required.');
    }
    return new HelixCurve(options);
  },

  /** Create a solid helical coil by sweeping a profile through helix-local frames. */
  coil(profileOrOptions: Sketch | HelixCoilOptions, maybeOptions?: HelixCoilOptions): Shape {
    let profile: Sketch | undefined;
    let options: HelixCoilOptions;
    if (profileOrOptions instanceof Sketch) {
      if (maybeOptions == null) throw new Error('Helix.coil: options object is required when a profile is passed.');
      profile = profileOrOptions;
      options = maybeOptions;
    } else {
      options = profileOrOptions;
    }
    if (options == null || typeof options !== 'object') {
      throw new Error('Helix.coil: options object is required.');
    }

    const curve = new HelixCurve(options);

    if (!profile) {
      const wireRadius = requirePositive(options.wireRadius, 'Helix.coil.wireRadius');
      const segments = Math.max(8, Math.floor(options.profileSegments ?? 24));
      profile = circle2d(wireRadius, segments);
    }

    const divisionsPerTurn = Math.max(4, Math.floor(options.divisionsPerTurn ?? 32));
    const samples = Math.max(8, Math.ceil(divisionsPerTurn * curve.turns) + 1);
    const sweepOptions: SweepOptions = { samples };
    return sweep(profile, curve, sweepOptions);
  },
};

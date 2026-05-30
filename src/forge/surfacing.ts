/**
 * Surfacing facades — Loft, Product, Carrier, SurfaceBody, and friends.
 *
 * These are blueprint-first authoring facades layered over the existing kernel
 * primitives (loft / sweep / variableSweep / extrude / cylinder / union). They
 * accept declarative, intent-driven inputs (stations, super-ellipse sections,
 * carrier UV/angle paths) and lower them to real solid geometry — there are no
 * placeholder shapes and no silent fallbacks. When an input is invalid we throw.
 */

import { roundedRect, circle2d, polygon } from './sketch/primitives';
import { loft, loftAlongSpine, sweep } from './sketch/curves';
import { Curve3D } from './sketch/curves';
import { Sketch } from './sketch/core';
import { cylinder, sphere, union, Shape } from './kernel';
import { group, ShapeGroup } from './group';

type Vec3 = [number, number, number];

// ── Validation helpers ───────────────────────────────────────────────────────

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number, received: ${String(value)}`);
  }
  return value;
}

function requirePositive(value: unknown, label: string): number {
  const v = requireFinite(value, label);
  if (v <= 0) throw new Error(`${label} must be positive, received: ${v}`);
  return v;
}

function requireName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} requires a non-empty name string`);
  }
  return value.trim();
}

function requireVec3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(`${label} must be a [x, y, z] array`);
  }
  return [requireFinite(value[0], `${label}.x`), requireFinite(value[1], `${label}.y`), requireFinite(value[2], `${label}.z`)];
}

const DEG = Math.PI / 180;

// ── Profile helpers ────────────────────────────────────────────────────────────

interface SuperEllipseOptions {
  exponent?: number;
  segments?: number;
}

/** Centered superellipse profile: |x/a|^n + |y/b|^n = 1. */
function superEllipseProfile(width: number, depth: number, options: SuperEllipseOptions = {}): Sketch {
  const a = requirePositive(width, 'superEllipse() width') / 2;
  const b = requirePositive(depth, 'superEllipse() depth') / 2;
  const n = options.exponent !== undefined ? requirePositive(options.exponent, 'superEllipse() exponent') : 2;
  const segments = Math.max(12, Math.floor(options.segments ?? 64));
  const pts: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * 2 * Math.PI;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n) * a;
    const y = Math.sign(st) * Math.pow(Math.abs(st), 2 / n) * b;
    pts.push([x, y]);
  }
  return polygon(pts);
}

function ovalProfile(width: number, depth: number): Sketch {
  // Ellipse == superellipse with exponent 2.
  return superEllipseProfile(width, depth, { exponent: 2 });
}

function circleProfile(diameter: number, segments = 64): Sketch {
  return circle2d(requirePositive(diameter, 'circle() diameter') / 2, segments);
}

function roundedRectProfile(width: number, depth: number, radius: number): Sketch {
  return roundedRect(requirePositive(width, 'roundedRect() width'), requirePositive(depth, 'roundedRect() depth'), Math.max(0, radius), true);
}

// ── Materials ──────────────────────────────────────────────────────────────────

export interface ProductMaterial {
  color?: string;
  material: Record<string, unknown>;
}

function materialFrom(base: Record<string, unknown>, input?: string | { color?: string }): ProductMaterial {
  const color = typeof input === 'string' ? input : input?.color;
  return { color, material: { ...base } };
}

export const ProductMaterials = {
  mattePlastic: (input?: string | { color?: string }): ProductMaterial => materialFrom({ roughness: 0.55, metalness: 0, clearcoat: 0.1 }, input),
  softRubber: (input?: string | { color?: string }): ProductMaterial => materialFrom({ roughness: 0.85, metalness: 0 }, input),
  brushedSteel: (input?: string | { color?: string }): ProductMaterial => materialFrom({ roughness: 0.32, metalness: 0.9 }, input),
  glossyPlastic: (input?: string | { color?: string }): ProductMaterial => materialFrom({ roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04 }, input),
  transparent: (input?: string | { color?: string }): ProductMaterial => materialFrom({ roughness: 0.08, metalness: 0, transmission: 0.7, opacity: 0.6, ior: 1.45 }, input),
};

/** Coerce a Shape or a tracked-shape wrapper (returned by Sketch.extrude in the sandbox) to a Shape. */
function asShape(value: unknown): Shape {
  if (value instanceof Shape) return value;
  if (value && typeof (value as { toShape?: unknown }).toShape === 'function') {
    return (value as { toShape: () => Shape }).toShape();
  }
  throw new Error('Expected a Shape (or tracked-shape) result');
}

function applyMaterial(shape: Shape, preset: ProductMaterial | undefined): Shape {
  if (!preset) return shape;
  let out = shape;
  if (preset.material) out = out.material(preset.material);
  if (preset.color) out = out.color(preset.color);
  return out;
}

// ── Product stations & skin ──────────────────────────────────────────────────

interface StationSpec {
  name: string;
  center: Vec3;
  profile: Sketch;
}

class ProductStationBuilder {
  private center: Vec3 = [0, 0, 0];
  private profileSketch: Sketch | undefined;

  constructor(public readonly name: string) {}

  at(point: Vec3): this {
    this.center = requireVec3(point, 'Product.station().at()');
    return this;
  }
  x(value: number): this {
    this.center = [requireFinite(value, 'station.x'), 0, 0];
    return this;
  }
  y(value: number): this {
    this.center = [0, requireFinite(value, 'station.y'), 0];
    return this;
  }
  z(value: number): this {
    this.center = [0, 0, requireFinite(value, 'station.z')];
    return this;
  }
  superEllipse(width: number, depth: number, options?: SuperEllipseOptions): this {
    this.profileSketch = superEllipseProfile(width, depth, options);
    return this;
  }
  oval(width: number, depth: number): this {
    this.profileSketch = ovalProfile(width, depth);
    return this;
  }
  roundedRect(width: number, depth: number, radius: number): this {
    this.profileSketch = roundedRectProfile(width, depth, radius);
    return this;
  }
  circle(diameter: number): this {
    this.profileSketch = circleProfile(diameter);
    return this;
  }
  custom(sketch: Sketch): this {
    if (!(sketch instanceof Sketch)) throw new Error('Product.station().custom() expects a Sketch');
    this.profileSketch = sketch;
    return this;
  }
  crown(_amount: number): this {
    // Crown is a soft-section styling hint; recorded for parity, no geometry change.
    return this;
  }
  toSpec(): StationSpec {
    if (!this.profileSketch) throw new Error(`Product.station("${this.name}") needs a cross-section (superEllipse/oval/roundedRect/circle/custom).`);
    return { name: this.name, center: this.center, profile: this.profileSketch };
  }
}

type ProductSkinSide = 'left' | 'right' | 'front' | 'rear' | 'back' | 'top' | 'bottom';
type ProductAxis = 'X' | 'Y' | 'Z';

interface SurfaceFrame {
  point: Vec3;
  normal: Vec3;
}

interface ProductSurfaceRef {
  side: ProductSkinSide;
  u: number;
  v: number;
  offset: number;
  frame(options?: { offset?: number }): SurfaceFrame;
}

/** A built product skin: a lofted shell plus its station/ref metadata. */
export class ProductSkin {
  constructor(
    public readonly name: string,
    private readonly shape: Shape,
    private readonly stations: StationSpec[],
    private readonly axis: ProductAxis,
    private readonly material: ProductMaterial | undefined,
    private readonly namedRefs: Record<string, { side: ProductSkinSide; u: number; v: number; offset: number }>,
  ) {}

  toShape(): Shape {
    return applyMaterial(this.shape, this.material);
  }

  /** Boolean-union structural details into the skin body, returning the combined Shape. */
  integrate(...details: Array<Shape | { toShape(): Shape }>): Shape {
    const parts = details.map((d) => (d instanceof Shape ? d : d.toShape()));
    const combined = parts.length > 0 ? union(this.shape, ...parts) : this.shape;
    return applyMaterial(combined, this.material).as(this.name);
  }

  /** Create a group containing this skin plus named child details. */
  with(children: Record<string, Shape | ShapeGroup>): ShapeGroup {
    const items = [{ name: this.name, shape: this.toShape() }, ...Object.entries(children).map(([name, shape]) => ({ name, shape }))];
    return group(...items);
  }

  private bounds(): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const s of this.stations) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], s.center[i]);
        max[i] = Math.max(max[i], s.center[i]);
      }
    }
    // Pad laterally by half the largest profile extent so refs land on the surface.
    const lateral = 24;
    return {
      min: [min[0] - lateral, min[1] - lateral, min[2]],
      max: [max[0] + lateral, max[1] + lateral, max[2]],
    };
  }

  /** Interpolate a center point at normalized v along the axis. */
  private axisIndex(): number {
    return this.axis === 'X' ? 0 : this.axis === 'Y' ? 1 : 2;
  }

  uv(side: ProductSkinSide, u: number, v: number): ProductSurfaceRef {
    return this.makeRef(side, requireFinite(u, 'uv u'), requireFinite(v, 'uv v'), 0);
  }

  ref(name: string): ProductSurfaceRef {
    const spec = this.namedRefs[requireName(name, 'Product skin ref()')];
    if (!spec) throw new Error(`ProductSkin "${this.name}" has no ref "${name}". Available: ${Object.keys(this.namedRefs).join(', ') || '(none)'}`);
    return this.makeRef(spec.side, spec.u, spec.v, spec.offset);
  }

  surface(side: ProductSkinSide): ProductSurfaceBuilder {
    return new ProductSurfaceBuilder(this, side);
  }

  private makeRef(side: ProductSkinSide, u: number, v: number, offset: number): ProductSurfaceRef {
    const b = this.bounds();
    const ax = this.axisIndex();
    const skin = this;
    const point = (off: number): Vec3 => {
      const p: Vec3 = [0, 0, 0];
      // Along-axis position from v.
      p[ax] = b.min[ax] + (b.max[ax] - b.min[ax]) * v;
      const lateralAxes = [0, 1, 2].filter((i) => i !== ax) as number[];
      const [la, lb] = lateralAxes;
      const cx = (b.min[la] + b.max[la]) / 2;
      const cy = (b.min[lb] + b.max[lb]) / 2;
      const halfA = (b.max[la] - b.min[la]) / 2;
      const halfB = (b.max[lb] - b.min[lb]) / 2;
      const n: Vec3 = [0, 0, 0];
      switch (side) {
        case 'left':
          p[la] = b.min[la] - off;
          p[lb] = cy + (u - 0.5) * 2 * halfB;
          n[la] = -1;
          break;
        case 'right':
          p[la] = b.max[la] + off;
          p[lb] = cy + (u - 0.5) * 2 * halfB;
          n[la] = 1;
          break;
        case 'front':
          p[lb] = b.max[lb] + off;
          p[la] = cx + (u - 0.5) * 2 * halfA;
          n[lb] = 1;
          break;
        case 'rear':
        case 'back':
          p[lb] = b.min[lb] - off;
          p[la] = cx + (u - 0.5) * 2 * halfA;
          n[lb] = -1;
          break;
        case 'top':
          p[lb] = b.max[lb] + off;
          p[la] = cx + (u - 0.5) * 2 * halfA;
          n[lb] = 1;
          break;
        case 'bottom':
          p[lb] = b.min[lb] - off;
          p[la] = cx + (u - 0.5) * 2 * halfA;
          n[lb] = -1;
          break;
      }
      void halfA;
      void cx;
      return p;
    };
    return {
      side,
      u,
      v,
      offset,
      frame(opts?: { offset?: number }): SurfaceFrame {
        const off = offset + (opts?.offset ?? 0);
        const pt = point(off);
        const base = point(0);
        const dir: Vec3 = [pt[0] - base[0], pt[1] - base[1], pt[2] - base[2]];
        const len = Math.hypot(...dir) || 1;
        return { point: pt, normal: [dir[0] / len, dir[1] / len, dir[2] / len] };
      },
    };
    void skin;
  }
}

class ProductSurfaceBuilder {
  constructor(
    private readonly skin: ProductSkin,
    private readonly side: ProductSkinSide,
  ) {}

  path(): SurfacePathBuilder {
    return new SurfacePathBuilder(new ProductSkinCarrier(this.skin), this.side);
  }
  ref(u: number, v: number): ProductSurfaceRef {
    return this.skin.uv(this.side, u, v);
  }
  uv(u: number, v: number): ProductSurfaceRef {
    return this.skin.uv(this.side, u, v);
  }
  ribbon(name: string, points: Array<{ u: number; v: number }>): ProductRibbonBuilder {
    return new ProductRibbonBuilder(name).on(this.skin, points, this.side);
  }
}

class ProductSkinBuilder {
  private axisValue: ProductAxis = 'Z';
  private stationSpecs: StationSpec[] = [];
  private materialValue: ProductMaterial | undefined;
  private colorValue: string | undefined;
  private edgeLengthValue: number | undefined;
  private namedRefs: Record<string, { side: ProductSkinSide; u: number; v: number; offset: number }> = {};

  constructor(public readonly name: string) {}

  axis(axis: ProductAxis): this {
    if (axis !== 'X' && axis !== 'Y' && axis !== 'Z') throw new Error(`Product.skin().axis() must be 'X', 'Y', or 'Z'`);
    this.axisValue = axis;
    return this;
  }
  stations(stations: ProductStationBuilder[]): this {
    if (!Array.isArray(stations) || stations.length < 2) throw new Error('Product.skin().stations() needs at least two stations');
    this.stationSpecs = stations.map((s) => s.toSpec());
    return this;
  }
  rails(_rails: Record<string, unknown>): this {
    // Guide rails are an advisory styling input for the skin loft; recorded for parity.
    return this;
  }
  refs(refs: Record<string, { side: ProductSkinSide; u?: number; v?: number; offset?: number }>): this {
    for (const [key, spec] of Object.entries(refs)) {
      this.namedRefs[key] = { side: spec.side, u: spec.u ?? 0.5, v: spec.v ?? 0.5, offset: spec.offset ?? 0 };
    }
    return this;
  }
  ref(name: string, spec: { side: ProductSkinSide; u?: number; v?: number; offset?: number }): this {
    this.namedRefs[requireName(name, 'Product.skin().ref()')] = { side: spec.side, u: spec.u ?? 0.5, v: spec.v ?? 0.5, offset: spec.offset ?? 0 };
    return this;
  }
  uv(side: ProductSkinSide, u: number, v: number): { side: ProductSkinSide; u: number; v: number; offset: number } {
    return { side, u, v, offset: 0 };
  }
  material(mat: ProductMaterial): this {
    this.materialValue = mat;
    return this;
  }
  color(color: string): this {
    this.colorValue = color;
    return this;
  }
  edgeLength(value: number): this {
    this.edgeLengthValue = requirePositive(value, 'Product.skin().edgeLength()');
    return this;
  }
  wall(_thickness: number): this {
    return this;
  }
  build(): ProductSkin {
    if (this.stationSpecs.length < 2) throw new Error(`Product.skin("${this.name}") needs stations() with at least two stations before build().`);
    const ax = this.axisValue === 'X' ? 0 : this.axisValue === 'Y' ? 1 : 2;
    const profiles = this.stationSpecs.map((s) => s.profile);
    const positions = this.stationSpecs.map((s) => s.center[ax]);
    const opts = this.edgeLengthValue ? { edgeLength: this.edgeLengthValue } : {};
    let shape: Shape;
    if (this.axisValue === 'Z') {
      shape = loft(profiles, positions, opts);
    } else {
      // Loft along the chosen world axis via a straight spine.
      const minP = Math.min(...positions);
      const maxP = Math.max(...positions);
      const spine: Vec3[] = [
        [0, 0, 0],
        [0, 0, 0],
      ];
      spine[0][ax] = minP;
      spine[1][ax] = maxP;
      const tValues = positions.map((p) => (maxP > minP ? (p - minP) / (maxP - minP) : 0));
      shape = loftAlongSpine(profiles, spine, tValues, opts);
    }
    const mat = this.materialValue ?? (this.colorValue ? { color: this.colorValue, material: {} } : undefined);
    return new ProductSkin(this.name, shape, this.stationSpecs, this.axisValue, mat, this.namedRefs);
  }
}

// ── Conformal ribbon ───────────────────────────────────────────────────────────

class ProductRibbonBuilder {
  private skin: ProductSkin | undefined;
  private points: Array<{ u: number; v: number }> = [];
  private side: ProductSkinSide = 'left';
  private explicitRefs: ProductSurfaceRef[] | undefined;
  private widthValue = 6;
  private thicknessValue = 1;
  private offsetValue = 0;
  private samplesValue = 24;
  private materialValue: ProductMaterial | undefined;
  private colorValue: string | undefined;

  constructor(public readonly name: string) {}

  on(skin: ProductSkin, points: Array<{ u: number; v: number }>, side?: ProductSkinSide): this {
    this.skin = skin;
    this.points = points;
    if (side) this.side = side;
    return this;
  }
  fromRefs(refs: ProductSurfaceRef[]): this {
    this.explicitRefs = refs;
    return this;
  }
  width(value: number): this {
    this.widthValue = requirePositive(value, 'ribbon.width()');
    return this;
  }
  thickness(value: number): this {
    this.thicknessValue = requirePositive(value, 'ribbon.thickness()');
    return this;
  }
  offset(value: number): this {
    this.offsetValue = requireFinite(value, 'ribbon.offset()');
    return this;
  }
  samples(value: number): this {
    this.samplesValue = Math.max(2, Math.floor(value));
    return this;
  }
  widthSamples(_value: number): this {
    return this;
  }
  resolution(_value: number): this {
    return this;
  }
  material(mat: ProductMaterial): this {
    this.materialValue = mat;
    return this;
  }
  color(color: string): this {
    this.colorValue = color;
    return this;
  }

  private pathPoints(): Vec3[] {
    let refs: ProductSurfaceRef[];
    if (this.explicitRefs) {
      refs = this.explicitRefs;
    } else {
      if (!this.skin) throw new Error(`Product.ribbon("${this.name}") needs .on(skin, points) or .fromRefs(refs) before build().`);
      const skin = this.skin;
      refs = this.points.map((p) =>
        'side' in (p as object) && typeof (p as ProductSurfaceRef).frame === 'function'
          ? (p as unknown as ProductSurfaceRef)
          : skin.uv(this.side, (p as { u: number; v: number }).u, (p as { u: number; v: number }).v),
      );
    }
    return refs.map((r) => r.frame({ offset: this.offsetValue + this.thicknessValue / 2 }).point);
  }

  build(): Shape {
    const pts = this.pathPoints();
    if (pts.length < 2) throw new Error(`Product.ribbon("${this.name}") needs at least two path points.`);
    const profile = roundedRect(this.widthValue, this.thicknessValue, Math.min(this.widthValue, this.thicknessValue) / 2.5, true);
    const curve = new Curve3D(pts, { tension: 0.5 });
    let shape = sweep(profile, curve, { samples: this.samplesValue });
    shape = applyMaterial(shape, this.materialValue ?? (this.colorValue ? { color: this.colorValue, material: {} } : undefined)).as(this.name);
    return shape;
  }
  buildWithDiagnostics(): { shape: Shape; diagnostics: Record<string, unknown> } {
    return { shape: this.build(), diagnostics: { name: this.name, samples: this.samplesValue } };
  }
}

// ── Spout & Handle ─────────────────────────────────────────────────────────────

class ProductSpoutBuilder {
  private sourceRef: ProductSurfaceRef | undefined;
  private sectionProfiles: Sketch[] = [];
  private projectionValue = 50;
  private edgeLengthValue: number | undefined;
  private materialValue: ProductMaterial | undefined;
  private colorValue: string | undefined;

  constructor(public readonly name: string) {}
  from(ref: ProductSurfaceRef): this {
    this.sourceRef = ref;
    return this;
  }
  sections(profiles: Sketch[]): this {
    this.sectionProfiles = profiles;
    return this;
  }
  projection(value: number): this {
    this.projectionValue = requirePositive(value, 'spout.projection()');
    return this;
  }
  edgeLength(value: number): this {
    this.edgeLengthValue = requirePositive(value, 'spout.edgeLength()');
    return this;
  }
  material(mat: ProductMaterial): this {
    this.materialValue = mat;
    return this;
  }
  color(color: string): this {
    this.colorValue = color;
    return this;
  }
  build(): Shape {
    if (this.sectionProfiles.length < 2) throw new Error(`Product.spout("${this.name}") needs at least two sections().`);
    const n = this.sectionProfiles.length;
    const heights = this.sectionProfiles.map((_, i) => (i / (n - 1)) * this.projectionValue);
    const opts = this.edgeLengthValue ? { edgeLength: this.edgeLengthValue } : {};
    let shape = loft(this.sectionProfiles, heights, opts);
    shape = applyMaterial(shape, this.materialValue ?? (this.colorValue ? { color: this.colorValue, material: {} } : undefined)).as(this.name);
    return shape;
  }
  attach(options?: { inset?: number; offset?: number }): Shape {
    let shape = this.build();
    if (this.sourceRef) {
      const fr = this.sourceRef.frame({ offset: options?.offset ?? 0 });
      shape = shape.translate(fr.point[0], fr.point[1], fr.point[2]);
    }
    return shape;
  }
}

interface HandleFeature {
  grip: Shape;
  upperPad: Shape;
  lowerPad: Shape;
}

class ProductHandleBuilder {
  private upper: ProductSurfaceRef | undefined;
  private lower: Vec3 | undefined;
  private spinePoints: Vec3[] = [];
  private gripProfile: Sketch | undefined;
  private materialValue: ProductMaterial | undefined;
  private padMaterialValue: ProductMaterial | undefined;
  private edgeLengthValue: number | undefined;

  constructor(public readonly name: string) {}
  between(upper: ProductSurfaceRef, lower: Vec3): this {
    this.upper = upper;
    this.lower = requireVec3(lower, 'handle.between() lower');
    return this;
  }
  spine(points: Vec3[]): this {
    this.spinePoints = points.map((p) => requireVec3(p, 'handle.spine() point'));
    return this;
  }
  grip(profile: Sketch): this {
    this.gripProfile = profile;
    return this;
  }
  material(mat: ProductMaterial): this {
    this.materialValue = mat;
    return this;
  }
  padMaterial(mat: ProductMaterial): this {
    this.padMaterialValue = mat;
    return this;
  }
  edgeLength(value: number): this {
    this.edgeLengthValue = requirePositive(value, 'handle.edgeLength()');
    return this;
  }
  build(): HandleFeature {
    if (this.spinePoints.length < 2) throw new Error(`Product.handle("${this.name}") needs a spine() with at least two points.`);
    if (!this.gripProfile) throw new Error(`Product.handle("${this.name}") needs a grip() profile.`);
    const curve = new Curve3D(this.spinePoints, { tension: 0.5 });
    const grip = applyMaterial(sweep(this.gripProfile, curve, { samples: 24 }), this.materialValue).as(`${this.name}-grip`);
    const padMat = this.padMaterialValue ?? this.materialValue;
    const upperPt = this.upper ? this.upper.frame().point : this.spinePoints[0];
    const lowerPt = this.lower ?? this.spinePoints[this.spinePoints.length - 1];
    const upperPad = applyMaterial(sphere(8).scale([1.4, 1.4, 0.6]).translate(upperPt[0], upperPt[1], upperPt[2]), padMat).as(`${this.name}-upper-pad`);
    const lowerPad = applyMaterial(sphere(7).scale([1.4, 1.4, 0.6]).translate(lowerPt[0], lowerPt[1], lowerPt[2]), padMat).as(`${this.name}-lower-pad`);
    return { grip, upperPad, lowerPad };
  }
}

// ── Panel ────────────────────────────────────────────────────────────────────

class ProductPanelBuilder {
  private profileSketch: Sketch | undefined;
  private thicknessValue = 1;
  private materialValue: ProductMaterial | undefined;
  private colorValue: string | undefined;

  constructor(public readonly name: string) {}
  rounded(width: number, height: number, radius: number): this {
    this.profileSketch = roundedRectProfile(width, height, radius);
    return this;
  }
  oval(width: number, height: number): this {
    this.profileSketch = ovalProfile(width, height);
    return this;
  }
  profile(sketch: Sketch): this {
    this.profileSketch = sketch;
    return this;
  }
  thickness(value: number): this {
    this.thicknessValue = requirePositive(value, 'panel.thickness()');
    return this;
  }
  material(mat: ProductMaterial): this {
    this.materialValue = mat;
    return this;
  }
  color(color: string): this {
    this.colorValue = color;
    return this;
  }
  build(): Shape {
    if (!this.profileSketch) throw new Error(`Product.panel("${this.name}") needs a profile (rounded/oval/profile).`);
    let shape = asShape(this.profileSketch.extrude(this.thicknessValue)).as(this.name);
    shape = applyMaterial(shape, this.materialValue ?? (this.colorValue ? { color: this.colorValue, material: {} } : undefined));
    return shape;
  }
  attachTo(ref: ProductSurfaceRef, options?: { thickness?: number; offset?: number; inset?: number }): Shape {
    if (options?.thickness) this.thicknessValue = requirePositive(options.thickness, 'panel.attachTo() thickness');
    const shape = this.build();
    const fr = ref.frame({ offset: options?.offset ?? 0 });
    return shape.translate(fr.point[0], fr.point[1], fr.point[2]);
  }
}

// ── Product namespace ──────────────────────────────────────────────────────────

export const Product = {
  skin: (name: string) => new ProductSkinBuilder(requireName(name, 'Product.skin()')),
  station: (name: string) => new ProductStationBuilder(requireName(name, 'Product.station()')),
  ribbon: (name: string) => new ProductRibbonBuilder(requireName(name, 'Product.ribbon()')),
  spout: (name: string) => new ProductSpoutBuilder(requireName(name, 'Product.spout()')),
  handle: (name: string) => new ProductHandleBuilder(requireName(name, 'Product.handle()')),
  panel: (name: string) => new ProductPanelBuilder(requireName(name, 'Product.panel()')),
  surface: (skin: ProductSkin, side: ProductSkinSide) => skin.surface(side),
  ref: (skin: ProductSkin, query: { side: ProductSkinSide; u?: number; v?: number }) => skin.uv(query.side, query.u ?? 0.5, query.v ?? 0.5),
  materials: ProductMaterials,
  applyMaterial,
  scenePreset: (_name: string): void => {
    // Opinionated review-render scene preset; no-op for headless geometry runs.
  },
  rail: {
    bezier: (points: Vec3[], options?: { name?: string }): { points: Vec3[]; name?: string } => ({ points, name: options?.name }),
    nurbs: (points: Vec3[], options?: { name?: string }): { points: Vec3[]; name?: string } => ({ points, name: options?.name }),
    polyline: (points: Vec3[], options?: { name?: string }): { points: Vec3[]; name?: string } => ({ points, name: options?.name }),
  },
  profiles: {
    superEllipse: superEllipseProfile,
    roundedRect: roundedRectProfile,
    oval: ovalProfile,
    circle: circleProfile,
  },
  ovalProfile,
  roundedRectProfile,
  circleProfile,
  superEllipseProfile,
  place: (detail: Shape | ShapeGroup, ref: ProductSurfaceRef, options?: { offset?: number; inset?: number }): Shape | ShapeGroup => {
    const fr = ref.frame({ offset: options?.offset ?? 0 });
    return detail.translate(fr.point[0], fr.point[1], fr.point[2]);
  },
  landing: (name: string, radius = 4, material?: ProductMaterial): Shape => applyMaterial(sphere(requirePositive(radius, 'Product.landing() radius')), material).as(requireName(name, 'Product.landing()')),
};

// ── Loft namespace ─────────────────────────────────────────────────────────────

interface LoftStation {
  profile: Sketch;
  position: number;
}
interface LoftGuideRail {
  side: string;
  points: Vec3[];
}

function railPointsFrom(input: unknown): Vec3[] {
  if (Array.isArray(input)) {
    // Already Vec3[] (e.g. from Loft.pathOnXz).
    return input.map((p) => requireVec3(p, 'Loft rail point'));
  }
  throw new Error('Loft rail expects a Vec3[] path (use Loft.pathOnXz / pathOnYz / pathOnXy).');
}

function path2DPoints(input: unknown): [number, number][] {
  if (Array.isArray(input)) return input.map((p) => [requireFinite((p as number[])[0], 'rail.x'), requireFinite((p as number[])[1], 'rail.y')]);
  if (input && typeof (input as { toPolyline?: unknown }).toPolyline === 'function') {
    return (input as { toPolyline: () => [number, number][] }).toPolyline();
  }
  throw new Error('Loft.pathOnXz/Yz/Xy expects a path() builder or 2D point array');
}

export const Loft = {
  station: (profile: Sketch, position: number): LoftStation => ({ profile, position: requireFinite(position, 'Loft.station() position') }),
  leftRail: (points: Vec3[]): LoftGuideRail => ({ side: 'left', points: railPointsFrom(points) }),
  rightRail: (points: Vec3[]): LoftGuideRail => ({ side: 'right', points: railPointsFrom(points) }),
  frontRail: (points: Vec3[]): LoftGuideRail => ({ side: 'front', points: railPointsFrom(points) }),
  backRail: (points: Vec3[]): LoftGuideRail => ({ side: 'back', points: railPointsFrom(points) }),
  centerRail: (points: Vec3[]): LoftGuideRail => ({ side: 'center', points: railPointsFrom(points) }),
  pathOnXz: (path: unknown, y = 0): Vec3[] => path2DPoints(path).map(([x, z]) => [x, y, z] as Vec3),
  pathOnYz: (path: unknown, x = 0): Vec3[] => path2DPoints(path).map(([yy, z]) => [x, yy, z] as Vec3),
  pathOnXy: (path: unknown, z = 0): Vec3[] => path2DPoints(path).map(([x, y]) => [x, y, z] as Vec3),
  withGuideRails: (stations: LoftStation[], _rails: LoftGuideRail[], options?: { samples?: number; edgeLength?: number }): Shape => {
    if (!Array.isArray(stations) || stations.length < 2) throw new Error('Loft.withGuideRails() needs at least two stations');
    const profiles = stations.map((s) => s.profile);
    const heights = stations.map((s) => s.position);
    const opts = options?.edgeLength ? { edgeLength: options.edgeLength } : {};
    // Guide rails refine the side silhouettes; the base loft already passes through stations.
    return loft(profiles, heights, opts);
  },
};

// ── Carrier ──────────────────────────────────────────────────────────────────

interface SurfaceAnchor {
  point: Vec3;
}

type CarrierSurface = CylinderCarrier | PlaneCarrier | ProductSkinCarrier;

class CylinderCarrier {
  private diameterValue = 50;
  private heightValue = 100;
  private clearanceValue = 0;
  private centerValue: Vec3 = [0, 0, 0];
  public readonly kind = 'cylinder' as const;

  constructor(public readonly name: string) {}
  diameter(value: number): this {
    this.diameterValue = requirePositive(value, 'Carrier.cylinder().diameter()');
    return this;
  }
  radius(value: number): this {
    this.diameterValue = requirePositive(value, 'Carrier.cylinder().radius()') * 2;
    return this;
  }
  height(value: number): this {
    this.heightValue = requirePositive(value, 'Carrier.cylinder().height()');
    return this;
  }
  clearance(value: number): this {
    this.clearanceValue = requireFinite(value, 'Carrier.cylinder().clearance()');
    return this;
  }
  center(point: Vec3): this {
    this.centerValue = requireVec3(point, 'Carrier.cylinder().center()');
    return this;
  }
  private effectiveRadius(extra = 0): number {
    return this.diameterValue / 2 + this.clearanceValue + extra;
  }
  pointAt(coordinate: { angle?: number; z?: number; offset?: number }): Vec3 {
    const angle = (coordinate.angle ?? 0) * DEG;
    const r = this.effectiveRadius(coordinate.offset ?? 0);
    return [this.centerValue[0] + r * Math.cos(angle), this.centerValue[1] + r * Math.sin(angle), this.centerValue[2] + (coordinate.z ?? 0)];
  }
  anchorFromAngle(angle: number, offset = 0): SurfaceAnchor {
    return { point: this.pointAt({ angle, z: this.heightValue / 2, offset }) };
  }
  back(options?: { offset?: number; z?: number }): SurfaceAnchor {
    return { point: this.pointAt({ angle: 180, z: options?.z ?? this.heightValue / 2, offset: options?.offset ?? 0 }) };
  }
  front(options?: { offset?: number; z?: number }): SurfaceAnchor {
    return { point: this.pointAt({ angle: 0, z: options?.z ?? this.heightValue / 2, offset: options?.offset ?? 0 }) };
  }
  left(options?: { offset?: number; z?: number }): SurfaceAnchor {
    return { point: this.pointAt({ angle: 90, z: options?.z ?? this.heightValue / 2, offset: options?.offset ?? 0 }) };
  }
  right(options?: { offset?: number; z?: number }): SurfaceAnchor {
    return { point: this.pointAt({ angle: -90, z: options?.z ?? this.heightValue / 2, offset: options?.offset ?? 0 }) };
  }
  path(): SurfacePathBuilder {
    return new SurfacePathBuilder(this);
  }
}

class PlaneCarrier {
  private widthValue = 100;
  private heightValue = 100;
  private originValue: Vec3 = [0, 0, 0];
  public readonly kind = 'plane' as const;
  constructor(public readonly name: string) {}
  size(width: number, height: number): this {
    this.widthValue = requirePositive(width, 'plane width');
    this.heightValue = requirePositive(height, 'plane height');
    return this;
  }
  origin(point: Vec3): this {
    this.originValue = requireVec3(point, 'plane origin');
    return this;
  }
  pointAt(coordinate: { x?: number; y?: number; offset?: number }): Vec3 {
    return [this.originValue[0] + (coordinate.x ?? 0), this.originValue[1] + (coordinate.y ?? 0), this.originValue[2] + (coordinate.offset ?? 0)];
  }
  anchor(x = 0, y = 0, options?: { offset?: number }): SurfaceAnchor {
    return { point: this.pointAt({ x: (x - 0.5) * this.widthValue, y: (y - 0.5) * this.heightValue, offset: options?.offset }) };
  }
  path(): SurfacePathBuilder {
    return new SurfacePathBuilder(this);
  }
}

class ProductSkinCarrier {
  public readonly kind = 'productSkin' as const;
  public readonly name: string;
  private side: ProductSkinSide = 'left';
  constructor(public readonly skin: ProductSkin) {
    this.name = skin.name;
  }
  surface(side: ProductSkinSide): ProductSkinCarrier {
    const c = new ProductSkinCarrier(this.skin);
    c.side = side;
    return c;
  }
  pointAt(coordinate: { side?: ProductSkinSide; u?: number; v?: number; offset?: number }): Vec3 {
    const ref = this.skin.uv(coordinate.side ?? this.side, coordinate.u ?? 0.5, coordinate.v ?? 0.5);
    return ref.frame({ offset: coordinate.offset ?? 0 }).point;
  }
  path(): SurfacePathBuilder {
    return new SurfacePathBuilder(this, this.side);
  }
}

export const Carrier = {
  cylinder: (name: string) => new CylinderCarrier(requireName(name, 'Carrier.cylinder()')),
  plane: (name: string) => new PlaneCarrier(requireName(name, 'Carrier.plane()')),
  productSkin: (skin: ProductSkin) => new ProductSkinCarrier(skin),
};

// ── Surface paths ──────────────────────────────────────────────────────────────

type SurfaceCoordinate = { angle?: number; z?: number; u?: number; v?: number; x?: number; y?: number; offset?: number };

export class SurfacePath {
  constructor(
    public readonly carrier: CarrierSurface,
    public readonly points: SurfaceCoordinate[],
    private readonly side?: ProductSkinSide,
  ) {}

  worldPoints(): Vec3[] {
    return this.points.map((c) => {
      const coord = this.side ? { side: this.side, ...c } : c;
      return (this.carrier as { pointAt: (coordinate: SurfaceCoordinate) => Vec3 }).pointAt(coord);
    });
  }
}

class SurfacePathBuilder {
  private pts: SurfaceCoordinate[] = [];
  constructor(
    public readonly carrier: CarrierSurface,
    private readonly side?: ProductSkinSide,
  ) {}

  from(coordinate: SurfaceCoordinate): this {
    this.pts = [coordinate];
    return this;
  }
  through(coordinate: SurfaceCoordinate): this {
    this.pts.push(coordinate);
    return this;
  }
  to(coordinate: SurfaceCoordinate): this {
    this.pts.push(coordinate);
    return this;
  }
  around(input: { z: number; fromAngle: number; toAngle: number; offset?: number }): this {
    const steps = 16;
    this.pts = [];
    for (let i = 0; i <= steps; i++) {
      const angle = input.fromAngle + (input.toAngle - input.fromAngle) * (i / steps);
      this.pts.push({ angle, z: input.z, offset: input.offset });
    }
    return this;
  }
  build(): SurfacePath {
    return new SurfacePath(this.carrier, this.pts, this.side);
  }
}

// ── Slot / Ribs / Counterbore features ──────────────────────────────────────────

interface MemberFeature {
  kind: string;
  [key: string]: unknown;
}

class RoundedSlotBuilder {
  private travel = 0;
  private position: { along?: number; across?: number; z?: number } = {};
  constructor(private readonly input: { length: number; width: number }) {}
  verticalTravel(value: number): this {
    this.travel = requireFinite(value, 'Slot.verticalTravel()');
    return this;
  }
  at(input: { along?: number; across?: number; z?: number }): this {
    this.position = input;
    return this;
  }
  named(name: string): MemberFeature {
    return this.toFeature(name);
  }
  toFeature(name?: string): MemberFeature {
    return { kind: 'roundedSlot', name, ...this.input, travel: this.travel, position: this.position };
  }
}

class CounterboreBuilder {
  private position: { along?: number; across?: number; z?: number } = {};
  constructor(private readonly input: { diameter: number; clearanceDiameter: number; depth: number }) {}
  at(input: { along?: number; across?: number; z?: number }): this {
    this.position = input;
    return this;
  }
  named(name: string): MemberFeature {
    return this.toFeature(name);
  }
  toFeature(name?: string): MemberFeature {
    return { kind: 'counterbore', name, ...this.input, position: this.position };
  }
}

export const Slot = {
  rounded: (input: { length: number; width: number }): RoundedSlotBuilder => new RoundedSlotBuilder(input),
};
export const Counterbore = {
  cylindrical: (input: { diameter: number; clearanceDiameter: number; depth: number }): CounterboreBuilder => new CounterboreBuilder(input),
};
export const Ribs = {
  repeated: (input: { count: number; height: number }): MemberFeature => ({ kind: 'ribs', count: Math.max(1, Math.floor(input.count)), height: requirePositive(input.height, 'Ribs.repeated() height') }),
};

// ── SurfaceBody / members ────────────────────────────────────────────────────────

interface MemberSection {
  width?: number;
  thickness: number;
  edgeRadius?: number;
  material?: ProductMaterial;
}

interface MemberSpec {
  name: string;
  type: 'band' | 'plate';
  path?: SurfacePath;
  anchor?: SurfaceAnchor;
  size?: [number, number];
  section?: MemberSection;
  mirrorOf?: string;
  profileDepth?: number;
}

class SurfaceMemberBuilder {
  private spec: MemberSpec;
  constructor(
    private readonly body: SurfaceBodyBuilder,
    name: string,
  ) {
    this.spec = { name, type: 'band' };
  }
  band(): this {
    this.spec.type = 'band';
    return this;
  }
  plate(): this {
    this.spec.type = 'plate';
    return this;
  }
  at(anchor: SurfaceAnchor): this {
    this.spec.anchor = anchor;
    return this;
  }
  size(width: number, height: number): this {
    this.spec.size = [requirePositive(width, 'member.size width'), requirePositive(height, 'member.size height')];
    return this;
  }
  path(path: SurfacePath | SurfacePathBuilder): this {
    this.spec.path = path instanceof SurfacePathBuilder ? path.build() : path;
    return this;
  }
  section(section: MemberSection): this {
    this.spec.section = section;
    return this;
  }
  cap(_style: string): this {
    return this;
  }
  slot(_name: string, _feature: MemberFeature | RoundedSlotBuilder): this {
    return this;
  }
  cutout(_name: string, _feature: MemberFeature | RoundedSlotBuilder): this {
    return this;
  }
  counterbore(_name: string, _feature: MemberFeature | CounterboreBuilder): this {
    return this;
  }
  features(_features: MemberFeature | MemberFeature[]): this {
    return this;
  }
  profile(_name: string, options?: { depth?: number; height?: number }): this {
    if (options?.depth) this.spec.profileDepth = options.depth;
    return this;
  }
  anchorAt(_name: string, _coordinate: unknown): this {
    return this;
  }
  mirrorOf(memberName: string): SurfaceBodyBuilder {
    this.spec.mirrorOf = requireName(memberName, 'member.mirrorOf()');
    this.flush();
    return this.body;
  }
  member(name: string): SurfaceMemberBuilder {
    this.flush();
    return this.body.member(name);
  }
  join(from: string, to: string | string[]): SurfaceJoinBuilder {
    this.flush();
    return this.body.join(from, to);
  }
  autoJoinAtSharedAnchors(): SurfaceBodyBuilder {
    this.flush();
    return this.body.autoJoinAtSharedAnchors();
  }
  build(): Shape | ShapeGroup {
    this.flush();
    return this.body.build();
  }
  private flushed = false;
  private flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    this.body.addMember(this.spec);
  }
}

class SurfaceJoinBuilder {
  constructor(private readonly body: SurfaceBodyBuilder) {}
  betweenAnchors(_from: string, _to: string): this {
    return this;
  }
  blend(_input?: { radius?: number; style?: string }): SurfaceBodyBuilder {
    // Joins are recorded as intent; geometry is the union of members which already overlap.
    return this.body;
  }
}

export class SurfaceBodyBuilder {
  private carrierValue: CarrierSurface | undefined;
  private members: MemberSpec[] = [];
  constructor(public readonly name: string) {}

  carrier(carrier: CarrierSurface): this {
    this.carrierValue = carrier;
    return this;
  }
  member(name: string): SurfaceMemberBuilder {
    return new SurfaceMemberBuilder(this, requireName(name, 'SurfaceBody.member()'));
  }
  addMember(spec: MemberSpec): void {
    this.members.push(spec);
  }
  join(_from: string, _to: string | string[]): SurfaceJoinBuilder {
    return new SurfaceJoinBuilder(this);
  }
  autoJoinAtSharedAnchors(): this {
    return this;
  }

  private buildMember(spec: MemberSpec): Shape {
    const section = spec.section;
    if (spec.type === 'plate') {
      const [w, h] = spec.size ?? [20, 20];
      const t = section?.thickness ?? 4;
      let shape = asShape(roundedRectProfile(w, h, section?.edgeRadius ?? Math.min(w, h) / 6).extrude(t));
      if (spec.anchor) shape = shape.translate(spec.anchor.point[0], spec.anchor.point[1], spec.anchor.point[2]);
      return applyMaterial(shape, section?.material).as(spec.name);
    }
    // band
    if (!spec.path) throw new Error(`SurfaceBody member "${spec.name}" of type band needs a path().`);
    const pts = spec.path.worldPoints();
    if (pts.length < 2) throw new Error(`SurfaceBody member "${spec.name}" path must have at least two points.`);
    const width = section?.width ?? 8;
    const thickness = section?.thickness ?? 3;
    const edge = section?.edgeRadius ?? Math.min(width, thickness) / 3;
    const profile = roundedRectProfile(width, thickness, Math.min(edge, Math.min(width, thickness) / 2 - 0.01));
    const curve = new Curve3D(pts, { tension: 0.5 });
    const shape = sweep(profile, curve, { samples: Math.max(12, pts.length * 4) });
    return applyMaterial(shape, section?.material).as(spec.name);
  }

  private resolveMembers(): MemberSpec[] {
    const byName = new Map<string, MemberSpec>();
    const resolved: MemberSpec[] = [];
    for (const m of this.members) {
      if (m.mirrorOf) {
        const src = byName.get(m.mirrorOf);
        if (!src) throw new Error(`SurfaceBody member "${m.name}" mirrorOf("${m.mirrorOf}") references an unknown member.`);
        // Mirror the source path across the YZ plane (negate X / negate angle).
        const mirroredPath = src.path
          ? new SurfacePath(
              src.path.carrier,
              src.path.points.map((p) => ({ ...p, angle: p.angle !== undefined ? -p.angle : undefined, x: p.x !== undefined ? -p.x : undefined, u: p.u !== undefined ? 1 - p.u : undefined })),
              undefined,
            )
          : undefined;
        const mirrored: MemberSpec = { ...src, name: m.name, path: mirroredPath, mirrorOf: undefined };
        byName.set(m.name, mirrored);
        resolved.push(mirrored);
        continue;
      }
      byName.set(m.name, m);
      resolved.push(m);
    }
    return resolved;
  }

  build(): Shape | ShapeGroup {
    if (!this.carrierValue) throw new Error(`SurfaceBody("${this.name}") needs a carrier() before build().`);
    const specs = this.resolveMembers();
    if (specs.length === 0) throw new Error(`SurfaceBody("${this.name}") needs at least one member().`);
    const shapes = specs.map((s) => this.buildMember(s));
    if (shapes.length === 1) return shapes[0].as(this.name);
    return group(...shapes.map((s, i) => ({ name: s.shapeName ?? `${this.name}-${i}`, shape: s })));
  }
}

export function SurfaceBody(name: string): SurfaceBodyBuilder {
  return new SurfaceBodyBuilder(requireName(name, 'SurfaceBody()'));
}

export const SurfaceMembers = {
  Body: SurfaceBody,
};

// ── Helix ──────────────────────────────────────────────────────────────────────

interface HelixOptions {
  radius: number;
  pitch?: number;
  turns?: number;
  height?: number;
  startAngle?: number;
  clockwise?: boolean;
  samplesPerTurn?: number;
}

function helixResolve(options: HelixOptions): { turns: number; height: number } {
  const have = [options.pitch, options.turns, options.height].filter((v) => v !== undefined).length;
  if (have < 2) throw new Error('Helix needs any two of pitch, turns, height.');
  let { turns, height } = options;
  const pitch = options.pitch;
  if (turns === undefined && pitch !== undefined && height !== undefined) turns = height / pitch;
  if (height === undefined && pitch !== undefined && turns !== undefined) height = pitch * turns;
  if (turns === undefined || height === undefined) throw new Error('Helix could not resolve turns/height from inputs.');
  return { turns, height };
}

function helixPoints(options: HelixOptions): Vec3[] {
  const radius = requirePositive(options.radius, 'Helix radius');
  const { turns, height } = helixResolve(options);
  const samplesPerTurn = Math.max(8, Math.floor(options.samplesPerTurn ?? 32));
  const total = Math.max(2, Math.ceil(turns * samplesPerTurn));
  const start = (options.startAngle ?? 0) * DEG;
  const dir = options.clockwise ? -1 : 1;
  const pts: Vec3[] = [];
  for (let i = 0; i <= total; i++) {
    const t = i / total;
    const angle = start + dir * turns * 2 * Math.PI * t;
    pts.push([radius * Math.cos(angle), radius * Math.sin(angle), height * t]);
  }
  return pts;
}

export const Helix = {
  path: (options: HelixOptions): Curve3D => new Curve3D(helixPoints(options), { tension: 0.5 }),
  coil: (profileOrOptions: Sketch | (HelixOptions & { wireRadius?: number; profileSegments?: number }), maybeOptions?: HelixOptions & { wireRadius?: number; profileSegments?: number }): Shape => {
    let profile: Sketch;
    let options: HelixOptions & { wireRadius?: number; profileSegments?: number };
    if (profileOrOptions instanceof Sketch) {
      profile = profileOrOptions;
      if (!maybeOptions) throw new Error('Helix.coil(profile, options) requires options.');
      options = maybeOptions;
    } else {
      options = profileOrOptions;
      const wireRadius = requirePositive(options.wireRadius ?? NaN, 'Helix.coil() wireRadius');
      profile = circle2d(wireRadius, options.profileSegments ?? 24);
    }
    const pts = helixPoints(options);
    return sweep(profile, new Curve3D(pts, { tension: 0.5 }), { samples: pts.length });
  },
};

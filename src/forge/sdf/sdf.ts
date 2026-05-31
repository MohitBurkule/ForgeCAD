/**
 * ForgeCAD SDF API — user-facing signed distance field modeling.
 *
 * Usage:
 *   const shape = sdf.smoothUnion(sdf.sphere(10), sdf.box(15, 15, 15), { radius: 3 })
 *     .toShape({ edgeLength: 0.5 })
 *     .color('#4488cc');
 *
 * SDF shapes live in "SDF space" until `.toShape()` is called, which meshes
 * them via Manifold.levelSet() and returns a regular ForgeCAD Shape.
 */

import type { ShapeMaterialProps } from '../kernel';
import { buildShapeFromSdfPlan } from './sdfBridge';
import type { SdfBounds } from './sdfEval';
import { estimateSdfBounds } from './sdfEval';
import type { SdfNode, SdfVoronoiNode, Vec3 } from './sdfNode';
import { cloneSdfNode } from './sdfNode';

export type SdfBoundsInput = SdfBounds | [Vec3, Vec3];

/** Visual metadata carried alongside an immutable SDF expression. */
interface SdfVisualMetadata {
  colorHex?: string;
  materialProps?: ShapeMaterialProps;
  bounds?: SdfBounds;
}

// ─── SurfacePattern: a 2D heightmap for surface displacement ────────────────

/**
 * A 2D surface pattern — a heightmap function `(u, v) → height` where u and v
 * are in surface millimeters. Used with `.surfaceDisplace()` to create patterns
 * that follow the shape's surface.
 *
 * Unlike 3D SDF patterns (which exist in world space), surface patterns are
 * inherently 2D — they describe relief on a surface, like texture on fabric.
 */
export class SurfacePattern {
  /** Function body: receives (u, v) in surface mm, returns height displacement. */
  readonly body: string;
  /** Named constants injected into the function. */
  readonly constants?: Record<string, number>;

  constructor(body: string, constants?: Record<string, number>) {
    this.body = body;
    this.constants = constants;
  }
}

export interface SurfaceDisplaceOptions {
  /** Override auto-detected UV mode. Default: 'auto' (detects from SDF tree). */
  uv?: 'auto' | 'sphere' | 'cylinder' | 'torus' | 'triplanar';
  /** Triplanar blend sharpness — higher = crisper transitions. Default: 4. Only used in triplanar mode. */
  triplanarSharpness?: number;
}

// ─── SdfShape: the builder ───────────────────────────────────────────────────

export interface SdfToShapeOptions {
  /** Target mesh edge length. Smaller = finer mesh. Default: auto-computed from bounds. */
  edgeLength?: number;
  /** Override auto-computed bounds. */
  bounds?: { min: Vec3; max: Vec3 };
  /** Coarse quality preset. Accepted for API parity; resolution is driven by edgeLength/bounds. */
  quality?: string;
  /** Preferred absolute surface tolerance in millimeters. Accepted for API parity. */
  tolerance?: number;
  /** Smallest feature that should survive meshing, in millimeters. Accepted for API parity. */
  minFeatureSize?: number;
}

/**
 * An immutable SDF expression. Supports SDF-specific operations (smooth booleans,
 * domain warps, etc.) and converts to a ForgeCAD Shape via `.toShape()`.
 */
export class SdfShape {
  /** @internal */
  readonly _node: SdfNode;
  /** @internal */
  readonly _visual: SdfVisualMetadata;

  /** @internal */
  constructor(node: SdfNode, visual?: SdfVisualMetadata) {
    this._node = node;
    this._visual = cloneVisualMetadata(visual);
  }

  // ── Visual metadata accessors ──

  /** Display color carried by this implicit leaf. */
  get colorHex(): string | undefined {
    return this._visual.colorHex;
  }

  /** Display material carried by this implicit leaf. */
  get materialProps(): ShapeMaterialProps | undefined {
    return this._visual.materialProps ? { ...this._visual.materialProps } : undefined;
  }

  /** Explicit bounds carried by this implicit leaf, if any. */
  get explicitBounds(): SdfBounds | undefined {
    return this._visual.bounds ? cloneBounds(this._visual.bounds) : undefined;
  }

  /** @internal — return a new SdfShape with a different node but the same visual metadata. */
  private withNode(node: SdfNode): SdfShape {
    return new SdfShape(node, this._visual);
  }

  /** @internal — return a new SdfShape with merged visual metadata. */
  private withVisual(visual: SdfVisualMetadata): SdfShape {
    return new SdfShape(this._node, { ...this._visual, ...visual });
  }

  /** Clone this SDF expression and its visual metadata. */
  clone(): SdfShape {
    return new SdfShape(cloneSdfNode(this._node), this._visual);
  }

  /** Alias for clone(). */
  duplicate(): SdfShape {
    return this.clone();
  }

  // ── Conversion ──

  /**
   * Mesh this SDF into a ForgeCAD Shape via Manifold.levelSet().
   * Once converted, the result is a regular Shape — booleans, transforms, export all work.
   */
  toShape(options?: SdfToShapeOptions): import('../kernel').Shape {
    const bounds = options?.bounds ?? this._visual.bounds ?? estimateSdfBounds(this._node);
    const edgeLength = options?.edgeLength ?? autoEdgeLength(bounds);
    let shape = buildShapeFromSdfPlan(this._node, edgeLength, bounds);
    if (this._visual.colorHex !== undefined) shape = shape.color(this._visual.colorHex);
    if (this._visual.materialProps) shape = shape.material(this._visual.materialProps);
    return shape;
  }

  // ── Visual metadata setters ──

  /** Set the display color for this implicit leaf. */
  color(value: string | undefined): SdfShape {
    return this.withVisual({ colorHex: value });
  }

  /** Set PBR display material properties for this implicit leaf. */
  material(props: ShapeMaterialProps): SdfShape {
    return this.withVisual({
      materialProps: { ...(this._visual.materialProps ?? {}), ...validateMaterialProps(props) },
    });
  }

  /** Set explicit preview/meshing bounds for this implicit leaf. */
  bounds(minOrBounds: SdfBoundsInput | Vec3, max?: Vec3): SdfShape {
    return this.withVisual({ bounds: validateBounds(normalizeBoundsInput(minOrBounds, max)) });
  }

  // ── Sculpt-style aliases ──

  /** Sculpt-style alias for translate(). */
  at(x: number, y: number, z: number): SdfShape {
    return this.translate(x, y, z);
  }

  /** Sculpt-style alias for translate(). */
  move(x: number, y: number, z: number): SdfShape {
    return this.translate(x, y, z);
  }

  /** Sculpt-style alias for rotateZ(). */
  spin(angleDeg: number): SdfShape {
    return this.rotateZ(angleDeg);
  }

  /** Sculpt-style tilt around X, Y, Z, or a custom axis. */
  tilt(angleDeg: number, axis: 'x' | 'y' | 'z' | Vec3 = 'x'): SdfShape {
    if (axis === 'x') return this.rotateX(angleDeg);
    if (axis === 'y') return this.rotateY(angleDeg);
    if (axis === 'z') return this.rotateZ(angleDeg);
    return this.rotate(axis, angleDeg);
  }

  /** Sculpt-style rounded-box helper. Currently applies directly to primitive SDF boxes. */
  round(radius: number): SdfShape {
    if (this._node.kind !== 'sdf:box') {
      throw new Error('SdfShape.round() currently works on primitive boxes. Use Sculpt.box(x, y, z, { radius }) for rounded boxes.');
    }
    return this.withNode(roundedBoxNode(this._node.halfExtents, radius));
  }

  /** Sculpt-style smooth blend with another implicit shape. */
  blend(other: SdfShape, options?: number | { radius?: number }): SdfShape {
    return this.smoothUnion(other, resolveBlendRadius(options, 'SdfShape.blend()'));
  }

  /** Sculpt-style alias for blend(). */
  goop(other: SdfShape, options?: number | { radius?: number }): SdfShape {
    return this.blend(other, options);
  }

  /** Sculpt-style smooth carve/subtract. */
  carve(other: SdfShape, options?: number | { radius?: number }): SdfShape {
    return this.smoothSubtract(other, resolveBlendRadius(options, 'SdfShape.carve()'));
  }

  /** Sculpt-style smooth intersection/keep operation. */
  keep(other: SdfShape, options?: number | { radius?: number }): SdfShape {
    return this.smoothIntersect(other, resolveBlendRadius(options, 'SdfShape.keep()'));
  }

  /** Apply a Sculpt material preset or direct material props. */
  polish(input?: SculptPolishInput): SdfShape {
    const resolved = resolveSculptPolish(input, 'SdfShape.polish');
    let out: SdfShape = this;
    if (resolved.color !== undefined) out = out.color(resolved.color);
    return out.material(resolved.material);
  }

  // ── Combinators (return new SdfShape) ──

  /** SDF union (sharp). */
  union(...others: SdfShape[]): SdfShape {
    return this.withNode({ kind: 'sdf:union', children: [this._node, ...others.map((o) => o._node)] });
  }

  /** SDF difference (sharp) — subtracts others from this. */
  subtract(...others: SdfShape[]): SdfShape {
    return this.withNode({ kind: 'sdf:difference', children: [this._node, ...others.map((o) => o._node)] });
  }

  /** SDF intersection (sharp). */
  intersect(...others: SdfShape[]): SdfShape {
    // Auto-enable surface-aware mode for voronoi nodes:
    // When intersecting a shape with a voronoi, inject the non-voronoi shape
    // as the voronoi's surfaceChild so membrane suppression works automatically.
    const children = [this._node, ...others.map((o) => o._node)];
    const enhanced = injectVoronoiSurfaceChild(children);
    return this.withNode({ kind: 'sdf:intersection', children: enhanced });
  }

  /** Clip this SDF to an explicit box-shaped design space. */
  clipBox(x: number, y: number, z: number): SdfShape {
    return this.intersect(box(x, y, z));
  }

  /** Keep only the material where this shape overlaps another SDF pattern. */
  fillWith(pattern: SdfShape): SdfShape {
    if (!(pattern instanceof SdfShape)) {
      throw new Error('SdfShape.fillWith() expects an SdfShape pattern, such as sdf.gyroid({ cellSize, wallThickness }).');
    }
    return this.intersect(pattern);
  }

  /** Keep only the gyroid lattice inside this shape. */
  fillWithGyroid(options: TpmsOptions): SdfShape {
    return this.fillWith(gyroid(options));
  }

  /** Keep only the Schwarz-P lattice inside this shape. */
  fillWithSchwarzP(options: TpmsOptions): SdfShape {
    return this.fillWith(schwarzP(options));
  }

  /** Keep only the diamond TPMS lattice inside this shape. */
  fillWithDiamond(options: TpmsOptions): SdfShape {
    return this.fillWith(diamond(options));
  }

  /** Keep only the lidinoid TPMS lattice inside this shape. */
  fillWithLidinoid(options: TpmsOptions): SdfShape {
    return this.fillWith(lidinoid(options));
  }

  /** Smooth union — blends shapes together with a smooth radius. */
  smoothUnion(other: SdfShape, radius: number): SdfShape {
    return this.withNode({ kind: 'sdf:smoothUnion', children: [this._node, other._node], radius });
  }

  /** Smooth difference — smoothly carves other from this. */
  smoothSubtract(other: SdfShape, radius: number): SdfShape {
    return this.withNode({ kind: 'sdf:smoothDifference', children: [this._node, other._node], radius });
  }

  /** Smooth intersection — smoothly intersects. */
  smoothIntersect(other: SdfShape, radius: number): SdfShape {
    return this.withNode({ kind: 'sdf:smoothIntersection', children: [this._node, other._node], radius });
  }

  /** Morph between this shape and another. t=0 → this, t=1 → other. */
  morph(other: SdfShape, t: number): SdfShape {
    return this.withNode({ kind: 'sdf:morph', a: this._node, b: other._node, t });
  }

  // ── Transforms ──

  /** Translate this SDF by the given offsets in millimeters. */
  translate(x: number, y: number, z: number): SdfShape {
    return this.withNode({ kind: 'sdf:translate', child: this._node, offset: [x, y, z] });
  }

  /** Rotate around an arbitrary axis through the origin. */
  rotate(axis: Vec3, angleDeg: number): SdfShape {
    const degrees = axisAngleToEulerDegrees(axis, angleDeg);
    return this.withNode({ kind: 'sdf:rotate', child: this._node, degrees });
  }

  /** Rotate around the X axis by the given angle in degrees. */
  rotateX(angleDeg: number): SdfShape {
    return this.withNode({ kind: 'sdf:rotate', child: this._node, degrees: [angleDeg, 0, 0] });
  }

  /** Rotate around the Y axis by the given angle in degrees. */
  rotateY(angleDeg: number): SdfShape {
    return this.withNode({ kind: 'sdf:rotate', child: this._node, degrees: [0, angleDeg, 0] });
  }

  /** Rotate around the Z axis by the given angle in degrees. */
  rotateZ(angleDeg: number): SdfShape {
    return this.withNode({ kind: 'sdf:rotate', child: this._node, degrees: [0, 0, angleDeg] });
  }

  /** Uniformly scale this SDF around the origin. */
  scale(factor: number): SdfShape {
    return this.withNode({ kind: 'sdf:scale', child: this._node, factor });
  }

  // ── Domain operations ──

  /** Twist around the Z axis. */
  twist(degreesPerUnit: number): SdfShape {
    return this.withNode({ kind: 'sdf:twist', child: this._node, degreesPerUnit });
  }

  /** Bend around the Z axis with given radius. */
  bend(radius: number): SdfShape {
    return this.withNode({ kind: 'sdf:bend', child: this._node, radius });
  }

  /** Repeat in space. Spacing of 0 on an axis means no repetition. Count of 0 = infinite. */
  repeat(spacing: Vec3, count?: Vec3): SdfShape {
    return this.withNode({ kind: 'sdf:repeat', child: this._node, spacing, count: count ?? [0, 0, 0] });
  }

  /**
   * Arrange this SDF in a circular array around the Z axis.
   *
   * The source shape is translated by `offset` in +X before arraying. This uses
   * angular domain folding, so evaluation stays O(1): the source SDF is sampled
   * twice no matter how many copies are requested.
   */
  circularArray(count: number, offset = 0): SdfShape {
    return this.withNode({
      kind: 'sdf:circularArray',
      child: this._node,
      count: requirePositiveInteger(count, 'SdfShape.circularArray() count'),
      offset: requireNonNegativeFinite(offset, 'SdfShape.circularArray() offset'),
    });
  }

  /** Hollow out, keeping only a shell of given thickness. */
  shell(thickness: number): SdfShape {
    return this.withNode({ kind: 'sdf:shell', child: this._node, thickness });
  }

  /**
   * Displace the surface by a function of position, or by a pattern SdfShape.
   *
   * ```js
   * // Function displacement
   * shape.displace((x, y, z) => Math.sin(x) * 0.5)
   *
   * // Pattern displacement (e.g. basketWeave)
   * shape.displace(sdf.basketWeave({ threads: 16, spacing: 3 }))
   * ```
   */
  displace(fn: ((x: number, y: number, z: number) => number) | SdfShape, constants?: Record<string, number>): SdfShape {
    if (fn instanceof SurfacePattern) {
      throw new Error('displace() does not accept SurfacePattern — use .surfaceDisplace() instead');
    }
    if (fn instanceof SdfShape) {
      if (fn._node.kind !== 'sdf:custom') {
        throw new Error('displace(SdfShape) only supports pattern presets (sdf:custom nodes)');
      }
      return this.withNode({ kind: 'sdf:displace', child: this._node, functionBody: fn._node.functionBody, constants: fn._node.constants });
    }
    return this.withNode({ kind: 'sdf:displace', child: this._node, functionBody: extractFunctionBody(fn), constants });
  }

  /**
   * Displace the surface using a 2D pattern in surface-local UV coordinates.
   *
   * Automatically detects the shape's UV parametrization (sphere, cylinder, torus)
   * from the SDF tree. Falls back to triplanar mapping for arbitrary shapes.
   *
   * UV coordinates are in **surface millimeters** — patterns defined with `spacing: 3`
   * always produce 3mm spacing, regardless of shape size.
   *
   * ```js
   * // Surface-following basket weave — auto-detects sphere UV
   * sdf.sphere(27).shell(3)
   *   .surfaceDisplace(sdf.basketWeave({ spacing: 3, depth: 0.8 }))
   *   .toShape()
   *
   * // Custom 2D pattern via function
   * shape.surfaceDisplace((u, v) => -Math.sin(u * 2) * 0.3)
   * ```
   */
  surfaceDisplace(pattern: SurfacePattern | ((u: number, v: number) => number), options?: SurfaceDisplaceOptions): SdfShape {
    let body: string;
    let constants: Record<string, number> | undefined;
    if (pattern instanceof SurfacePattern) {
      body = pattern.body;
      constants = pattern.constants;
    } else {
      body = extractFunctionBody(pattern as Function);
    }
    return this.withNode({
      kind: 'sdf:surfaceDisplace',
      child: this._node,
      patternBody: body,
      constants,
      ...(options?.uv ? { uvMode: options.uv } : {}),
      ...(options?.triplanarSharpness !== undefined ? { triplanarSharpness: options.triplanarSharpness } : {}),
    });
  }

  /** Create concentric onion layers. */
  onion(layers: number, thickness: number): SdfShape {
    return this.withNode({ kind: 'sdf:onion', child: this._node, layers, thickness });
  }
}

// ─── Factory functions (the sdf namespace) ───────────────────────────────────

/** Create an SDF sphere centered at the origin. */
export function sphere(radius: number): SdfShape {
  return new SdfShape({ kind: 'sdf:sphere', radius });
}

/** Create an SDF box centered at the origin with given full dimensions (not half-extents). */
export function box(x: number, y: number, z: number): SdfShape {
  return new SdfShape({ kind: 'sdf:box', halfExtents: [x / 2, y / 2, z / 2] });
}

/** Create an SDF cylinder centered at the origin, axis along Z. */
export function cylinder(height: number, radius: number): SdfShape {
  return new SdfShape({ kind: 'sdf:cylinder', height, radius });
}

/** Create an SDF torus centered at the origin, lying in the XY plane. */
export function torus(majorRadius: number, minorRadius: number): SdfShape {
  return new SdfShape({ kind: 'sdf:torus', majorRadius, minorRadius });
}

/** Create an SDF capsule centered at the origin, axis along Z. */
export function capsule(height: number, radius: number): SdfShape {
  return new SdfShape({ kind: 'sdf:capsule', height, radius });
}

/** Create an SDF cone with base at z=0 and tip at z=height. */
export function cone(height: number, radius: number): SdfShape {
  return new SdfShape({ kind: 'sdf:cone', height, radius });
}

// ─── Combinator factories ────────────────────────────────────────────────────

/** Smooth union — blends shapes together with a smooth transition radius. */
export function smoothUnion(a: SdfShape, b: SdfShape, options: { radius: number }): SdfShape {
  return new SdfShape({ kind: 'sdf:smoothUnion', children: [a._node, b._node], radius: options.radius });
}

/** Smooth difference — smoothly subtracts b from a. */
export function smoothDifference(a: SdfShape, b: SdfShape, options: { radius: number }): SdfShape {
  return new SdfShape({ kind: 'sdf:smoothDifference', children: [a._node, b._node], radius: options.radius });
}

/** Smooth intersection — smoothly intersects a and b. */
export function smoothIntersection(a: SdfShape, b: SdfShape, options: { radius: number }): SdfShape {
  return new SdfShape({ kind: 'sdf:smoothIntersection', children: [a._node, b._node], radius: options.radius });
}

/** Morph between two SDF shapes. t=0 → a, t=1 → b. */
export function morph(a: SdfShape, b: SdfShape, t: number): SdfShape {
  return new SdfShape({ kind: 'sdf:morph', a: a._node, b: b._node, t });
}

// ─── Spatial blend factory ──────────────────────────────────────────────────

export interface BlendOptions {
  /** Optional named constants accessible in the blend function. */
  constants?: Record<string, number>;
}

/**
 * Spatially blend between two SDF patterns.
 * The blend function receives (x, y, z) and returns 0..1:
 * 0 = fully pattern `a`, 1 = fully pattern `b`.
 *
 * ```js
 * // Schwarz-P at bottom, gyroid at top, smooth transition
 * sdf.blend(
 *   sdf.schwarzP({ cellSize: 6, thickness: 1 }),
 *   sdf.gyroid({ cellSize: 8, thickness: 1 }),
 *   (x, y, z) => Math.max(0, Math.min(1, z / 30))
 * ).intersect(sdf.sphere(20)).toShape()
 * ```
 */
export function blend(a: SdfShape, b: SdfShape, fn: (x: number, y: number, z: number) => number, options?: BlendOptions): SdfShape {
  return new SdfShape({
    kind: 'sdf:spatialBlend',
    a: a._node,
    b: b._node,
    functionBody: extractFunctionBody(fn),
    constants: options?.constants,
  });
}

// ─── TPMS lattice factories ──────────────────────────────────────────────────

export interface TpmsOptions {
  cellSize: number;
  /** Wall thickness of the lattice surface (mm). 0.9.13 spelling. */
  wallThickness?: number;
  /** @deprecated Alias for wallThickness. */
  thickness?: number;
}

/** Resolve the lattice wall thickness (mm), accepting both `wallThickness` (preferred) and `thickness`. */
function tpmsThickness(options: TpmsOptions): number {
  const t = options.wallThickness ?? options.thickness;
  if (t == null || !Number.isFinite(t) || t <= 0) {
    throw new Error('TPMS lattice requires a positive finite wallThickness, e.g. gyroid({ cellSize: 10, wallThickness: 1.5 }).');
  }
  return t;
}

/**
 * Convert a physical wall thickness (mm) into the dimensionless field isovalue the TPMS
 * evaluators subtract (`|F| < iso`). Near the F=0 surface, |F| ≈ |∇F|·distance, and |∇F|
 * scales with the cell frequency `2π/cellSize` times a surface-specific gradient factor.
 * So iso ≈ (t/2)·(2π/cellSize)·gradFactor. Factors calibrated against forgecad@0.9.13.
 */
function tpmsIsovalue(options: TpmsOptions, gradFactor: number): number {
  const t = tpmsThickness(options);
  return (t / 2) * ((Math.PI * 2) / options.cellSize) * gradFactor;
}

/** Gyroid TPMS lattice — the most common lattice for additive manufacturing. */
export function gyroid(options: TpmsOptions): SdfShape {
  return new SdfShape({ kind: 'sdf:gyroid', cellSize: options.cellSize, thickness: tpmsIsovalue(options, 1.36) });
}

/** Schwarz-P TPMS lattice — isotropic pore structure. */
export function schwarzP(options: TpmsOptions): SdfShape {
  return new SdfShape({ kind: 'sdf:schwarzP', cellSize: options.cellSize, thickness: tpmsIsovalue(options, 1.22) });
}

/** Diamond TPMS lattice — stiffest TPMS structure. */
export function diamond(options: TpmsOptions): SdfShape {
  return new SdfShape({ kind: 'sdf:diamond', cellSize: options.cellSize, thickness: tpmsIsovalue(options, 1.36) });
}

/** Lidinoid TPMS lattice — visually distinct from gyroid, popular in research and art. */
export function lidinoid(options: TpmsOptions): SdfShape {
  return new SdfShape({ kind: 'sdf:lidinoid', cellSize: options.cellSize, thickness: tpmsIsovalue(options, 1.36) });
}

// ─── Noise / pattern factories ──────────────────────────────────────────────

export interface NoiseOptions {
  /** Spatial frequency — smaller = larger features. Default: 0.1 */
  scale?: number;
  /** Peak displacement amplitude. Default: 1 */
  amplitude?: number;
  /** fBm octaves (1 = plain simplex, higher = more detail). Default: 1 */
  octaves?: number;
  /** Seed for deterministic variation. Default: 0 */
  seed?: number;
}

/**
 * 3D Simplex noise field — produces organic, natural-looking displacements.
 * Use as a standalone SDF (creates a bumpy surface) or intersect/displace with other shapes.
 *
 * ```js
 * // Organic textured sphere
 * sdf.sphere(20).subtract(sdf.sphere(18))  // hollow shell
 *   .intersect(sdf.noise({ scale: 0.2, amplitude: 3 }))
 *   .toShape()
 * ```
 */
export function noise(options?: NoiseOptions): SdfShape {
  return new SdfShape({
    kind: 'sdf:noise',
    scale: options?.scale ?? 0.1,
    amplitude: options?.amplitude ?? 1,
    octaves: options?.octaves ?? 1,
    seed: options?.seed ?? 0,
  });
}

export interface VoronoiOptions {
  /** Size of each Voronoi cell in world units. Default: 10 */
  cellSize?: number;
  /** Wall thickness between cells. Default: 1 */
  wallThickness?: number;
  /** Seed for deterministic variation. Default: 0 */
  seed?: number;
  /**
   * Projection weight for membrane suppression (0..1). Controls how much of
   * the surface-normal distance component is removed from Voronoi cell distances.
   * 0 = no projection (classic 3D voronoi with membranes).
   * 1 = full tangent-plane projection (pure 2D pattern on surface).
   * Default: 0.85. Only active when voronoi is intersected with another shape.
   */
  suppressionThreshold?: number;
}

/**
 * 3D Voronoi pattern — organic cellular structures like bone, coral, or soap bubbles.
 * Returns an SDF where the walls between Voronoi cells are solid.
 *
 * ```js
 * // Voronoi vase
 * sdf.cylinder(80, 30).shell(2)
 *   .intersect(sdf.voronoi({ cellSize: 8, wallThickness: 1.5 }))
 *   .toShape()
 * ```
 */
export function voronoi(options?: VoronoiOptions): SdfShape {
  return new SdfShape({
    kind: 'sdf:voronoi',
    cellSize: options?.cellSize ?? 10,
    wallThickness: options?.wallThickness ?? 1,
    seed: options?.seed ?? 0,
    ...(options?.suppressionThreshold !== undefined ? { suppressionThreshold: options.suppressionThreshold } : {}),
  });
}

// ─── Pattern presets (convenience wrappers) ─────────────────────────────────

export interface HoneycombOptions {
  /** Size of each hex cell. Default: 8 */
  cellSize?: number;
  /** Wall thickness. Default: 1 */
  wallThickness?: number;
}

/**
 * Honeycomb (hexagonal) lattice pattern.
 * Approximated as a 2D hex grid extruded infinitely along Y.
 * Intersect with your shape to apply.
 *
 * ```js
 * sdf.box(60, 40, 60).shell(2)
 *   .intersect(sdf.honeycomb({ cellSize: 6, wallThickness: 1 }))
 *   .toShape()
 * ```
 */
export function honeycomb(options?: HoneycombOptions): SdfShape {
  const cell = options?.cellSize ?? 8;
  const wall = options?.wallThickness ?? 1;
  // Honeycomb as schwarzP restricted to XZ (a good 2D hex approximation)
  // is actually better done as a custom SDF using hex distance.
  // For a clean hex grid we use a custom function.
  const halfWall = wall / 2;
  const fn = `(function() {
    var s = ${cell};
    var hw = ${halfWall};
    var k = ${Math.PI / 3};
    var c = Math.cos(k), si = Math.sin(k);
    // Hex distance in XY plane
    var px = Math.abs(x), py = Math.abs(y);
    // Rotate to align hex grid
    var qx = px * c - py * si;
    var qy = px * si + py * c;
    qx = ((qx % s) + s) % s; qy = ((qy % s) + s) % s;
    qx = qx - s * 0.5; qy = qy - s * 0.5;
    var d = Math.max(Math.abs(qx), Math.abs(qy) * 0.866 + Math.abs(qx) * 0.5) - s * 0.5 + hw;
    return d;
  })()`;
  return new SdfShape({
    kind: 'sdf:custom',
    functionBody: fn,
    bounds: { min: [-100, -100, -100], max: [100, 100, 100] },
  });
}

export interface WavesOptions {
  /** Distance between wave peaks. Default: 10 */
  wavelength?: number;
  /** Height of waves. Default: 1 */
  amplitude?: number;
  /** Axis along which waves propagate: 'x', 'y', or 'z'. Default: 'x' */
  axis?: 'x' | 'y' | 'z';
}

/**
 * Sinusoidal wave ridges — parallel ridges along an axis.
 * The returned SDF is solid where the wave crests are.
 * Typically used with `.intersect(shape.shell(t))` to create ridged surfaces.
 */
export function waves(options?: WavesOptions): SdfShape {
  const wl = options?.wavelength ?? 10;
  const amp = options?.amplitude ?? 1;
  const axis = options?.axis ?? 'x';
  const freq = (2 * Math.PI) / wl;
  const coord = axis === 'x' ? 'x' : axis === 'y' ? 'y' : 'z';
  return new SdfShape({
    kind: 'sdf:custom',
    functionBody: `Math.sin(${coord} * ${freq}) * ${amp}`,
    bounds: { min: [-100, -100, -100], max: [100, 100, 100] },
  });
}

export interface KnurlOptions {
  /** Distance between knurl ridges. Default: 3 */
  pitch?: number;
  /** Depth of knurl grooves. Default: 0.5 */
  depth?: number;
  /** Helix angle in degrees. Default: 30 */
  angle?: number;
}

/**
 * Knurl pattern — crossed helical grooves for grips and handles.
 * Designed to be used with `.displace()` or intersected with cylindrical shapes.
 *
 * ```js
 * sdf.cylinder(20, 8)
 *   .displace(sdf.knurl({ pitch: 2, depth: 0.3 }))
 *   .toShape()
 * ```
 *
 * Returns an SDF whose value can be used as a displacement field.
 */
export function knurl(options?: KnurlOptions): SdfShape {
  const pitch = options?.pitch ?? 3;
  const depth = options?.depth ?? 0.5;
  const angle = ((options?.angle ?? 30) * Math.PI) / 180;
  const freq = (2 * Math.PI) / pitch;
  // Diamond knurl = intersection of two helical sine waves at opposing angles
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return new SdfShape({
    kind: 'sdf:custom',
    functionBody: `(function() {
      var r = Math.sqrt(x * x + y * y);
      var theta = Math.atan2(y, x);
      var u1 = r * theta * ${cosA} + z * ${sinA};
      var u2 = r * theta * ${cosA} - z * ${sinA};
      return Math.min(Math.sin(u1 * ${freq}), Math.sin(u2 * ${freq})) * ${depth};
    })()`,
    bounds: { min: [-50, -50, -50], max: [50, 50, 50] },
  });
}

export interface PerforatedOptions {
  /** Hole radius. Default: 3 */
  radius?: number;
  /** Center-to-center spacing. Default: 8 */
  spacing?: number;
}

/**
 * Perforated plate pattern — regular array of cylindrical holes.
 * Subtract from a shape to punch holes in it.
 *
 * ```js
 * sdf.box(60, 2, 60)
 *   .subtract(sdf.perforated({ radius: 2, spacing: 6 }))
 *   .toShape()
 * ```
 */
export function perforated(options?: PerforatedOptions): SdfShape {
  const r = options?.radius ?? 3;
  const sp = options?.spacing ?? 8;
  // A cylinder repeated in XY
  return cylinder(1000, r).repeat([sp, sp, 0], [0, 0, 0]);
}

// ─── Surface pattern presets ────────────────────────────────────────────────

export interface ScalesOptions {
  /** Scale diameter. Default: 5 */
  size?: number;
  /** How much scales protrude. Default: 0.8 */
  depth?: number;
}

/**
 * Fish/dragon scale pattern — overlapping circular scales in hex-packed rows.
 * Returns an infinite-extent SDF; intersect with a bounding shape.
 */
export function scales(options?: ScalesOptions): SdfShape {
  const size = options?.size ?? 5;
  const depth = options?.depth ?? 0.8;
  const halfDepth = depth * 0.5;
  const halfSize = size * 0.5;
  const rowHeight = size * 0.866;
  const halfRowHeight = rowHeight;
  // Moderate default bounds — user should intersect with a bounding shape
  const ext = size * 8;
  const functionBody = `(function() {
  var s = ${size};
  var rh = ${rowHeight};
  var row = Math.floor(y / rh);
  var offset = (row & 1) * s * 0.5;
  var col = Math.round((x - offset) / s);
  var cx = col * s + offset;
  var cy = row * rh;
  var dx = x - cx, dy = y - cy;
  var dist = Math.sqrt(dx * dx + dy * dy);
  var profile = Math.max(0, 1 - dist / ${halfSize});
  var overlap = (y - cy) / ${halfRowHeight} * ${halfDepth};
  return -(profile * profile * ${depth} + overlap);
})()`;
  return new SdfShape({ kind: 'sdf:custom', functionBody, bounds: { min: [-ext, -ext, -depth * 2], max: [ext, ext, depth * 2] } });
}

export interface BrickOptions {
  /** Brick width. Default: 10 */
  width?: number;
  /** Brick height. Default: 5 */
  height?: number;
  /** Mortar groove depth. Default: 0.5 */
  depth?: number;
  /** Mortar gap width. Default: 1 */
  mortar?: number;
}

/**
 * Brick/stone wall pattern — running bond with mortar grooves.
 * Oriented in XZ plane (X = columns, Z = rows). Intersect with a bounding shape.
 */
export function brick(options?: BrickOptions): SdfShape {
  const width = options?.width ?? 10;
  const height = options?.height ?? 5;
  const depth = options?.depth ?? 0.5;
  const mortar = options?.mortar ?? 1;
  const halfMortar = mortar * 0.5;
  const ext = Math.max(width, height) * 8;
  const functionBody = `(function() {
  var w = ${width}, h = ${height}, m = ${halfMortar};
  var row = Math.floor(z / h);
  var offset = (row & 1) * w * 0.5;
  var bx = ((x - offset) % w + w) % w;
  var bz = (z % h + h) % h;
  var dx = Math.min(bx, w - bx);
  var dz = Math.min(bz, h - bz);
  var d = Math.min(dx, dz);
  return d < m ? ${depth} : -${depth};
})()`;
  return new SdfShape({ kind: 'sdf:custom', functionBody, bounds: { min: [-ext, -depth * 2, -ext], max: [ext, depth * 2, ext] } });
}

export interface WeaveOptions {
  /** Thread center-to-center spacing (for intersection patterns). Default: 5 */
  spacing?: number;
  /** Thread half-width. Default: 1 */
  threadRadius?: number;
}

/**
 * Grid lattice pattern — two families of infinite slabs crossing at 90°.
 * Creates a waffle/grid when intersected with a shell. For thread-like basket
 * weave on curved surfaces, use `sdf.basketWeave()` with `.displace()` instead.
 *
 * ```js
 * sdf.sphere(20).shell(2)
 *   .intersect(sdf.weave({ spacing: 3, threadRadius: 1.2 }))
 *   .toShape()
 * ```
 */
export function weave(options?: WeaveOptions): SdfShape {
  const sp = options?.spacing ?? 5;
  const r = options?.threadRadius ?? 1;
  const ext = 200;
  const k = r * 0.5;
  const functionBody = `(function() {
  var sp = ${sp}, r = ${r}, k = ${k};
  var dA = Math.abs(y - Math.round(y / sp) * sp) - r;
  var dB = Math.abs(x - Math.round(x / sp) * sp) - r;
  var h = Math.max(k - Math.abs(dA - dB), 0) / k;
  return Math.min(dA, dB) - h * h * k * 0.25;
})()`;
  return new SdfShape({
    kind: 'sdf:custom',
    functionBody,
    bounds: { min: [-ext, -ext, -ext], max: [ext, ext, ext] },
  });
}

export interface BasketWeaveOptions {
  /** Spacing between threads in mm (both directions). Default: 3 */
  spacing?: number;
  /** Thread width in mm. Default: 1.5 */
  threadWidth?: number;
  /** Thread protrusion depth in mm. Default: 0.8 */
  depth?: number;
}

/**
 * Basket weave surface pattern — threads with over-under crossings in UV space.
 * Returns a `SurfacePattern` for use with `.surfaceDisplace()`.
 *
 * The pattern is defined in surface millimeters — `spacing: 3` means 3mm between
 * threads regardless of shape size. The UV parametrization (sphere, cylinder, etc.)
 * is handled automatically by `.surfaceDisplace()`.
 *
 * ```js
 * // Woven bowl — auto-detects sphere UV
 * sdf.sphere(27).shell(3)
 *   .surfaceDisplace(sdf.basketWeave({ spacing: 3, depth: 0.8 }))
 *   .toShape()
 * ```
 */
export function basketWeave(options?: BasketWeaveOptions): SurfacePattern {
  const SP = options?.spacing ?? 3;
  const TW = options?.threadWidth ?? 1.5;
  const D = options?.depth ?? 0.8;
  const hw = TW * 0.5;
  // Pure 2D pattern: (u, v) in surface mm → height
  const body = `(function() {
  var su = u / ${SP};
  var sv = v / ${SP};
  var du = Math.abs(su - Math.round(su)) * ${SP};
  var dv = Math.abs(sv - Math.round(sv)) * ${SP};
  var hw = ${hw};
  var pU = Math.max(0, 1 - du / hw); pU *= pU;
  var pV = Math.max(0, 1 - dv / hw); pV *= pV;
  var checker = ((Math.round(su) & 65535) + (Math.round(sv) & 65535)) & 1;
  var top = checker ? pV : pU;
  var bot = checker ? pU : pV;
  return -(top > bot * 0.15 ? top : bot * 0.15) * ${D};
})()`;
  return new SurfacePattern(body);
}

// ─── Custom SDF ──────────────────────────────────────────────────────────────

export interface SdfFunctionOptions {
  /** Required bounds — the function is opaque, so the meshing region must be explicit. */
  bounds: SdfBoundsInput;
  /** Named constants injected as extra function parameters (avoids closure capture). */
  constants?: Record<string, number>;
  /** Raymarch step cap hint (accepted for API parity; CPU sampling ignores it). */
  maxStep?: number;
  /** Lipschitz bound hint (accepted for API parity). */
  lipschitz?: number;
}

/**
 * Create an SDF shape from an arbitrary distance function.
 * The function receives (x, y, z) and must return a signed distance
 * (negative = inside, positive = outside).
 *
 * You must provide bounds since the function is opaque. Bounds and optional
 * constants are passed in an options object:
 *
 * ```js
 * sdf.fromFunction(
 *   (x, y, z, r) => Math.hypot(x, y, z) - r,
 *   { bounds: { min: [-12, -12, -12], max: [12, 12, 12] }, constants: { r: 10 } },
 * )
 * ```
 */
export function fromFunction(
  fn: (x: number, y: number, z: number, ...constants: number[]) => number,
  options: SdfFunctionOptions,
): SdfShape {
  if (!options || typeof options !== 'object' || !('bounds' in options)) {
    throw new Error('sdf.fromFunction() expects options with { bounds, constants?, maxStep?, lipschitz? }.');
  }
  const bounds = validateBounds(normalizeBoundsInput(options.bounds));
  return new SdfShape({
    kind: 'sdf:custom',
    functionBody: extractFunctionBody(fn),
    bounds,
    ...(options.constants ? { constants: options.constants } : {}),
  });
}

// ─── Domain operation factories ──────────────────────────────────────────────

/** Twist an SDF shape around the Z axis. */
export function twist(shape: SdfShape, degreesPerUnit: number): SdfShape {
  return shape.twist(degreesPerUnit);
}

/** Bend an SDF shape around the Z axis. */
export function bend(shape: SdfShape, radius: number): SdfShape {
  return shape.bend(radius);
}

/** Repeat an SDF shape in space. */
export function repeat(shape: SdfShape, spacing: Vec3, count?: Vec3): SdfShape {
  return shape.repeat(spacing, count);
}

/** Arrange an SDF shape in a circular array around the Z axis with O(1) folded-domain evaluation. */
export function circularArray(shape: SdfShape, count: number, offset = 0): SdfShape {
  return shape.circularArray(count, offset);
}

// ─── TPMS block / clip helpers ────────────────────────────────────────────────

export interface TpmsBlockOptions extends TpmsOptions {
  /** Which TPMS field to use. Default: 'gyroid'. */
  type?: 'gyroid' | 'schwarzP' | 'diamond' | 'lidinoid';
  /** Box-shaped design space (full dimensions in mm). */
  size: Vec3;
}

/** TPMS block preset clipped to an explicit design space. */
export function tpmsBlock(options: TpmsBlockOptions): SdfShape {
  const tpmsOptions: TpmsOptions = { cellSize: options.cellSize, thickness: options.thickness };
  const type = options.type ?? 'gyroid';
  const field =
    type === 'schwarzP'
      ? schwarzP(tpmsOptions)
      : type === 'diamond'
        ? diamond(tpmsOptions)
        : type === 'lidinoid'
          ? lidinoid(tpmsOptions)
          : gyroid(tpmsOptions);
  return withinBox(field, { size: options.size });
}

/** Clip an SDF shape to a box-shaped design space. */
export function withinBox(shape: SdfShape, options: { size: Vec3 }): SdfShape {
  return shape.clipBox(options.size[0], options.size[1], options.size[2]);
}

// ─── N-dimensional pattern helper ─────────────────────────────────────────────

/**
 * Repeat an SDF shape on a regular N-axis grid. A generalized `repeat()` that
 * accepts per-axis `{ spacing, count }` so 1D, 2D, or 3D arrays read declaratively.
 */
export function patternNd(shape: SdfShape, axes: { spacing: number; count?: number }[]): SdfShape {
  if (!Array.isArray(axes) || axes.length === 0 || axes.length > 3) {
    throw new Error('sdf.patternNd() expects 1 to 3 axis descriptors: [{ spacing, count? }, ...].');
  }
  const spacing: Vec3 = [0, 0, 0];
  const count: Vec3 = [0, 0, 0];
  axes.forEach((axis, i) => {
    spacing[i] = requireNonNegativeFinite(axis.spacing, `sdf.patternNd() axes[${i}].spacing`);
    count[i] = axis.count === undefined ? 0 : requireNonNegativeFinite(axis.count, `sdf.patternNd() axes[${i}].count`);
  });
  return shape.repeat(spacing, count);
}

// ─── Materialization helpers ──────────────────────────────────────────────────

/** Materialize a single SDF leaf into a mesh-backed ForgeCAD Shape. */
export function toShape(value: SdfShape, options?: SdfToShapeOptions): import('../kernel').Shape {
  if (!(value instanceof SdfShape)) {
    throw new Error('sdf.toShape() expects an SdfShape.');
  }
  return value.toShape(options);
}

export interface CombineOptions {
  op?: 'union' | 'intersection';
}

/** Collapse a tree of SDF leaves into one continuous SDF field. */
export function combine(value: SdfShape | SdfShape[], options?: CombineOptions): SdfShape {
  const leaves: SdfShape[] = Array.isArray(value) ? value : [value];
  if (leaves.length === 0) throw new Error('sdf.combine() requires at least one SdfShape.');
  for (const leaf of leaves) {
    if (!(leaf instanceof SdfShape)) throw new Error('sdf.combine() expects SdfShape values.');
  }
  const [first, ...rest] = leaves;
  if (rest.length === 0) return first;
  return options?.op === 'intersection' ? first.intersect(...rest) : first.union(...rest);
}

// ─── Pattern2D — typed, composable 2D surface patterns ────────────────────────

interface SurfacePatternNode {
  kind: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

const f2 = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  return Number(value.toPrecision(12)).toString();
};

function emitSurfacePatternExpression(node: SurfacePatternNode): string {
  switch (node.kind) {
    case 'surfacePattern:constant':
      return f2(node.value);
    case 'surfacePattern:sineWave': {
      const coord = `(u * ${f2(node.direction[0])} + v * ${f2(node.direction[1])})`;
      const phase = `(${coord} * ${f2((2 * Math.PI) / node.wavelength)} + ${f2(node.phase)})`;
      return `(${f2(node.bias)} + Math.sin(${phase}) * ${f2(node.amplitude)})`;
    }
    case 'surfacePattern:stripes': {
      const coord = `(u * ${f2(node.direction[0])} + v * ${f2(node.direction[1])})`;
      return `(function(){var c=${coord};var d=Math.abs(c - Math.round(c / ${f2(node.spacing)}) * ${f2(node.spacing)});var p=Math.max(0, 1 - d / ${f2(node.width * 0.5)});return -(p * p) * ${f2(node.depth)};})()`;
    }
    case 'surfacePattern:overUnderWeave':
      return `(function(){var su=u/${f2(node.spacing[0])};var sv=v/${f2(node.spacing[1])};var du=Math.abs(su - Math.round(su))*${f2(node.spacing[0])};var dv=Math.abs(sv - Math.round(sv))*${f2(node.spacing[1])};var pU=Math.max(0,1-du/${f2(node.threadWidth[0] * 0.5)});pU*=pU;var pV=Math.max(0,1-dv/${f2(node.threadWidth[1] * 0.5)});pV*=pV;var checker=((Math.round(su)&65535)+(Math.round(sv)&65535))&1;var top=checker?pV:pU;var bot=checker?pU:pV;return -Math.max(top,bot*${f2(node.underScale)})*${f2(node.depth)};})()`;
    case 'surfacePattern:abs':
      return `Math.abs(${emitSurfacePatternExpression(node.child)})`;
    case 'surfacePattern:negate':
      return `(-(${emitSurfacePatternExpression(node.child)}))`;
    case 'surfacePattern:add':
      return node.children.length === 0 ? '0' : `(${node.children.map(emitSurfacePatternExpression).join(' + ')})`;
    case 'surfacePattern:multiply':
      return node.children.length === 0 ? '1' : `(${node.children.map(emitSurfacePatternExpression).join(' * ')})`;
    case 'surfacePattern:min':
      return node.children.length === 0 ? '0' : `Math.min(${node.children.map(emitSurfacePatternExpression).join(', ')})`;
    case 'surfacePattern:max':
      return node.children.length === 0 ? '0' : `Math.max(${node.children.map(emitSurfacePatternExpression).join(', ')})`;
    case 'surfacePattern:clamp':
      return `Math.min(${f2(node.max)}, Math.max(${f2(node.min)}, ${emitSurfacePatternExpression(node.child)}))`;
    default:
      throw new Error(`Unknown surface pattern node: ${node.kind}`);
  }
}

const typedSurfacePatterns = new WeakMap<SurfacePattern, SurfacePatternNode>();

function patternNodeFromInput(input: SurfacePattern | number): SurfacePatternNode {
  if (input instanceof SurfacePattern) {
    const node = typedSurfacePatterns.get(input);
    if (node) return node;
  }
  if (typeof input === 'number') {
    return { kind: 'surfacePattern:constant', value: requireFinite(input, 'Pattern2D numeric input') };
  }
  throw new Error('Pattern2D composition expects another typed Pattern2D or a number.');
}

/**
 * A composable, typed 2D surface pattern produced by `sdf.pattern2d()`. Behaves
 * as a `SurfacePattern` for `.surfaceDisplace()` and supports arithmetic combinators.
 */
export class Pattern2D extends SurfacePattern {
  constructor(node: SurfacePatternNode) {
    super(emitSurfacePatternExpression(node));
    typedSurfacePatterns.set(this, node);
  }

  private get node(): SurfacePatternNode {
    return typedSurfacePatterns.get(this)!;
  }

  /** Add this pattern to one or more patterns or constant height offsets. */
  add(...patterns: (Pattern2D | number)[]): Pattern2D {
    return new Pattern2D({ kind: 'surfacePattern:add', children: [this.node, ...patterns.map(patternNodeFromInput)] });
  }

  /** Subtract another pattern or constant height offset from this pattern. */
  subtract(pattern: Pattern2D | number): Pattern2D {
    return this.add(new Pattern2D({ kind: 'surfacePattern:negate', child: patternNodeFromInput(pattern) }));
  }

  /** Multiply this pattern by one or more patterns or numeric scale factors. */
  multiply(...patterns: (Pattern2D | number)[]): Pattern2D {
    return new Pattern2D({ kind: 'surfacePattern:multiply', children: [this.node, ...patterns.map(patternNodeFromInput)] });
  }

  /** Keep the lower height between this pattern and one or more other patterns. */
  min(...patterns: (Pattern2D | number)[]): Pattern2D {
    return new Pattern2D({ kind: 'surfacePattern:min', children: [this.node, ...patterns.map(patternNodeFromInput)] });
  }

  /** Keep the higher height between this pattern and one or more other patterns. */
  max(...patterns: (Pattern2D | number)[]): Pattern2D {
    return new Pattern2D({ kind: 'surfacePattern:max', children: [this.node, ...patterns.map(patternNodeFromInput)] });
  }

  /** Limit pattern height to the inclusive `[min, max]` range in millimeters. */
  clamp(min: number, max: number): Pattern2D {
    const lo = requireFinite(min, 'Pattern2D.clamp() min');
    const hi = requireFinite(max, 'Pattern2D.clamp() max');
    if (lo > hi) throw new Error(`Pattern2D.clamp() min must be <= max. Received: ${lo} > ${hi}`);
    return new Pattern2D({ kind: 'surfacePattern:clamp', child: this.node, min: lo, max: hi });
  }

  /** Convert negative heights to positive heights. */
  abs(): Pattern2D {
    return new Pattern2D({ kind: 'surfacePattern:abs', child: this.node });
  }

  /** Flip the pattern height sign. */
  negate(): Pattern2D {
    return new Pattern2D({ kind: 'surfacePattern:negate', child: this.node });
  }
}

export interface Pattern2DSineWaveOptions {
  direction?: [number, number];
  wavelength: number;
  amplitude?: number;
  phase?: number;
  bias?: number;
}

export interface Pattern2DStripesOptions {
  direction?: [number, number];
  spacing: number;
  width: number;
  depth?: number;
}

export interface Pattern2DOverUnderWeaveOptions {
  spacing: number | [number, number];
  threadWidth: number | [number, number];
  depth?: number;
  underScale?: number;
}

/** Factory for typed, composable 2D surface patterns. Created via `sdf.pattern2d()`. */
export class Pattern2DBuilder {
  /** Create a constant-height pattern in millimeters. */
  constant(value = 0): Pattern2D {
    return new Pattern2D({ kind: 'surfacePattern:constant', value: requireFinite(value, 'sdf.pattern2d().constant() value') });
  }

  /** Create a sinusoidal wave pattern in UV space. */
  sineWave(options: Pattern2DSineWaveOptions): Pattern2D {
    return new Pattern2D({
      kind: 'surfacePattern:sineWave',
      direction: normalizeDirection(options.direction ?? [1, 0], 'sdf.pattern2d().sineWave() direction'),
      wavelength: requirePositiveFinite(options.wavelength, 'sdf.pattern2d().sineWave() wavelength'),
      amplitude: requireFinite(options.amplitude ?? 1, 'sdf.pattern2d().sineWave() amplitude'),
      phase: requireFinite(options.phase ?? 0, 'sdf.pattern2d().sineWave() phase'),
      bias: requireFinite(options.bias ?? 0, 'sdf.pattern2d().sineWave() bias'),
    });
  }

  /** Create recessed stripe bands in UV space. */
  stripes(options: Pattern2DStripesOptions): Pattern2D {
    return new Pattern2D({
      kind: 'surfacePattern:stripes',
      direction: normalizeDirection(options.direction ?? [1, 0], 'sdf.pattern2d().stripes() direction'),
      spacing: requirePositiveFinite(options.spacing, 'sdf.pattern2d().stripes() spacing'),
      width: requirePositiveFinite(options.width, 'sdf.pattern2d().stripes() width'),
      depth: requireNonNegativeFinite(options.depth ?? 1, 'sdf.pattern2d().stripes() depth'),
    });
  }

  /** Create an over-under woven relief pattern in UV space. */
  overUnderWeave(options: Pattern2DOverUnderWeaveOptions): Pattern2D {
    return new Pattern2D({
      kind: 'surfacePattern:overUnderWeave',
      spacing: normalizeVec2(options.spacing, 'sdf.pattern2d().overUnderWeave() spacing', requirePositiveFinite),
      threadWidth: normalizeVec2(options.threadWidth, 'sdf.pattern2d().overUnderWeave() threadWidth', requirePositiveFinite),
      depth: requireNonNegativeFinite(options.depth ?? 0.8, 'sdf.pattern2d().overUnderWeave() depth'),
      underScale: requireNonNegativeFinite(options.underScale ?? 0.15, 'sdf.pattern2d().overUnderWeave() underScale'),
    });
  }
}

/** Create typed, composable 2D surface patterns for `.surfaceDisplace()`. */
export function pattern2d(): Pattern2DBuilder {
  return new Pattern2DBuilder();
}

// ─── Sculpt material presets + facade ─────────────────────────────────────────

const SCULPT_MATERIAL_PRESETS: Record<string, { color: string; material: ShapeMaterialProps }> = {
  ceramic: { color: '#f4f0e6', material: { roughness: 0.28, metalness: 0.02, clearcoat: 0.55, clearcoatRoughness: 0.22 } },
  porcelain: { color: '#fff9ee', material: { roughness: 0.18, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.08 } },
  'soft-rubber': { color: '#2c3038', material: { roughness: 0.72, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.65 } },
  glass: { color: '#dcefff', material: { roughness: 0.03, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, opacity: 0.42, transmission: 0.65, ior: 1.45 } },
  'mint-glass': { color: '#b8fff0', material: { roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, opacity: 0.58, transmission: 0.45, ior: 1.42 } },
  candy: { color: '#ff6fb1', material: { roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 } },
  'strawberry-gel': { color: '#ff4f83', material: { roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, opacity: 0.82, transmission: 0.22 } },
  metal: { color: '#b8bec8', material: { roughness: 0.18, metalness: 0.88, clearcoat: 0.35, clearcoatRoughness: 0.12 } },
  clay: { color: '#d9825f', material: { roughness: 0.82, metalness: 0, clearcoat: 0, clearcoatRoughness: 0.8 } },
};

export type SculptPolishInput = string | (ShapeMaterialProps & { color?: string });

function knownSculptMaterialPresets(): string[] {
  return Object.keys(SCULPT_MATERIAL_PRESETS);
}

function resolveSculptPolish(input: SculptPolishInput | undefined, label = 'Sculpt.polish'): { color?: string; material: ShapeMaterialProps } {
  if (input === undefined) return { color: SCULPT_MATERIAL_PRESETS.ceramic.color, material: { ...SCULPT_MATERIAL_PRESETS.ceramic.material } };
  if (typeof input === 'string') {
    const preset = SCULPT_MATERIAL_PRESETS[input];
    if (!preset) {
      throw new Error(`${label}("${input}") is unknown. Known presets: ${knownSculptMaterialPresets().join(', ')}.`);
    }
    return { color: preset.color, material: { ...preset.material } };
  }
  if (!input || typeof input !== 'object') {
    throw new Error(`${label}() expects a material preset string or material properties object.`);
  }
  const { color, ...material } = input;
  return {
    ...(typeof color === 'string' ? { color } : {}),
    material: validateMaterialProps(material as ShapeMaterialProps),
  };
}

export type SculptLookPreset = 'gallery' | 'soft-studio' | 'candy-shop' | 'midnight' | 'workbench';

function sculptLook(preset: SculptLookPreset = 'gallery'): Record<string, unknown> {
  switch (preset) {
    case 'soft-studio':
      return {
        background: { top: '#f7f9fb', bottom: '#dfe7ef' },
        environment: { preset: 'studio', intensity: 1.25 },
        lights: [
          { type: 'ambient', color: '#ffffff', intensity: 0.2 },
          { type: 'directional', position: [90, -110, 150], color: '#ffffff', intensity: 1.4 },
          { type: 'directional', position: [-120, 70, 80], color: '#dcecff', intensity: 0.65 },
          { type: 'hemisphere', skyColor: '#d9edff', groundColor: '#f0e6d4', intensity: 0.45 },
        ],
        postProcessing: { toneMappingExposure: 1.12, vignette: { darkness: 0.16, offset: 0.6 } },
      };
    case 'candy-shop':
      return {
        background: { top: '#fff7fb', bottom: '#dff8ff' },
        environment: { preset: 'lobby', intensity: 1.35 },
        lights: [
          { type: 'ambient', color: '#ffffff', intensity: 0.18 },
          { type: 'point', position: [70, -60, 90], color: '#ff8ac8', intensity: 2.2, distance: 280, decay: 1.2 },
          { type: 'point', position: [-85, 80, 70], color: '#70e1ff', intensity: 1.8, distance: 260, decay: 1.4 },
          { type: 'directional', position: [30, -80, 140], color: '#fff6dd', intensity: 0.9 },
        ],
        postProcessing: { toneMappingExposure: 1.25, bloom: { intensity: 0.35, threshold: 0.78, radius: 0.45 } },
      };
    case 'midnight':
      return {
        background: { top: '#060814', bottom: '#101522' },
        environment: { preset: 'night', intensity: 1.1 },
        lights: [
          { type: 'ambient', color: '#10182a', intensity: 0.16 },
          { type: 'point', position: [80, -70, 100], color: '#6de7ff', intensity: 2.4, distance: 320, decay: 1.1 },
          { type: 'point', position: [-90, 70, 50], color: '#ff7ac8', intensity: 1.4, distance: 300, decay: 1.3 },
          { type: 'directional', position: [30, -30, 160], color: '#d7e9ff', intensity: 0.65 },
        ],
        fog: { color: '#060814', near: 180, far: 520 },
        postProcessing: { toneMappingExposure: 1.35, bloom: { intensity: 0.65, threshold: 0.65, radius: 0.6 } },
      };
    case 'workbench':
      return {
        background: '#f2f3f0',
        environment: { preset: 'warehouse', intensity: 1 },
        lights: [
          { type: 'ambient', color: '#ffffff', intensity: 0.28 },
          { type: 'directional', position: [80, -100, 130], color: '#fff5df', intensity: 1.25 },
          { type: 'hemisphere', skyColor: '#eef6ff', groundColor: '#d8d0c0', intensity: 0.35 },
        ],
        ground: { visible: true, color: '#d8d4ca', offset: 1, receiveShadow: true },
        postProcessing: { toneMappingExposure: 1.05 },
      };
    case 'gallery':
    default:
      return {
        background: { top: '#eef3f8', bottom: '#cfd9e3' },
        environment: { preset: 'studio', intensity: 1.4 },
        lights: [
          { type: 'ambient', color: '#ffffff', intensity: 0.18 },
          { type: 'directional', position: [110, -130, 150], color: '#ffffff', intensity: 1.5 },
          { type: 'directional', position: [-90, 80, 90], color: '#b8d8ff', intensity: 0.55 },
          { type: 'hemisphere', skyColor: '#ddefff', groundColor: '#e8e2d8', intensity: 0.45 },
        ],
        postProcessing: { toneMappingExposure: 1.18, vignette: { darkness: 0.18, offset: 0.55 } },
      };
  }
}

export interface SculptBoxOptions {
  radius?: number;
}

function resolveShapes(label: string, ...inputs: (SdfShape | SdfShape[] | undefined)[]): SdfShape[] {
  const out: SdfShape[] = [];
  for (const input of inputs) {
    if (input === undefined) continue;
    const arr = Array.isArray(input) ? input : [input];
    for (const s of arr) {
      if (!(s instanceof SdfShape)) throw new Error(`${label} expects SdfShape values.`);
      out.push(s);
    }
  }
  if (out.length === 0) throw new Error(`${label} requires at least one SdfShape.`);
  return out;
}

type SculptBlendArg = SdfShape | SdfShape[] | { radius?: number } | undefined;

/** Split mixed blend/keep arguments (shapes, arrays of shapes, and an options object). */
function splitShapesAndOptions(label: string, ...args: SculptBlendArg[]): { shapes: SdfShape[]; options?: { radius?: number } } {
  const shapes: SdfShape[] = [];
  let options: { radius?: number } | undefined;
  for (const arg of args) {
    if (arg === undefined) continue;
    if (arg instanceof SdfShape) {
      shapes.push(arg);
    } else if (Array.isArray(arg)) {
      for (const s of arg) {
        if (!(s instanceof SdfShape)) throw new Error(`${label} expects SdfShape values.`);
        shapes.push(s);
      }
    } else if (typeof arg === 'object') {
      options = arg;
    }
  }
  if (shapes.length === 0) throw new Error(`${label} requires at least one SdfShape.`);
  return { shapes, options };
}

/** A control point for Sculpt.tube()/curve(): `[x,y,z]`, `[x,y,z,radius]`, or `{ point: [x,y,z], radius? }`. */
export type SculptPoint = Vec3 | [number, number, number, number] | { point: Vec3; radius?: number };
export type SculptPointList = SculptPoint[];
export interface SculptTubeOptions {
  /** Default thread radius in mm when a point omits its own. Default: 3 */
  radius?: number;
  /** Smooth-union blend radius between segments. Default: derived from radius. */
  blend?: number;
  /** Smoothing samples per segment (accepted for path-authoring parity; advisory). */
  segments?: number;
  /** Catmull-Rom tension (accepted for path-authoring parity; advisory). */
  tension?: number;
}

/**
 * Build a smooth tube/sweep through a list of points. Each consecutive pair
 * becomes a capsule sized by the per-point radius (4th component) or the default
 * radius, smoothly blended together. Points are joined with spheres so corners
 * stay rounded.
 */
function sculptTube(points: SculptPointList, options?: SculptTubeOptions): SdfShape {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('Sculpt.tube() needs at least two points, e.g. [[0,0,0], [20,0,8,4], [40,0,0,2]].');
  }
  const defaultRadius = requirePositiveFinite(options?.radius ?? 3, 'Sculpt.tube() radius');
  const pts = points.map((p, i) => {
    // Object form: { point: [x, y, z], radius?: number }
    if (p && !Array.isArray(p) && typeof p === 'object' && Array.isArray((p as { point?: unknown }).point)) {
      const obj = p as { point: number[]; radius?: number };
      const r = obj.radius !== undefined ? requirePositiveFinite(obj.radius, `Sculpt.tube() point[${i}] radius`) : defaultRadius;
      return {
        x: requireFinite(obj.point[0], `Sculpt.tube() point[${i}].x`),
        y: requireFinite(obj.point[1], `Sculpt.tube() point[${i}].y`),
        z: requireFinite(obj.point[2], `Sculpt.tube() point[${i}].z`),
        r,
      };
    }
    const arr = p as number[];
    if (!Array.isArray(arr) || arr.length < 3)
      throw new Error(`Sculpt.tube() point[${i}] must be [x, y, z], [x, y, z, radius], or { point: [x, y, z], radius }.`);
    const r = arr.length >= 4 ? requirePositiveFinite(arr[3], `Sculpt.tube() point[${i}] radius`) : defaultRadius;
    return { x: requireFinite(arr[0], `Sculpt.tube() point[${i}].x`), y: requireFinite(arr[1], `Sculpt.tube() point[${i}].y`), z: requireFinite(arr[2], `Sculpt.tube() point[${i}].z`), r };
  });
  const blendRadius = options?.blend !== undefined ? requirePositiveFinite(options.blend, 'Sculpt.tube() blend') : defaultRadius * 0.5;

  const pieces: SdfShape[] = [];
  // Joint spheres at each control point.
  for (const p of pts) pieces.push(sphere(p.r).translate(p.x, p.y, p.z));
  // Capsule segments between consecutive points.
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) continue;
    const r = Math.min(a.r, b.r);
    // Capsule is along +Z, centered at origin: place it from a to b.
    let seg = capsule(len, r);
    // Rotate Z axis -> segment direction (axis = Z x dir, angle = acos(dz/len)).
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    const angle = (Math.acos(Math.max(-1, Math.min(1, uz))) * 180) / Math.PI;
    if (angle > 1e-4 && angle < 180 - 1e-4) {
      // Rotation axis = cross(Z, dir) = (-uy, ux, 0).
      seg = seg.rotate([-uy, ux, 0], angle);
    } else if (angle >= 180 - 1e-4) {
      seg = seg.rotate([1, 0, 0], 180);
    }
    // Capsule midpoint is the origin; move it to the segment midpoint.
    seg = seg.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    pieces.push(seg);
  }
  return pieces.slice(1).reduce((acc, p) => acc.smoothUnion(p, blendRadius), pieces[0]);
}

/** Sculpt-like facade: friendly liquid-modeling verbs backed by the same SDF kernel. */
export const Sculpt = {
  sphere: (radius: number): SdfShape => sphere(radius),
  box: (x: number, y: number, z: number, options?: SculptBoxOptions): SdfShape => {
    const b = box(x, y, z);
    return options?.radius !== undefined ? b.round(options.radius) : b;
  },
  cylinder: (height: number, radius: number): SdfShape => cylinder(height, radius),
  disk: (radius: number, thickness = 1): SdfShape => cylinder(thickness, radius),
  circle: (radius: number, thickness = 1): SdfShape => cylinder(thickness, radius),
  capsule: (height: number, radius: number): SdfShape => capsule(height, radius),
  torus: (majorRadius: number, minorRadius: number): SdfShape => torus(majorRadius, minorRadius),
  cone: (height: number, radius: number): SdfShape => cone(height, radius),
  tube: (points: SculptPointList, options?: SculptTubeOptions): SdfShape => sculptTube(points, options),
  curve: (points: SculptPointList, options?: SculptTubeOptions): SdfShape => sculptTube(points, options),
  path: (points: SculptPointList, options?: SculptTubeOptions): SdfShape => sculptTube(points, options),
  blend: (...args: SculptBlendArg[]): SdfShape => {
    const { shapes, options } = splitShapesAndOptions('Sculpt.blend()', ...args);
    const radius = resolveBlendRadius(options, 'Sculpt.blend()');
    return shapes.slice(1).reduce((acc, s) => acc.smoothUnion(s, radius), shapes[0]);
  },
  union: (first?: SdfShape | SdfShape[], ...rest: (SdfShape | SdfShape[])[]): SdfShape => {
    const shapes = resolveShapes('Sculpt.union()', first, ...rest);
    return shapes.slice(1).reduce((acc, s) => acc.union(s), shapes[0]);
  },
  carve: (base: SdfShape, cutters: SdfShape | SdfShape[], options?: { radius?: number }): SdfShape => {
    if (!(base instanceof SdfShape)) throw new Error('Sculpt.carve() base must be an SdfShape.');
    const cutterShapes = resolveShapes('Sculpt.carve()', cutters);
    const radius = resolveBlendRadius(options, 'Sculpt.carve()');
    return cutterShapes.reduce((acc, c) => acc.smoothSubtract(c, radius), base);
  },
  keep: (...args: SculptBlendArg[]): SdfShape => {
    const { shapes, options } = splitShapesAndOptions('Sculpt.keep()', ...args);
    const radius = resolveBlendRadius(options, 'Sculpt.keep()', 1);
    return shapes.slice(1).reduce((acc, s) => acc.smoothIntersect(s, radius), shapes[0]);
  },
  polish: (shape: SdfShape, input?: SculptPolishInput): SdfShape => {
    if (!(shape instanceof SdfShape)) throw new Error('Sculpt.polish() expects an SdfShape.');
    return shape.polish(input);
  },
  material: (input?: SculptPolishInput): ShapeMaterialProps & { color?: string } => {
    const resolved = resolveSculptPolish(input, 'Sculpt.material');
    return { ...(resolved.color !== undefined ? { color: resolved.color } : {}), ...resolved.material };
  },
  look: sculptLook,
  knownMaterials: knownSculptMaterialPresets,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireFinite(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number. Received: ${String(value)}`);
  }
  return value;
}

function requirePositiveFinite(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number. Received: ${String(value)}`);
  }
  return value;
}

function requireNonNegativeFinite(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number. Received: ${String(value)}`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer. Received: ${String(value)}`);
  }
  return value;
}

function normalizeVec2(value: number | [number, number], label: string, validate: (v: number, l: string) => number): [number, number] {
  if (typeof value === 'number') {
    const n = validate(value, label);
    return [n, n];
  }
  return [validate(value[0], `${label}[0]`), validate(value[1], `${label}[1]`)];
}

function normalizeDirection(value: [number, number], label: string): [number, number] {
  const x = requireFinite(value[0], `${label}[0]`);
  const y = requireFinite(value[1], `${label}[1]`);
  const len = Math.hypot(x, y);
  if (len <= 0) throw new Error(`${label} must not be the zero vector.`);
  return [x / len, y / len];
}

function resolveBlendRadius(input: number | { radius?: number } | undefined, label: string, fallback = 4): number {
  if (typeof input === 'number') return requirePositiveFinite(input, `${label} radius`);
  if (input?.radius !== undefined) return requirePositiveFinite(input.radius, `${label} radius`);
  return fallback;
}

function cloneBounds(bounds: SdfBounds): SdfBounds {
  return { min: [...bounds.min], max: [...bounds.max] };
}

function cloneVisualMetadata(metadata?: SdfVisualMetadata): SdfVisualMetadata {
  return {
    ...(metadata?.colorHex !== undefined ? { colorHex: metadata.colorHex } : {}),
    ...(metadata?.materialProps ? { materialProps: { ...metadata.materialProps } } : {}),
    ...(metadata?.bounds ? { bounds: cloneBounds(metadata.bounds) } : {}),
  };
}

function assertFiniteVec3(v: Vec3, label: string): void {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error(`${label} must be a finite [x, y, z] vector.`);
  }
}

function normalizeBoundsInput(minOrBounds: SdfBoundsInput | Vec3, max?: Vec3): SdfBounds {
  if (Array.isArray(minOrBounds) && Array.isArray(max)) {
    return { min: [...(minOrBounds as Vec3)], max: [...max] };
  }
  if (Array.isArray(minOrBounds) && minOrBounds.length === 2 && Array.isArray(minOrBounds[0]) && Array.isArray(minOrBounds[1])) {
    return { min: [...(minOrBounds[0] as Vec3)], max: [...(minOrBounds[1] as Vec3)] };
  }
  if (minOrBounds && typeof minOrBounds === 'object' && !Array.isArray(minOrBounds) && Array.isArray((minOrBounds as SdfBounds).min) && Array.isArray((minOrBounds as SdfBounds).max)) {
    const b = minOrBounds as SdfBounds;
    return { min: [...b.min], max: [...b.max] };
  }
  throw new Error('SdfShape.bounds() expects { min, max }, [min, max], or bounds(min, max).');
}

function validateBounds(bounds: SdfBounds): SdfBounds {
  assertFiniteVec3(bounds.min, 'bounds.min');
  assertFiniteVec3(bounds.max, 'bounds.max');
  for (let i = 0; i < 3; i++) {
    if (bounds.min[i] >= bounds.max[i]) {
      throw new Error('SdfShape.bounds() requires min values to be less than max values on every axis.');
    }
  }
  return bounds;
}

function validateMaterialProps(props: ShapeMaterialProps): ShapeMaterialProps {
  if (!props || typeof props !== 'object') {
    throw new Error('SdfShape.material() expects an object with material properties.');
  }
  const unitKeys: (keyof ShapeMaterialProps)[] = [
    'metalness',
    'roughness',
    'opacity',
    'clearcoat',
    'clearcoatRoughness',
    'transmission',
    'reflectivity',
    'specularIntensity',
  ];
  for (const key of unitKeys) {
    const value = (props as Record<string, unknown>)[key as string];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`material.${String(key)} must be between 0 and 1. Received: ${String(value)}`);
    }
  }
  return { ...props };
}

function formatExpressionNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const text = Number(value.toPrecision(12)).toString();
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

function roundedBoxNode(halfExtents: Vec3, radius: number): SdfNode {
  const minHalf = Math.min(halfExtents[0], halfExtents[1], halfExtents[2]);
  const r = Math.min(requirePositiveFinite(radius, 'SdfShape.round() radius'), Math.max(1e-3, minHalf - 1e-3));
  const inner: Vec3 = [halfExtents[0] - r, halfExtents[1] - r, halfExtents[2] - r];
  const [ix, iy, iz] = inner.map(formatExpressionNumber);
  const rr = formatExpressionNumber(r);
  const js = `Math.hypot(Math.max(Math.abs(x)-${ix},0),Math.max(Math.abs(y)-${iy},0),Math.max(Math.abs(z)-${iz},0)) + Math.min(Math.max(Math.abs(x)-${ix},Math.max(Math.abs(y)-${iy},Math.abs(z)-${iz})),0) - ${rr}`;
  return {
    kind: 'sdf:custom',
    functionBody: js,
    bounds: { min: [-halfExtents[0], -halfExtents[1], -halfExtents[2]], max: [halfExtents[0], halfExtents[1], halfExtents[2]] },
  };
}

/** Convert an axis-angle rotation to the Euler [x, y, z] degrees consumed by sdf:rotate. */
function axisAngleToEulerDegrees(axis: Vec3, angleDeg: number): Vec3 {
  assertFiniteVec3(axis, 'rotate() axis');
  requireFinite(angleDeg, 'rotate() angleDeg');
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (len <= 0) throw new Error('rotate() axis must not be the zero vector.');
  const [ux, uy, uz] = [axis[0] / len, axis[1] / len, axis[2] / len];
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  // Rotation matrix (row-major) from axis-angle.
  const m00 = t * ux * ux + c;
  const m01 = t * ux * uy - s * uz;
  const m02 = t * ux * uz + s * uy;
  const m10 = t * ux * uy + s * uz;
  const m12 = t * uy * uz - s * ux;
  const m20 = t * ux * uz - s * uy;
  const m21 = t * uy * uz + s * ux;
  const m22 = t * uz * uz + c;
  // Decompose Rz * Ry * Rx to Euler angles.
  const sy = Math.hypot(m00, m10);
  const singular = sy < 1e-6;
  const RAD = 180 / Math.PI;
  const xDeg = (singular ? Math.atan2(-m12, m22) : Math.atan2(m21, m22)) * RAD;
  const yDeg = Math.atan2(-m20, sy) * RAD;
  const zDeg = (singular ? 0 : Math.atan2(m10, m00)) * RAD;
  return [xDeg, yDeg, zDeg];
}

function autoEdgeLength(bounds: SdfBounds): number {
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const maxDim = Math.max(dx, dy, dz);
  // Target ~100 cells across the largest dimension
  return Math.max(0.1, maxDim / 100);
}

function extractFunctionBody(fn: Function): string {
  const src = fn.toString();
  // Arrow function: (x, y, z) => expr
  const arrowIdx = src.indexOf('=>');
  if (arrowIdx !== -1) {
    const body = src.slice(arrowIdx + 2).trim();
    // If it's a block body { ... }, strip the braces
    if (body.startsWith('{') && body.endsWith('}')) {
      return body.slice(1, -1).trim();
    }
    return body;
  }
  // Regular function: extract body between first { and last }
  const start = src.indexOf('{');
  const end = src.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    return src.slice(start + 1, end).trim();
  }
  throw new Error('sdf.fromFunction(): could not extract function body. Use an arrow function: (x, y, z) => ...');
}

/**
 * When intersecting children, detect voronoi nodes and inject the non-voronoi
 * siblings as `surfaceChild` for automatic membrane suppression.
 * Only injects if the voronoi doesn't already have a surfaceChild set.
 */
function injectVoronoiSurfaceChild(children: SdfNode[]): SdfNode[] {
  // Find voronoi nodes and non-voronoi "surface" nodes
  const voronoiIndices: number[] = [];
  const surfaceIndices: number[] = [];
  for (let i = 0; i < children.length; i++) {
    if (children[i].kind === 'sdf:voronoi') {
      voronoiIndices.push(i);
    } else {
      surfaceIndices.push(i);
    }
  }

  // No voronoi or no surface shape — nothing to inject
  if (voronoiIndices.length === 0 || surfaceIndices.length === 0) return children;

  // Don't inject if user explicitly disabled suppression (threshold = 0)
  const allDisabled = voronoiIndices.every((i) => {
    const v = children[i] as SdfVoronoiNode;
    return v.suppressionThreshold === 0;
  });
  if (allDisabled) return children;

  // Build a surface reference: if there's one surface node, use it directly;
  // if multiple, union them.
  let surfaceNode: SdfNode;
  if (surfaceIndices.length === 1) {
    surfaceNode = children[surfaceIndices[0]];
  } else {
    surfaceNode = { kind: 'sdf:union', children: surfaceIndices.map((i) => children[i]) };
  }

  // Clone and inject surfaceChild into each voronoi node that doesn't have one
  return children.map((child) => {
    if (child.kind === 'sdf:voronoi' && !child.surfaceChild) {
      return { ...child, surfaceChild: cloneSdfNode(surfaceNode) } as SdfVoronoiNode;
    }
    return child;
  });
}

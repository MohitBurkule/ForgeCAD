import { Shape, union } from '../kernel';
import { Curve3D } from './curves';
import {
  buildThickenedSurface,
  evalNurbsSurface,
  NurbsCurve3D,
  type NurbsSurfaceOptions,
  uniformClampedKnots,
} from './nurbs';

type Vec3 = [number, number, number];

/**
 * Exact curve inputs accepted by surfacing operations: a NURBS/Curve3D object or a
 * raw point polyline.
 */
export type ExactCurveInput = Curve3D | NurbsCurve3D | Vec3[];

export interface SurfaceCommonOptions {
  /** Default thin-sheet thickness used when the sheet is rendered without an explicit thicken(). */
  thickness?: number;
  /** Tessellation resolution per direction. Default 32. */
  resolution?: number;
}

export interface SurfacePlaneOptions {
  origin: Vec3;
  normal: Vec3;
  xAxis: Vec3;
  width: number;
  height: number;
  thickness?: number;
}

export interface SurfacePatchCurves {
  bottom: ExactCurveInput;
  top: ExactCurveInput;
  left: ExactCurveInput;
  right: ExactCurveInput;
}

export interface SurfaceCoonsPatchOptions extends SurfaceCommonOptions {}

export interface SurfaceSolidOptions {
  /** Validate the resulting solid is closed/manifold. Default false. */
  validate?: boolean;
  /** Sew tolerance. */
  tolerance?: number;
}

// ─── Vector helpers ───────────────────────────────────────────────────────────

function requireFinite(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${where}: expected a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function requireVec3(v: unknown, where: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => typeof c === 'number' && Number.isFinite(c))) {
    throw new Error(`${where}: expected a [x, y, z] vector of finite numbers, got ${JSON.stringify(v)}`);
  }
  return [v[0], v[1], v[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-9) throw new Error('Surface: degenerate (zero-length) direction vector.');
  return [v[0] / l, v[1] / l, v[2] / l];
}

function gridDiagonal(grid: Vec3[][]): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const row of grid) for (const p of row) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
}

// ─── Sheet registry ─────────────────────────────────────────────────────────────
//
// Surface.* builders return real, plan-backed Shapes (thin watertight sheet-solids).
// We remember the sampled point grid for each sheet so that `.thicken(t)` can rebuild
// the same surface at any wall thickness. This keeps the result a plain Shape (so the
// runner and all downstream transforms accept it) while still supporting open sheets.

const sheetGrids = new WeakMap<Shape, { grid: Vec3[][]; defaultThickness: number }>();

/** Build a sheet Shape from a sampled point grid and register it for later thicken(). */
function buildSheet(grid: Vec3[][], explicitThickness?: number): Shape {
  const defaultThickness = explicitThickness ?? Math.max(0.4, gridDiagonal(grid) / 220);
  const shape = buildThickenedSurface(grid, defaultThickness);
  sheetGrids.set(shape, { grid, defaultThickness });
  return shape;
}

/** Thicken a sheet (or any registered surface) to a target wall thickness. */
export function thickenSheet(shape: Shape, thickness: number): Shape {
  const t = requireFinite(thickness, 'Surface.thicken');
  if (!(t > 0)) throw new Error('Surface.thicken: thickness must be positive.');
  const registered = sheetGrids.get(shape);
  if (!registered) {
    throw new Error('Surface.thicken: this shape is not an open surface sheet. thicken() applies to Surface.* sheets.');
  }
  const out = buildThickenedSurface(registered.grid, t);
  sheetGrids.set(out, { grid: registered.grid, defaultThickness: t });
  return out;
}

function resampleCurve(input: ExactCurveInput, n: number): Vec3[] {
  if (Array.isArray(input)) {
    if (input.length < 2) throw new Error('Surface: curve polyline needs at least two points.');
    const pts = input.map((p, i) => requireVec3(p, `Surface: curve point ${i}`));
    // Resample the polyline to n points by arc-length-uniform index mapping.
    const out: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const f = (i / (n - 1)) * (pts.length - 1);
      const i0 = Math.floor(f);
      const i1 = Math.min(pts.length - 1, i0 + 1);
      out.push(add(scale(pts[i0], 1 - (f - i0)), scale(pts[i1], f - i0)));
    }
    return out;
  }
  if (input instanceof Curve3D) {
    const out: Vec3[] = [];
    for (let i = 0; i < n; i++) out.push(input.pointAt(i / (n - 1)));
    return out;
  }
  throw new Error('Surface: expected a Curve3D, NurbsCurve3D, or Vec3[] point list.');
}

// ─── Surface namespace ──────────────────────────────────────────────────────────

/**
 * Surfacing helpers — finite analytic and freeform sheets that can be thickened,
 * sewn into shells, and solidified into B-rep-style bodies.
 */
export const Surface = {
  /** Create a freeform NURBS sheet from a control-point grid. */
  Nurbs(controlGrid: Vec3[][], options: NurbsSurfaceOptions = {}): Shape {
    if (!Array.isArray(controlGrid) || controlGrid.length < 2) {
      throw new Error('Surface.Nurbs: controlGrid must have at least 2 rows.');
    }
    const cols = controlGrid[0].length;
    if (cols < 2) throw new Error('Surface.Nurbs: controlGrid rows must have at least 2 columns.');
    for (let i = 0; i < controlGrid.length; i++) {
      if (controlGrid[i].length !== cols) throw new Error('Surface.Nurbs: all rows must have the same length.');
      for (let j = 0; j < cols; j++) requireVec3(controlGrid[i][j], `Surface.Nurbs: control point [${i}][${j}]`);
    }
    const degreeU = Math.min(Math.floor(options.degreeU ?? 3), controlGrid.length - 1);
    const degreeV = Math.min(Math.floor(options.degreeV ?? 3), cols - 1);
    if (degreeU < 1 || degreeV < 1) throw new Error('Surface.Nurbs: degrees must be >= 1.');

    const weights = options.weights ?? controlGrid.map((row) => row.map(() => 1));
    const knotsU = options.knotsU ?? uniformClampedKnots(controlGrid.length, degreeU);
    const knotsV = options.knotsV ?? uniformClampedKnots(cols, degreeV);
    const res = Math.max(8, Math.floor(options.resolution ?? 32));

    const grid: Vec3[][] = [];
    for (let i = 0; i <= res; i++) {
      const row: Vec3[] = [];
      for (let j = 0; j <= res; j++) {
        row.push(evalNurbsSurface(controlGrid, weights, degreeU, degreeV, knotsU, knotsV, i / res, j / res));
      }
      grid.push(row);
    }
    return buildSheet(grid, options.thickness && options.thickness > 0 ? options.thickness : undefined);
  },

  /** Create a ruled sheet linearly interpolating between two boundary curves. */
  Ruled(curveA: ExactCurveInput, curveB: ExactCurveInput, options: SurfaceCommonOptions = {}): Shape {
    const res = Math.max(8, Math.floor(options.resolution ?? 32));
    const a = resampleCurve(curveA, res + 1);
    const b = resampleCurve(curveB, res + 1);
    const grid: Vec3[][] = [];
    for (let i = 0; i <= res; i++) {
      const v = i / res;
      const row: Vec3[] = [];
      for (let j = 0; j <= res; j++) {
        row.push(add(scale(a[j], 1 - v), scale(b[j], v)));
      }
      grid.push(row);
    }
    return buildSheet(grid, options.thickness && options.thickness > 0 ? options.thickness : undefined);
  },

  /** Create a Coons patch sheet bounded by four edge curves. */
  Patch(curves: SurfacePatchCurves, options: SurfaceCoonsPatchOptions = {}): Shape {
    if (curves == null || typeof curves !== 'object') {
      throw new Error('Surface.Patch: requires { bottom, top, left, right } boundary curves.');
    }
    const res = Math.max(8, Math.floor(options.resolution ?? 32));
    const n = res + 1;
    const bottom = resampleCurve(curves.bottom, n);
    const top = resampleCurve(curves.top, n);
    const left = resampleCurve(curves.left, n);
    const right = resampleCurve(curves.right, n);

    const c00 = bottom[0];
    const c10 = bottom[n - 1];
    const c01 = top[0];
    const c11 = top[n - 1];

    const grid: Vec3[][] = [];
    for (let vi = 0; vi < n; vi++) {
      const v = vi / (n - 1);
      const row: Vec3[] = [];
      for (let ui = 0; ui < n; ui++) {
        const u = ui / (n - 1);
        const lc = add(scale(bottom[ui], 1 - v), scale(top[ui], v));
        const ld = add(scale(left[vi], 1 - u), scale(right[vi], u));
        const bl = add(
          add(scale(c00, (1 - u) * (1 - v)), scale(c10, u * (1 - v))),
          add(scale(c01, (1 - u) * v), scale(c11, u * v)),
        );
        row.push(sub(add(lc, ld), bl));
      }
      grid.push(row);
    }
    return buildSheet(grid, options.thickness && options.thickness > 0 ? options.thickness : undefined);
  },

  /** Create a finite analytic plane sheet. */
  Plane(options: SurfacePlaneOptions): Shape {
    const origin = requireVec3(options?.origin, 'Surface.Plane.origin');
    const normal = normalize(requireVec3(options?.normal, 'Surface.Plane.normal'));
    const xAxis = normalize(requireVec3(options?.xAxis, 'Surface.Plane.xAxis'));
    const width = requireFinite(options?.width, 'Surface.Plane.width');
    const height = requireFinite(options?.height, 'Surface.Plane.height');
    if (!(width > 0) || !(height > 0)) throw new Error('Surface.Plane: width and height must be positive.');
    const yAxis = normalize(cross(normal, xAxis));

    const res = 2;
    const grid: Vec3[][] = [];
    for (let i = 0; i <= res; i++) {
      const u = (i / res - 0.5) * width;
      const row: Vec3[] = [];
      for (let j = 0; j <= res; j++) {
        const w = (j / res - 0.5) * height;
        row.push(add(origin, add(scale(xAxis, u), scale(yAxis, w))));
      }
      grid.push(row);
    }
    return buildSheet(grid, options.thickness && options.thickness > 0 ? options.thickness : undefined);
  },

  /** Sew surface faces into a single connected shell (mesh union of the faces). */
  Sew(shapes: Shape[], _options: { tolerance?: number } = {}): Shape {
    if (!Array.isArray(shapes) || shapes.length === 0) {
      throw new Error('Surface.Sew: requires a non-empty array of surface shapes.');
    }
    return unionShapes(shapes);
  },

  /** Sew surface faces (or consume a sewn shell) and produce a solid body. */
  Solid(input: Shape | Shape[], _options: SurfaceSolidOptions = {}): Shape {
    const shell = Array.isArray(input) ? unionShapes(input) : input;
    if (shell == null) throw new Error('Surface.Solid: requires a shell shape or array of faces.');
    // The sewn shell is already a watertight mesh solid; return it unchanged.
    return shell;
  },
};

// Augment Shape with thicken() so Surface.* sheets can be turned into solid walls.
// Only registered surface sheets carry a sampled grid; calling thicken() on any other
// Shape throws (no silent fallback).
declare module '../kernel' {
  interface Shape {
    /** Thicken an open Surface.* sheet into a solid wall of the given thickness. */
    thicken(thickness: number): Shape;
  }
}

if (!(Shape.prototype as { thicken?: unknown }).thicken) {
  (Shape.prototype as unknown as { thicken: (t: number) => Shape }).thicken = function thicken(
    this: Shape,
    thickness: number,
  ): Shape {
    return thickenSheet(this, thickness);
  };
}

/** Boolean-union a list of shapes into one connected body via the kernel union plan. */
function unionShapes(shapes: Shape[]): Shape {
  if (shapes.length === 1) return shapes[0];
  return union(...shapes);
}

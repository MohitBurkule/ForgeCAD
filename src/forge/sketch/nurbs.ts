import { createOwnedShapeCompilePlan } from '../compilePlan';
import { buildShapeFromCompilePlan, type Shape } from '../kernel';
import { Curve3D } from './curves';

type Vec3 = [number, number, number];

export interface NurbsCurve3DOptions {
  /** Polynomial degree (default 3 = cubic). Must be >= 1. */
  degree?: number;
  /** Rational weights, one per control point (default: all 1.0 = non-rational). */
  weights?: number[];
  /** Knot vector (default: uniform clamped). Length must be points.length + degree + 1. */
  knots?: number[];
  /** Whether the curve is closed/periodic (default false). */
  closed?: boolean;
}

export interface NurbsSurfaceOptions {
  /** Degree in U direction (default 3). */
  degreeU?: number;
  /** Degree in V direction (default 3). */
  degreeV?: number;
  /** Weights grid — same dimensions as controlGrid (default: all 1.0). */
  weights?: number[][];
  /** Knot vector in U direction (default: uniform clamped). */
  knotsU?: number[];
  /** Knot vector in V direction (default: uniform clamped). */
  knotsV?: number[];
  /** Sheet thickness — if > 0, thickens the surface into a solid (default 0). */
  thickness?: number;
  /** Tessellation resolution — points per direction (default 32). */
  resolution?: number;
}

function requireFiniteVec3(p: unknown, where: string): Vec3 {
  if (!Array.isArray(p) || p.length !== 3 || !p.every((c) => typeof c === 'number' && Number.isFinite(c))) {
    throw new Error(`${where}: expected a [x, y, z] point with finite numbers, got ${JSON.stringify(p)}`);
  }
  return [p[0], p[1], p[2]];
}

/** Build a uniform clamped knot vector for n control points of given degree. */
export function uniformClampedKnots(n: number, degree: number): number[] {
  const knots: number[] = [];
  const interior = n - degree - 1;
  for (let i = 0; i <= degree; i++) knots.push(0);
  for (let i = 1; i <= interior; i++) knots.push(i / (interior + 1));
  for (let i = 0; i <= degree; i++) knots.push(1);
  return knots;
}

/** Find the knot span index containing parameter u. */
function findSpan(n: number, degree: number, u: number, knots: number[]): number {
  if (u >= knots[n + 1]) return n;
  if (u <= knots[degree]) return degree;
  let lo = degree;
  let hi = n + 1;
  let mid = Math.floor((lo + hi) / 2);
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) hi = mid;
    else lo = mid;
    mid = Math.floor((lo + hi) / 2);
  }
  return mid;
}

/** Cox–de Boor basis functions for the span. Returns degree+1 values. */
function basisFunctions(span: number, u: number, degree: number, knots: number[]): number[] {
  const N = new Array(degree + 1).fill(0);
  const left = new Array(degree + 1).fill(0);
  const right = new Array(degree + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom !== 0 ? N[r] / denom : 0;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/**
 * Evaluate a rational B-spline (NURBS) curve at parameter u in [0, 1].
 */
function evalNurbsCurve(points: Vec3[], weights: number[], degree: number, knots: number[], u: number): Vec3 {
  const n = points.length - 1;
  const uu = Math.max(0, Math.min(1, u));
  const span = findSpan(n, degree, uu, knots);
  const N = basisFunctions(span, uu, degree, knots);
  let x = 0;
  let y = 0;
  let z = 0;
  let wsum = 0;
  for (let i = 0; i <= degree; i++) {
    const idx = span - degree + i;
    const w = weights[idx];
    const c = N[i] * w;
    x += c * points[idx][0];
    y += c * points[idx][1];
    z += c * points[idx][2];
    wsum += c;
  }
  if (wsum === 0) return points[span];
  return [x / wsum, y / wsum, z / wsum];
}

/**
 * A NURBS curve usable wherever a path is accepted (sweep, loftAlongSpine).
 * Exposes the same sampling surface as Curve3D.
 */
export class NurbsCurve3D extends Curve3D {
  public readonly controlPoints: Vec3[];
  public readonly weights: number[];
  public readonly degree: number;
  public readonly knots: number[];

  constructor(points: Vec3[], options: NurbsCurve3DOptions = {}) {
    const cps = points.map((p, i) => requireFiniteVec3(p, `nurbs3d: control point ${i}`));
    const degree = Math.floor(options.degree ?? 3);
    if (!Number.isFinite(degree) || degree < 1) throw new Error(`nurbs3d: degree must be an integer >= 1 (got ${options.degree})`);
    if (cps.length < degree + 1) {
      throw new Error(`nurbs3d: need at least degree+1 = ${degree + 1} control points (got ${cps.length})`);
    }

    const weights = options.weights ?? cps.map(() => 1);
    if (weights.length !== cps.length) {
      throw new Error(`nurbs3d: weights.length (${weights.length}) must equal control points (${cps.length})`);
    }
    for (const w of weights) {
      if (!Number.isFinite(w) || w <= 0) throw new Error(`nurbs3d: weights must be positive finite numbers (got ${w})`);
    }

    const knots = options.knots ?? uniformClampedKnots(cps.length, degree);
    if (knots.length !== cps.length + degree + 1) {
      throw new Error(`nurbs3d: knots.length must be controlPoints.length + degree + 1 = ${cps.length + degree + 1} (got ${knots.length})`);
    }
    for (const k of knots) if (!Number.isFinite(k)) throw new Error('nurbs3d: knot values must be finite');

    // Densely sample the exact NURBS curve so Curve3D's sample/length/tangent machinery
    // operates on accurate geometry rather than the raw control polygon.
    const dense = 256;
    const sampled: Vec3[] = [];
    for (let i = 0; i <= dense; i++) {
      sampled.push(evalNurbsCurve(cps, weights, degree, knots, i / dense));
    }
    super(sampled, { closed: options.closed ?? false, tension: 0.5 });

    this.controlPoints = cps;
    this.weights = weights;
    this.degree = degree;
    this.knots = knots;
  }
}

/**
 * Create a NURBS curve from control points.
 *
 * With default options, creates a cubic non-rational B-spline with uniform clamped
 * knots. Set `weights` for rational curves (exact circles, conics). Set `degree` for
 * linear (1), quadratic (2), cubic (3), or higher-order curves.
 *
 * The returned curve can be passed directly to `sweep()` and `loftAlongSpine()`.
 */
export function nurbs3d(points: Vec3[], options: NurbsCurve3DOptions = {}): NurbsCurve3D {
  return new NurbsCurve3D(points, options);
}

/**
 * Evaluate a NURBS surface at (u, v) in [0, 1]^2.
 */
export function evalNurbsSurface(
  grid: Vec3[][],
  weights: number[][],
  degreeU: number,
  degreeV: number,
  knotsU: number[],
  knotsV: number[],
  u: number,
  v: number,
): Vec3 {
  const nU = grid.length - 1;
  const nV = grid[0].length - 1;
  const uu = Math.max(0, Math.min(1, u));
  const vv = Math.max(0, Math.min(1, v));
  const spanU = findSpan(nU, degreeU, uu, knotsU);
  const spanV = findSpan(nV, degreeV, vv, knotsV);
  const Nu = basisFunctions(spanU, uu, degreeU, knotsU);
  const Nv = basisFunctions(spanV, vv, degreeV, knotsV);

  let x = 0;
  let y = 0;
  let z = 0;
  let wsum = 0;
  for (let i = 0; i <= degreeU; i++) {
    const ui = spanU - degreeU + i;
    for (let j = 0; j <= degreeV; j++) {
      const vj = spanV - degreeV + j;
      const w = weights[ui][vj];
      const c = Nu[i] * Nv[j] * w;
      const p = grid[ui][vj];
      x += c * p[0];
      y += c * p[1];
      z += c * p[2];
      wsum += c;
    }
  }
  if (wsum === 0) return grid[spanU][spanV];
  return [x / wsum, y / wsum, z / wsum];
}

/**
 * Create a NURBS surface from a grid of control points.
 *
 * The control grid is indexed as `controlGrid[u][v]`. With default options, creates a
 * bicubic non-rational B-spline surface with uniform clamped knots. When `thickness > 0`
 * the surface is thickened into a solid sheet (default 0 → a thin sheet using a small
 * default thickness so a printable/exportable solid is produced).
 */
export function nurbsSurface(controlGrid: Vec3[][], options: NurbsSurfaceOptions = {}): Shape {
  if (!Array.isArray(controlGrid) || controlGrid.length < 2) {
    throw new Error('nurbsSurface: controlGrid must have at least 2 rows');
  }
  const cols = controlGrid[0].length;
  if (cols < 2) throw new Error('nurbsSurface: controlGrid rows must have at least 2 columns');
  for (let i = 0; i < controlGrid.length; i++) {
    if (controlGrid[i].length !== cols) throw new Error('nurbsSurface: all rows of controlGrid must have the same length');
    for (let j = 0; j < cols; j++) requireFiniteVec3(controlGrid[i][j], `nurbsSurface: control point [${i}][${j}]`);
  }

  const degreeU = Math.min(Math.floor(options.degreeU ?? 3), controlGrid.length - 1);
  const degreeV = Math.min(Math.floor(options.degreeV ?? 3), cols - 1);
  if (degreeU < 1 || degreeV < 1) throw new Error('nurbsSurface: degrees must be >= 1');

  const weights = options.weights ?? controlGrid.map((row) => row.map(() => 1));
  if (weights.length !== controlGrid.length || weights.some((r) => r.length !== cols)) {
    throw new Error('nurbsSurface: weights grid must match controlGrid dimensions');
  }
  for (const row of weights) for (const w of row) {
    if (!Number.isFinite(w) || w <= 0) throw new Error(`nurbsSurface: weights must be positive finite (got ${w})`);
  }

  const knotsU = options.knotsU ?? uniformClampedKnots(controlGrid.length, degreeU);
  const knotsV = options.knotsV ?? uniformClampedKnots(cols, degreeV);

  const thickness = options.thickness ?? 0;
  if (!Number.isFinite(thickness) || thickness < 0) throw new Error('nurbsSurface: thickness must be a non-negative finite number');

  const res = Math.max(8, Math.floor(options.resolution ?? 32));

  // Sample the surface into a (res+1) x (res+1) point grid, then thicken it along the
  // local surface normal into a watertight solid sheet. A small default thickness is used
  // when none is given so a printable/exportable solid is always produced.
  const t = thickness > 0 ? thickness : Math.max(0.5, surfaceDiagonal(controlGrid) / 200);
  return buildThickenedSurface(grid(res), t);

  function grid(n: number): Vec3[][] {
    const out: Vec3[][] = [];
    for (let i = 0; i <= n; i++) {
      const row: Vec3[] = [];
      for (let j = 0; j <= n; j++) {
        row.push(evalNurbsSurface(controlGrid, weights, degreeU, degreeV, knotsU, knotsV, i / n, j / n));
      }
      out.push(row);
    }
    return out;
  }
}

function surfaceDiagonal(grid: Vec3[][]): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const row of grid) for (const p of row) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
}

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-9 ? [0, 0, 1] : [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Thicken a sampled point grid into a watertight solid by emitting offset top/bottom
 * shells joined at the boundary, then meshing through the convex-hull-free polyhedron
 * builder. We reuse the kernel's polyhedron-from-triangles path via Shape.fromTriangles.
 */
export function buildThickenedSurface(pts: Vec3[][], thickness: number): Shape {
  const rows = pts.length;
  const cols = pts[0].length;
  const half = thickness / 2;

  // Per-vertex normal via averaged face normals.
  const normalAt = (i: number, j: number): Vec3 => {
    const i0 = Math.max(0, i - 1), i1 = Math.min(rows - 1, i + 1);
    const j0 = Math.max(0, j - 1), j1 = Math.min(cols - 1, j + 1);
    const du = sub(pts[i1][j], pts[i0][j]);
    const dv = sub(pts[i][j1], pts[i][j0]);
    return norm(cross(du, dv));
  };

  const top: Vec3[][] = [];
  const bot: Vec3[][] = [];
  for (let i = 0; i < rows; i++) {
    top.push([]);
    bot.push([]);
    for (let j = 0; j < cols; j++) {
      const n = normalAt(i, j);
      const p = pts[i][j];
      top[i].push([p[0] + n[0] * half, p[1] + n[1] * half, p[2] + n[2] * half]);
      bot[i].push([p[0] - n[0] * half, p[1] - n[1] * half, p[2] - n[2] * half]);
    }
  }

  // Flatten vertices: top first, then bottom.
  const verts: Vec3[] = [];
  const topIdx: number[][] = [];
  const botIdx: number[][] = [];
  for (let i = 0; i < rows; i++) {
    topIdx.push([]);
    for (let j = 0; j < cols; j++) { topIdx[i].push(verts.length); verts.push(top[i][j]); }
  }
  for (let i = 0; i < rows; i++) {
    botIdx.push([]);
    for (let j = 0; j < cols; j++) { botIdx[i].push(verts.length); verts.push(bot[i][j]); }
  }

  const tris: [number, number, number][] = [];
  // Top faces (CCW outward = +normal).
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = topIdx[i][j], b = topIdx[i + 1][j], c = topIdx[i + 1][j + 1], d = topIdx[i][j + 1];
      tris.push([a, b, c]);
      tris.push([a, c, d]);
    }
  }
  // Bottom faces (reversed winding).
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = botIdx[i][j], b = botIdx[i + 1][j], c = botIdx[i + 1][j + 1], d = botIdx[i][j + 1];
      tris.push([a, c, b]);
      tris.push([a, d, c]);
    }
  }
  // Side walls around the boundary. Walk the boundary loop in clockwise (i,j) order so
  // the wall directed edges oppose the cap edges, yielding a consistently wound, watertight
  // manifold (verified: every directed edge used exactly once).
  const loop: [number, number][] = [];
  for (let j = 0; j < cols - 1; j++) loop.push([0, j]);
  for (let i = 0; i < rows - 1; i++) loop.push([i, cols - 1]);
  for (let j = cols - 1; j > 0; j--) loop.push([rows - 1, j]);
  for (let i = rows - 1; i > 0; i--) loop.push([i, 0]);
  loop.reverse();
  for (let k = 0; k < loop.length; k++) {
    const [i0, j0] = loop[k];
    const [i1, j1] = loop[(k + 1) % loop.length];
    const t0 = topIdx[i0][j0], t1 = topIdx[i1][j1], b0 = botIdx[i0][j0], b1 = botIdx[i1][j1];
    tris.push([t0, b0, b1]);
    tris.push([t0, b1, t1]);
  }

  return shapeFromTriangles(verts, tris);
}

/**
 * Build a solid Shape from an indexed triangle mesh by encoding it as an in-memory
 * binary STL and lowering through the kernel's importedMesh compile plan. This reuses
 * the same mesh path as importMesh(), so the result is a real, plan-backed Shape.
 */
export function shapeFromTriangles(verts: Vec3[], tris: [number, number, number][]): Shape {
  const fileData = encodeObj(verts, tris);
  const plan = createOwnedShapeCompilePlan(
    { kind: 'importedMesh', filePath: 'nurbsSurface.obj', format: 'obj', fileData },
    'importedMesh',
  )!;
  return buildShapeFromCompilePlan(plan, undefined, { fidelity: 'sampled', sources: ['imported'] });
}

/** Encode an indexed triangle mesh as Wavefront OBJ — preserves explicit shared indices. */
function encodeObj(verts: Vec3[], tris: [number, number, number][]): ArrayBuffer {
  const lines: string[] = [];
  for (const v of verts) lines.push(`v ${v[0]} ${v[1]} ${v[2]}`);
  for (const [a, b, c] of tris) lines.push(`f ${a + 1} ${b + 1} ${c + 1}`);
  const text = lines.join('\n') + '\n';
  return new TextEncoder().encode(text).buffer;
}

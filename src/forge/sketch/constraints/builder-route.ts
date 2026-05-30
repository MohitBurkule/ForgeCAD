/**
 * High-level route() method for ConstrainedSketchBuilder.
 * Expands a sequence of geometric elements (lines, circles, fillets, tangent arcs)
 * into constrained sketch entities with proper tangency/coincident constraints.
 *
 * Augments the prototype via side-effect import from index.ts.
 */
import type { ArcId, CircleId, LineId, PointId } from './types';
import { ConstrainedSketchBuilder } from './builder';
import { routePerimeter, type PerimeterStep } from '../path';

// ── Route step types ────────────────────────────────────────────────────────

/** A construction line defined by axis and offset. */
export interface RouteLine {
  /** 'x' for vertical line at x=offset, 'y' for horizontal line at y=offset */
  axis: 'x' | 'y';
  offset: number;
}

/** A construction circle for routing. */
export interface RouteCircle {
  center: [number, number];
  radius: number;
}

/** Reference to a named or existing line/circle in the sketch. */
export interface RouteRef {
  ref: LineId | CircleId;
}

/** Tangent entry onto a construction circle. */
export interface RouteTangent {
  tangent: RouteCircle | CircleId;
}

/** Fillet arc connecting two adjacent route segments. */
export interface RouteFillet {
  fillet: number;
  /** When 'tangent', adds a tangent line from the smaller circle before the fillet arc. */
  approach?: 'tangent';
}

/** Free tangent arc (solver finds center). */
export interface RouteTangentArc {
  tangentArc: number; // radius
}

/** A point to route through. */
export interface RoutePoint {
  point: [number, number];
}

/** Clip a line to a specific coordinate. */
export interface RouteUntil {
  line: RouteLine | LineId;
  until: number; // The coordinate value to clip to (y for vertical, x for horizontal)
}

export type RouteStep = RouteLine | RouteCircle | CircleId | RouteTangent | RouteFillet | RouteTangentArc | RoutePoint | RouteUntil;

// ── Type guards ─────────────────────────────────────────────────────────────

function isRouteLine(s: RouteStep): s is RouteLine {
  return typeof s === 'object' && 'axis' in s && 'offset' in s;
}

function isCircleId(s: RouteStep): s is CircleId {
  return typeof s === 'string';
}

function isRouteCircle(s: RouteStep): s is RouteCircle {
  return typeof s === 'object' && 'center' in s && 'radius' in s;
}

function isRouteTangent(s: RouteStep): s is RouteTangent {
  return typeof s === 'object' && 'tangent' in s;
}

function isRouteFillet(s: RouteStep): s is RouteFillet {
  return typeof s === 'object' && 'fillet' in s;
}

function isRouteTangentArc(s: RouteStep): s is RouteTangentArc {
  return typeof s === 'object' && 'tangentArc' in s;
}

function isRoutePoint(s: RouteStep): s is RoutePoint {
  return typeof s === 'object' && 'point' in s;
}

function isRouteUntil(s: RouteStep): s is RouteUntil {
  return typeof s === 'object' && 'line' in s && 'until' in s;
}

// ── Typed factory functions ──────────────────────────────────────────────────

/** Typed factory functions for route steps. Provides autocomplete and type safety. */
export const routeStepFactories = {
  /** Construction circle for routing. */
  circle(center: [number, number], radius: number): RouteCircle {
    return { center, radius };
  },
  /** Fillet arc connecting adjacent elements. */
  fillet(radius: number, approach?: 'tangent'): RouteFillet {
    return approach ? { fillet: radius, approach } : { fillet: radius };
  },
  /** Tangent entry onto a construction circle. */
  tangent(circle: RouteCircle | CircleId): RouteTangent {
    return { tangent: circle };
  },
  /** Free tangent arc (solver finds center). */
  tangentArc(radius: number): RouteTangentArc {
    return { tangentArc: radius };
  },
  /** Route through a specific point. */
  point(xy: [number, number]): RoutePoint {
    return { point: xy };
  },
  /** Construction line. */
  line(axis: 'x' | 'y', offset: number): RouteLine {
    return { axis, offset };
  },
  /** Follow a line clipped to a coordinate. */
  until(line: RouteLine | LineId, value: number): RouteUntil {
    return { line, until: value };
  },
};

// ── Internal types for the routing algorithm ─────────────────────────────────

/**
 * A resolved segment in the route: either a line segment or an arc.
 * These are the "bones" that the router connects with fillets/tangent arcs.
 */
type ResolvedSegment =
  | { kind: 'lineSeg'; lineId: LineId; startPt: PointId; endPt: PointId }
  | {
      kind: 'circleArc';
      circleId: CircleId;
      center: [number, number];
      radius: number;
      entryPt: PointId;
      exitPt: PointId;
      arcId: ArcId;
    };

// ── Declare the method on the builder ────────────────────────────────────────

declare module './builder' {
  interface ConstrainedSketchBuilder {
    /**
     * Route a profile through a sequence of geometric elements.
     * The solver computes all tangent points and intersections automatically.
     *
     * Steps can include:
     * - `{ point: [x, y] }` — route through a point
     * - `{ axis: 'x'|'y', offset: n }` — follow a construction line
     * - `{ line: {...}, until: n }` — follow a line clipped to a coordinate
     * - `{ tangent: { center, radius } }` — tangent arc onto a construction circle
     * - `{ fillet: radius }` — fillet between adjacent elements
     * - `{ tangentArc: radius }` — free tangent arc (solver finds center)
     *
     * Returns `this` for chaining. Call `.solve()` after to get the Sketch.
     */
    route(steps: RouteStep[]): this;
    /** Directional (turtle-graphics) route builder starting at (x, y). */
    route(x: number, y: number): RouteBuilder;
    /** Directional route builder starting at an existing point. */
    route(startPt: PointId): RouteBuilder;
  }
}

// ── Directional RouteBuilder (turtle-graphics path API) ──────────────────────

type RouteSegment =
  | { kind: 'line'; id: LineId; startPt: PointId; endPt: PointId }
  | { kind: 'arc'; id: ArcId; startPt: PointId; endPt: PointId };

/**
 * Describe a sketch profile with directional moves (up/down/left/right/arcLeft/
 * arcRight). Each move returns the entity ID (`LineId` or `ArcId`) so it can be
 * referenced in `sk.*` constraints. Lengths are optional — when omitted the
 * solver determines them from the surrounding constraints.
 */
export class RouteBuilder {
  private sk: any;
  private _startPt: PointId;
  private cursorPt: PointId;
  private cursorX: number;
  private cursorY: number;
  /** Travel direction in radians from +X. null until the first segment. */
  private direction: number | null = null;
  private segments: RouteSegment[] = [];
  private lastLineId: LineId | null = null;
  private lastArcId: ArcId | null = null;
  private finished = false;

  constructor(sk: any, startPt: PointId, x: number, y: number) {
    this.sk = sk;
    this._startPt = startPt;
    this.cursorPt = startPt;
    this.cursorX = x;
    this.cursorY = y;
  }

  /** Vertical line going +Y. Length optional (solver determines it). */
  up(length?: number): LineId {
    return this._addLine(Math.PI / 2, length);
  }
  /** Vertical line going -Y. Length optional. */
  down(length?: number): LineId {
    return this._addLine(-Math.PI / 2, length);
  }
  /** Horizontal line going +X. Length optional. */
  right(length?: number): LineId {
    return this._addLine(0, length);
  }
  /** Horizontal line going -X. Length optional. */
  left(length?: number): LineId {
    return this._addLine(Math.PI, length);
  }
  /** Line at an arbitrary angle (degrees from +X). Length optional. */
  lineAt(angleDeg: number, length?: number): LineId {
    return this._addLine((angleDeg * Math.PI) / 180, length);
  }
  /** Line with solver-determined direction (tangent to previous arc / constraints). */
  line(length?: number): LineId {
    return this._addLine(this.direction ?? 0, length, false);
  }
  /** Line toward a specific point. Length defaults to the distance to that point. */
  toward(x: number, y: number): LineId {
    const dx = x - this.cursorX;
    const dy = y - this.cursorY;
    return this._addLine(Math.atan2(dy, dx), Math.hypot(dx, dy));
  }

  /** Tangent arc turning left relative to travel direction. */
  arcLeft(radius?: number, sweepDegOrOpts?: number | { minSweep: number }): ArcId {
    if (typeof sweepDegOrOpts === 'object') {
      return this._addArc('left', radius, undefined, sweepDegOrOpts.minSweep);
    }
    return this._addArc('left', radius, sweepDegOrOpts);
  }
  /** Tangent arc turning right relative to travel direction. */
  arcRight(radius?: number, sweepDegOrOpts?: number | { minSweep: number }): ArcId {
    if (typeof sweepDegOrOpts === 'object') {
      return this._addArc('right', radius, undefined, sweepDegOrOpts.minSweep);
    }
    return this._addArc('right', radius, sweepDegOrOpts);
  }

  /** Close the route with an explicit straight line back to the start point. */
  close(): void {
    this._ensureNotFinished();
    if (this.cursorPt === this._startPt) {
      this.finished = true;
      this._registerLoop();
      return;
    }
    const closingLine = this.sk.line(this.cursorPt, this._startPt);
    this.segments.push({ kind: 'line', id: closingLine, startPt: this.cursorPt, endPt: this._startPt });
    if (this.lastArcId) this.sk.lineTangentArc(closingLine, this.lastArcId, false);
    if (this.segments.length > 1 && this.segments[0].kind === 'arc') {
      this.sk.lineTangentArc(closingLine, this.segments[0].id, true);
    }
    this.finished = true;
    this._registerLoop();
  }

  /**
   * Close the route back to its start point and register it as a profile loop.
   * No extra line segment is added; a coincident constraint joins the last
   * point to the start, with tangency added for G1 smoothness at the junction.
   */
  done(): void {
    this._ensureNotFinished();
    if (this.cursorPt !== this._startPt && this.segments.length > 0) {
      const sk = this.sk;
      sk.coincident(this.cursorPt, this._startPt);
      const cId = sk.constraints[sk.constraints.length - 1]?.id;
      if (cId) sk._routeClosureConstraintId = cId;
      const first = this.segments[0];
      const last = this.segments[this.segments.length - 1];
      if (last.kind === 'arc' && first.kind === 'arc') {
        sk.arcTangentArc(last.id, first.id);
      } else if (last.kind === 'arc' && first.kind === 'line') {
        sk.lineTangentArc(first.id, last.id, false);
      } else if (last.kind === 'line' && first.kind === 'arc') {
        sk.lineTangentArc(last.id, first.id, true);
      }
    }
    this.finished = true;
    this._registerLoop();
  }

  /** PointId of the route's start point. */
  get start(): PointId {
    return this._startPt;
  }
  /** PointId of the current cursor (route's end). */
  get end(): PointId {
    return this.cursorPt;
  }
  /** Start point of a segment created by this route. */
  startOf(segId: LineId | ArcId): PointId {
    const seg = this.segments.find((s) => s.id === segId);
    if (!seg) throw new Error(`RouteBuilder.startOf(): segment "${segId}" not found in this route`);
    return seg.startPt;
  }
  /** End point of a segment created by this route. */
  endOf(segId: LineId | ArcId): PointId {
    const seg = this.segments.find((s) => s.id === segId);
    if (!seg) throw new Error(`RouteBuilder.endOf(): segment "${segId}" not found in this route`);
    return seg.endPt;
  }

  private _addLine(angle: number, length?: number, constrainDirection = true): LineId {
    this._ensureNotFinished();
    const sk = this.sk;
    angle = this._normalizeAngle(angle);
    const effectiveLength = length ?? 20;
    const endX = this.cursorX + Math.cos(angle) * effectiveLength;
    const endY = this.cursorY + Math.sin(angle) * effectiveLength;
    const endPt = sk.point(endX, endY);
    const lineId = sk.line(this.cursorPt, endPt);
    if (constrainDirection) {
      if (this._isVertical(angle)) sk.vertical(lineId);
      else if (this._isHorizontal(angle)) sk.horizontal(lineId);
      else sk.absoluteAngle(lineId, (angle * 180) / Math.PI);
    }
    if (length != null) sk.length(lineId, length);
    if (this.lastArcId) sk.lineTangentArc(lineId, this.lastArcId, false);
    this.segments.push({ kind: 'line', id: lineId, startPt: this.cursorPt, endPt });
    this.lastLineId = lineId;
    this.lastArcId = null;
    this.cursorPt = endPt;
    this.cursorX = endX;
    this.cursorY = endY;
    this.direction = angle;
    return lineId;
  }

  private _addArc(turn: 'left' | 'right', radius?: number, sweepDeg?: number, seedSweepDeg?: number): ArcId {
    this._ensureNotFinished();
    const sk = this.sk;
    const dir = this.direction ?? Math.PI / 2;
    const isLeft = turn === 'left';
    const effectiveRadius = radius ?? 10;
    const seedOrSweep = seedSweepDeg ?? sweepDeg;
    const sweepRad = seedOrSweep != null ? (seedOrSweep * Math.PI) / 180 : Math.PI / 2;
    const perpAngle = isLeft ? dir + Math.PI / 2 : dir - Math.PI / 2;
    const cx = this.cursorX + effectiveRadius * Math.cos(perpAngle);
    const cy = this.cursorY + effectiveRadius * Math.sin(perpAngle);
    const startAngle = Math.atan2(this.cursorY - cy, this.cursorX - cx);
    const exitAngle = isLeft ? startAngle + sweepRad : startAngle - sweepRad;
    const exitX = cx + effectiveRadius * Math.cos(exitAngle);
    const exitY = cy + effectiveRadius * Math.sin(exitAngle);
    const exitDir = isLeft ? dir + sweepRad : dir - sweepRad;
    const centerPt = sk.point(cx, cy);
    const exitPt = sk.point(exitX, exitY);
    if (radius != null) {
      const circleId = sk.circle(centerPt, effectiveRadius, true);
      sk.radius(circleId, radius);
      sk.pointOnCircle(this.cursorPt, circleId);
      sk.pointOnCircle(exitPt, circleId);
    }
    const clockwise = !isLeft;
    const arcId = sk.arcByCenter(centerPt, this.cursorPt, exitPt, clockwise);
    if (sweepDeg != null && radius != null) {
      sk.arcLength(arcId, ((sweepDeg * Math.PI) / 180) * radius);
    }
    if (this.lastLineId) sk.lineTangentArc(this.lastLineId, arcId, true);
    else if (this.lastArcId) sk.arcTangentArc(this.lastArcId, arcId);
    this.segments.push({ kind: 'arc', id: arcId, startPt: this.cursorPt, endPt: exitPt });
    this.lastArcId = arcId;
    this.lastLineId = null;
    this.cursorPt = exitPt;
    this.cursorX = exitX;
    this.cursorY = exitY;
    this.direction = this._normalizeAngle(exitDir);
    return arcId;
  }

  private _ensureNotFinished(): void {
    if (this.finished) {
      throw new Error('RouteBuilder: cannot add segments after close() or done()');
    }
  }

  private _registerLoop(): void {
    if (this.segments.length === 0) return;
    const profileSegs = this.segments.map((seg) =>
      seg.kind === 'line' ? { kind: 'line' as const, line: seg.id } : { kind: 'arc' as const, arc: seg.id },
    );
    this.sk.addProfileLoop(profileSegs);
  }

  private _normalizeAngle(a: number): number {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  }
  private _isVertical(angle: number): boolean {
    const a = this._normalizeAngle(angle);
    return Math.abs(Math.abs(a) - Math.PI / 2) < 1e-9;
  }
  private _isHorizontal(angle: number): boolean {
    const a = this._normalizeAngle(angle);
    return Math.abs(a) < 1e-9 || Math.abs(Math.abs(a) - Math.PI) < 1e-9;
  }
}

const proto = ConstrainedSketchBuilder.prototype as any;

/**
 * Estimate a point on a circle in the direction of a target position.
 * Used for initial tangent point placement before the solver refines.
 */
function estimatePointOnCircle(cx: number, cy: number, r: number, towardX: number, towardY: number, offsetRad = 0): [number, number] {
  const dx = towardX - cx;
  const dy = towardY - cy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return [cx + r * Math.cos(offsetRad), cy + r * Math.sin(offsetRad)];
  const angle = Math.atan2(dy, dx) + offsetRad;
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

/**
 * Estimate a fillet arc center position between two points.
 */
function estimateFilletCenter(x1: number, y1: number, x2: number, y2: number, filletR: number): [number, number] {
  // Place center perpendicular to the midpoint, offset inward
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return [mx + filletR, my];
  // Perpendicular direction (left of segment)
  const px = -dy / d;
  const py = dx / d;
  // Offset by sqrt(r² - (d/2)²) or just r if segment is short
  const halfD = d / 2;
  const h = filletR > halfD ? Math.sqrt(filletR * filletR - halfD * halfD) : filletR * 0.5;
  return [mx + px * h, my + py * h];
}

proto.route = function (this: any, stepsOrX: RouteStep[] | number | PointId, y?: number): any {
  // ─── Directional RouteBuilder overloads ──────────────────────────────────
  if (typeof stepsOrX === 'number') {
    if (y == null) throw new Error('route(x, y): y coordinate is required');
    const startPt = this.point(stepsOrX, y, true);
    return new RouteBuilder(this, startPt, stepsOrX, y);
  }
  if (typeof stepsOrX === 'string') {
    const pt = this.getPoint(stepsOrX);
    if (!pt) throw new Error(`route(): point "${stepsOrX}" not found in sketch`);
    return new RouteBuilder(this, stepsOrX, pt.x, pt.y);
  }

  const steps = stepsOrX;
  if (steps.length < 2) throw new Error('route(): need at least 2 steps');

  // ─── Resolve CircleId steps → RouteCircle using the builder's circles ──
  const resolveCircleStep = (s: RouteStep): RouteStep => {
    if (!isCircleId(s)) return s;
    const circ = this.circles.find((c: any) => c.id === s);
    if (!circ) throw new Error(`route(): circle "${s}" not found in sketch`);
    const center = this.getPoint(circ.center);
    if (!center) throw new Error(`route(): center point for circle "${s}" not found`);
    return { center: [center.x, center.y] as [number, number], radius: circ.radius };
  };
  const resolved = steps.map(resolveCircleStep);

  // ─── Fast path: closed circle+fillet loops use analytical geometry ────
  // Detect: even-length, alternating circles and fillets
  const isClosedCircleFillet =
    resolved.length >= 4 && resolved.length % 2 === 0 && resolved.every((s, i) => (i % 2 === 0 ? isRouteCircle(s) : isRouteFillet(s)));

  if (isClosedCircleFillet) {
    // Convert to PerimeterStep format and use routePerimeter
    const perimeterSteps: PerimeterStep[] = resolved.map((s, i) => {
      if (i % 2 === 0) {
        const c = s as RouteCircle;
        return { center: c.center, radius: c.radius };
      }
      const f = s as RouteFillet;
      return { fillet: f.fillet, approach: f.approach };
    });
    // Store the analytical result — solve() will return it
    this._routeSketch = routePerimeter(perimeterSteps);
    return this;
  }

  // ─── General solver-based path for mixed step types ───────────────────
  // Structural: points, lines, line-until, circles/tangent circles
  // Connectors: fillets, tangent arcs (inserted between structural elements)

  // We'll build the profile incrementally. The approach:
  // 1. Walk through steps, creating points/entities for each structural element
  // 2. For connectors (fillet, tangentArc), create intermediate arc entities with
  //    tangency constraints to neighboring elements
  // 3. Wire everything with coincident constraints at junctions
  // 4. Register the profile loop

  // Pre-compute centroid of structural circle centers for exterior arc direction selection
  let centroidX = 0,
    centroidY = 0,
    circleCount = 0;
  for (const s of steps) {
    const pos = isRouteCircle(s)
      ? s.center
      : isRouteTangent(s) && typeof s.tangent === 'object' && 'center' in s.tangent
        ? s.tangent.center
        : null;
    if (pos) {
      centroidX += pos[0];
      centroidY += pos[1];
      circleCount++;
    }
  }
  if (circleCount > 0) {
    centroidX /= circleCount;
    centroidY /= circleCount;
  }

  const segments: Array<{
    kind: 'line' | 'arc';
    id: LineId | ArcId;
    startPt: PointId;
    endPt: PointId;
  }> = [];

  let cursorPt: PointId | null = null;
  let cursorX = 0;
  let cursorY = 0;
  // Track the last line created for lineTangentArc constraints
  let lastLineId: LineId | null = null;
  // Track the last arc created for arcTangentArc constraints
  let lastArcId: ArcId | null = null;
  // Track first element for closing closed loops
  let firstEntryPt: PointId | null = null;
  let firstArcId: ArcId | null = null;

  const getCursorPos = (): [number, number] => {
    if (cursorPt) {
      const p = this.getPoint(cursorPt);
      if (p) return [p.x, p.y];
    }
    return [cursorX, cursorY];
  };

  // Helper: find the approximate position of a structural element
  const structuralPos = (s: RouteStep): [number, number] | null => {
    if (isRoutePoint(s)) return s.point;
    if (isRouteCircle(s)) return s.center;
    if (isRouteTangent(s)) {
      const t = s.tangent;
      if (typeof t === 'object' && 'center' in t) return t.center;
    }
    if (isRouteUntil(s)) {
      const ln = s.line;
      if (typeof ln === 'object' && 'axis' in ln) {
        return ln.axis === 'x' ? [ln.offset, s.until] : [s.until, ln.offset];
      }
    }
    if (isRouteLine(s)) {
      const [cx, cy] = getCursorPos();
      return s.axis === 'x' ? [s.offset, cy] : [cx, s.offset];
    }
    return null;
  };

  // Look ahead to find the next structural element's approximate position (wraps for closed loops)
  const peekNextStructuralPos = (fromIndex: number): [number, number] | null => {
    for (let k = 1; k < steps.length; k++) {
      const j = (fromIndex + k) % steps.length;
      const pos = structuralPos(steps[j]);
      if (pos) return pos;
    }
    return null;
  };

  // Look backward to find the previous structural element (wraps for closed loops)
  const peekPrevStructuralPos = (fromIndex: number): [number, number] | null => {
    for (let k = 1; k < steps.length; k++) {
      const j = (fromIndex - k + steps.length) % steps.length;
      const pos = structuralPos(steps[j]);
      if (pos) return pos;
    }
    return null;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (isRoutePoint(step)) {
      // ─── Point: create and connect ─────────────────────────────────
      const [px, py] = step.point;
      const ptId = this.point(px, py);

      if (cursorPt) {
        // Connect with a line from cursor to this point
        const lineId = this.line(cursorPt, ptId);
        segments.push({ kind: 'line', id: lineId, startPt: cursorPt, endPt: ptId });
        lastLineId = lineId;
        lastArcId = null;
      }

      cursorPt = ptId;
      cursorX = px;
      cursorY = py;
    } else if (isRouteLine(step)) {
      // ─── Bare line: create a construction line segment ─────────────
      // We need to figure out start and end points. The start is the cursor;
      // the end is determined by the next element.
      if (!cursorPt) throw new Error('route(): line step requires a preceding point or element');

      const nextPos = peekNextStructuralPos(i);
      const [cx, cy] = getCursorPos();

      let endX: number, endY: number;
      if (step.axis === 'x') {
        // Vertical line at x=offset. We move along Y.
        endX = step.offset;
        endY = nextPos ? nextPos[1] : cy + 50; // approximate
        // Also fix cursor X to the line offset
        if (Math.abs(cx - step.offset) > 1e-6) {
          this.fix(cursorPt, step.offset);
        }
      } else {
        // Horizontal line at y=offset. We move along X.
        endX = nextPos ? nextPos[0] : cx + 50;
        endY = step.offset;
        if (Math.abs(cy - step.offset) > 1e-6) {
          this.fix(cursorPt, undefined, step.offset);
        }
      }

      const endPtId = this.point(endX, endY);
      const lineId = this.line(cursorPt, endPtId);

      if (step.axis === 'x') {
        this.vertical(lineId);
      } else {
        this.horizontal(lineId);
      }

      segments.push({ kind: 'line', id: lineId, startPt: cursorPt, endPt: endPtId });
      lastLineId = lineId;
      lastArcId = null;
      cursorPt = endPtId;
      cursorX = endX;
      cursorY = endY;
    } else if (isRouteUntil(step)) {
      // ─── Line until: follow a line clipped to a coordinate ──────────
      if (!cursorPt) throw new Error('route(): line-until step requires a preceding element');

      const ln = step.line;
      let axis: 'x' | 'y';
      let offset: number;
      if (typeof ln === 'object' && 'axis' in ln) {
        axis = ln.axis;
        offset = ln.offset;
      } else {
        throw new Error('route(): line-until requires a RouteLine object (not a LineId reference yet)');
      }

      const [cx, cy] = getCursorPos();
      let endX: number, endY: number;

      if (axis === 'x') {
        // Vertical line at x=offset, go until y=step.until
        endX = offset;
        endY = step.until;
        // Fix cursor x to the line's offset if needed
        if (Math.abs(cx - offset) > 0.5) {
          // Cursor is not on the line — add a line to get there first
          const onLinePt = this.point(offset, cy);
          const connLine = this.line(cursorPt, onLinePt);
          segments.push({ kind: 'line', id: connLine, startPt: cursorPt, endPt: onLinePt });
          cursorPt = onLinePt;
        }
      } else {
        // Horizontal line at y=offset, go until x=step.until
        endX = step.until;
        endY = offset;
        if (Math.abs(cy - offset) > 0.5) {
          const onLinePt = this.point(cx, offset);
          const connLine = this.line(cursorPt, onLinePt);
          segments.push({ kind: 'line', id: connLine, startPt: cursorPt, endPt: onLinePt });
          cursorPt = onLinePt;
        }
      }

      const endPtId = this.point(endX, endY, true); // fixed endpoint
      const lineId = this.line(cursorPt!, endPtId);

      if (axis === 'x') {
        this.vertical(lineId);
      } else {
        this.horizontal(lineId);
      }

      segments.push({ kind: 'line', id: lineId, startPt: cursorPt!, endPt: endPtId });
      lastLineId = lineId;
      lastArcId = null;
      cursorPt = endPtId;
      cursorX = endX;
      cursorY = endY;
    } else if (isRouteTangent(step)) {
      // ─── Tangent to circle: create arc on circle with tangency ──────

      let cx: number, cy: number, r: number;
      let circleId: CircleId;

      const t = step.tangent;
      if (typeof t === 'string') {
        // It's a CircleId reference
        circleId = this.resolveCircleId(t);
        const circ = this.circles.find((c: any) => c.id === circleId);
        const center = this.getPoint(circ.center);
        cx = center.x;
        cy = center.y;
        r = circ.radius;
      } else {
        // It's a RouteCircle — create a construction circle
        cx = t.center[0];
        cy = t.center[1];
        r = t.radius;
        const centerPt = this.point(cx, cy, true);
        circleId = this.circle(centerPt, r, true); // construction=true
        this.radius(circleId, r); // Pin the radius — without this the solver drifts it
      }

      // Look ahead/behind for direction estimates (wrapping for closed loops)
      const nextPos = peekNextStructuralPos(i);
      const prevPos = cursorPt ? getCursorPos() : peekPrevStructuralPos(i);
      const [prevX, prevY] = prevPos ?? [cx - 20, cy];
      const [nextX, nextY] = nextPos ?? [cx + 20, cy + 20];

      // Check if prev and next are in the same direction (e.g., 2-circle case)
      const prevAngle = Math.atan2(prevY - cy, prevX - cx);
      const nextAngle = Math.atan2(nextY - cy, nextX - cx);
      let adiff = nextAngle - prevAngle;
      while (adiff > Math.PI) adiff -= 2 * Math.PI;
      while (adiff < -Math.PI) adiff += 2 * Math.PI;

      let entryX: number, entryY: number, exitX: number, exitY: number;
      if (Math.abs(adiff) < 0.15) {
        // Same direction — offset entry/exit by ±90° to spread them
        [entryX, entryY] = estimatePointOnCircle(cx, cy, r, prevX, prevY, -Math.PI / 2);
        [exitX, exitY] = estimatePointOnCircle(cx, cy, r, nextX, nextY, Math.PI / 2);
      } else {
        // Different directions — place toward prev/next
        [entryX, entryY] = estimatePointOnCircle(cx, cy, r, prevX, prevY);
        [exitX, exitY] = estimatePointOnCircle(cx, cy, r, nextX, nextY);
      }

      // Create entry and exit points
      const entryPtId = this.point(entryX, entryY);
      const exitPtId = this.point(exitX, exitY);

      // Constrain entry and exit points to lie on the circle
      this.pointOnCircle(entryPtId, circleId);
      this.pointOnCircle(exitPtId, circleId);

      // Connect cursor to entry point
      if (!cursorPt) {
        // First element in a closed loop — remember for closing
        firstEntryPt = entryPtId;
      } else if (lastArcId === null) {
        // Need a line from cursor to entry
        const connLineId = this.line(cursorPt, entryPtId);
        segments.push({ kind: 'line', id: connLineId, startPt: cursorPt, endPt: entryPtId });

        // The line should be tangent to the circle at the entry point
        this.tangent(connLineId, circleId);

        lastLineId = connLineId;
      } else {
        // Previous element was an arc — make entry coincident with cursor
        this.coincident(cursorPt, entryPtId);
      }

      // Choose arc direction: for exterior perimeters, pick the arc whose midpoint
      // is farther from the centroid (the "outside" arc).
      const entryAngle = Math.atan2(entryY - cy, entryX - cx);
      const exitAngle = Math.atan2(exitY - cy, exitX - cx);
      let ccwSweep = exitAngle - entryAngle;
      while (ccwSweep <= 0) ccwSweep += 2 * Math.PI;
      while (ccwSweep > 2 * Math.PI) ccwSweep -= 2 * Math.PI;
      const cwSweep = ccwSweep - 2 * Math.PI;
      const ccwMid = entryAngle + ccwSweep / 2;
      const cwMid = entryAngle + cwSweep / 2;
      const ccwDist = Math.hypot(cx + r * Math.cos(ccwMid) - centroidX, cy + r * Math.sin(ccwMid) - centroidY);
      const cwDist = Math.hypot(cx + r * Math.cos(cwMid) - centroidX, cy + r * Math.sin(cwMid) - centroidY);
      const clockwise = cwDist > ccwDist;

      // Create the arc on the circle from entry to exit
      const circ = this.circles.find((c: any) => c.id === circleId);
      const arcId = this.arcByCenter(circ.center, entryPtId, exitPtId, clockwise);
      segments.push({ kind: 'arc', id: arcId, startPt: entryPtId, endPt: exitPtId });

      // Remember first arc for closing
      if (firstArcId === null && firstEntryPt) {
        firstArcId = arcId;
      }

      // Tangency with previous element
      if (lastLineId && lastArcId === null) {
        this.lineTangentArc(lastLineId, arcId, true); // tangent at arc start
      } else if (lastArcId) {
        this.arcTangentArc(lastArcId, arcId);
      }

      lastArcId = arcId;
      lastLineId = null;
      cursorPt = exitPtId;
      cursorX = exitX;
      cursorY = exitY;
    } else if (isRouteFillet(step)) {
      // ─── Fillet: insert tangent arc between neighbors ───────────────
      if (!cursorPt) throw new Error('route(): fillet step requires a preceding element');

      const filletR = step.fillet;
      const [curX, curY] = getCursorPos();
      const nextPos = peekNextStructuralPos(i);
      const [toX, toY] = nextPos ?? [curX + 20, curY];

      // Estimate fillet arc center and endpoints
      const [fcx, fcy] = estimateFilletCenter(curX, curY, toX, toY, filletR);

      // Create fillet arc: center, start (at cursor), end (toward next)
      const filletCenterPt = this.point(fcx, fcy);
      const filletStartPt = cursorPt; // reuse cursor as the junction point
      // Estimate exit point on the fillet
      const dx2 = toX - fcx;
      const dy2 = toY - fcy;
      const d2 = Math.hypot(dx2, dy2);
      const exitX = d2 > 1e-9 ? fcx + (dx2 / d2) * filletR : fcx + filletR;
      const exitY = d2 > 1e-9 ? fcy + (dy2 / d2) * filletR : fcy;
      const filletEndPt = this.point(exitX, exitY);

      // Choose direction: pick the shorter arc (fillets are small roundings)
      const fStartAngle = Math.atan2(curY - fcy, curX - fcx);
      const fExitAngle = Math.atan2(exitY - fcy, exitX - fcx);
      let fCcwSweep = fExitAngle - fStartAngle;
      while (fCcwSweep <= 0) fCcwSweep += 2 * Math.PI;
      while (fCcwSweep > 2 * Math.PI) fCcwSweep -= 2 * Math.PI;
      const filletCW = fCcwSweep > Math.PI; // CW if CCW sweep > 180° (shorter arc is CW)

      // Create the arc
      const arcId = this.arcByCenter(filletCenterPt, filletStartPt, filletEndPt, filletCW);

      // Constrain fillet radius via distance from center to start point
      this.distance(filletCenterPt, filletStartPt, filletR);

      // Tangency with previous element
      if (lastLineId) {
        this.lineTangentArc(lastLineId, arcId, true); // tangent at arc start
      } else if (lastArcId) {
        this.arcTangentArc(lastArcId, arcId);
      }

      segments.push({ kind: 'arc', id: arcId, startPt: filletStartPt, endPt: filletEndPt });
      lastArcId = arcId;
      lastLineId = null;
      cursorPt = filletEndPt;
      cursorX = exitX;
      cursorY = exitY;
    } else if (isRouteTangentArc(step)) {
      // ─── Tangent arc: free arc, solver finds center ─────────────────
      if (!cursorPt) throw new Error('route(): tangentArc step requires a preceding element');

      const arcR = step.tangentArc;
      const [curX, curY] = getCursorPos();
      const nextPos = peekNextStructuralPos(i);
      const [toX, toY] = nextPos ?? [curX + 20, curY];

      // Estimate center and exit similarly to fillet
      const [acx, acy] = estimateFilletCenter(curX, curY, toX, toY, arcR);
      const dx2 = toX - acx;
      const dy2 = toY - acy;
      const d2 = Math.hypot(dx2, dy2);
      const exitX = d2 > 1e-9 ? acx + (dx2 / d2) * arcR : acx + arcR;
      const exitY = d2 > 1e-9 ? acy + (dy2 / d2) * arcR : acy;

      const arcCenterPt = this.point(acx, acy);
      const arcStartPt = cursorPt;
      const arcEndPt = this.point(exitX, exitY);

      // Choose direction: pick shorter arc
      const taStartAngle = Math.atan2(curY - acy, curX - acx);
      const taExitAngle = Math.atan2(exitY - acy, exitX - acx);
      let taCcwSweep = taExitAngle - taStartAngle;
      while (taCcwSweep <= 0) taCcwSweep += 2 * Math.PI;
      while (taCcwSweep > 2 * Math.PI) taCcwSweep -= 2 * Math.PI;
      const taCW = taCcwSweep > Math.PI;

      const arcId = this.arcByCenter(arcCenterPt, arcStartPt, arcEndPt, taCW);
      this.distance(arcCenterPt, arcStartPt, arcR);

      // Tangency with previous element
      if (lastLineId) {
        this.lineTangentArc(lastLineId, arcId, true);
      } else if (lastArcId) {
        this.arcTangentArc(lastArcId, arcId);
      }

      segments.push({ kind: 'arc', id: arcId, startPt: arcStartPt, endPt: arcEndPt });
      lastArcId = arcId;
      lastLineId = null;
      cursorPt = arcEndPt;
      cursorX = exitX;
      cursorY = exitY;
    } else if (isRouteCircle(step)) {
      // ─── Bare circle (same as tangent shorthand) ────────────────────
      // Treat as { tangent: step }
      const tangentStep: RouteTangent = { tangent: step };
      // Re-process as tangent (decrement i to re-visit with modified step)
      steps[i] = tangentStep;
      i--;
      continue;
    }
  }

  // ─── Phase 2: Close the loop ──────────────────────────────────────────
  const firstStep = steps[0];
  if (isRoutePoint(firstStep) && segments.length > 0) {
    // Point-started route: close with a line back to the first point
    const firstSeg = segments[0];
    if (cursorPt && cursorPt !== firstSeg.startPt) {
      const closingLine = this.line(cursorPt, firstSeg.startPt);
      segments.push({ kind: 'line', id: closingLine, startPt: cursorPt, endPt: firstSeg.startPt });
      if (lastArcId) {
        this.lineTangentArc(closingLine, lastArcId, false);
      }
    }
  } else if (firstEntryPt && cursorPt && cursorPt !== firstEntryPt) {
    // Closed circle+fillet loop: connect last element back to first entry
    this.coincident(cursorPt, firstEntryPt);
    if (lastArcId && firstArcId) {
      this.arcTangentArc(lastArcId, firstArcId);
    }
  }

  // ─── Phase 3: Register the profile loop ───────────────────────────────
  if (segments.length > 0) {
    const profileSegs = segments.map((seg) =>
      seg.kind === 'line' ? { kind: 'line' as const, line: seg.id as LineId } : { kind: 'arc' as const, arc: seg.id as ArcId },
    );
    this.addProfileLoop(profileSegs);
  }

  return this;
};

import type { ProfileCompilePlan, ProfileCompileTransformStep } from '../compilePlan';
import { appendShapeCompileTransform, createOwnedShapeCompilePlan } from '../compilePlan';
import { buildShapeFromCompilePlan, Shape } from '../kernel';
import { composeChain, normalizeAxis, Transform, type Vec3 } from '../transform';
import { getSketchCompileProfilePlan, getSketchPlacement3D, getSketchPlacementModel, Sketch } from './core';
import { type EdgeName, type EdgeRef, type FaceName, type FaceRef, type Topology, TrackedShape, transformTopology } from './topology';

/** Compose a 2D profile transform chain into a 3D Transform (z = 0 plane). */
function profileTransform(transforms: ProfileCompileTransformStep[]): Transform {
  const steps = transforms.map((t): Transform => {
    switch (t.kind) {
      case 'translate':
        return Transform.translation(t.x, t.y, 0);
      case 'rotate':
        return Transform.rotationAxis([0, 0, 1], t.degrees);
      case 'scale':
        return Transform.scale([t.x, t.y, 1]);
      case 'mirror': {
        // Reflect across the line through origin perpendicular to [normalX, normalY].
        const nx = t.normalX;
        const ny = t.normalY;
        const len = Math.hypot(nx, ny) || 1;
        const ux = nx / len;
        const uy = ny / len;
        // Householder reflection matrix in 2D embedded in 3D.
        return Transform.from([1 - 2 * ux * ux, -2 * ux * uy, 0, 0, -2 * ux * uy, 1 - 2 * uy * uy, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      }
    }
  });
  return composeChain(...steps);
}

type Corner = [number, number];

/** A rectangle-like profile is one whose outline is 4 straight sides (rect, roundedRect, rectangular polygon). */
function rectLikeProfileCorners(profile: ProfileCompilePlan): [Corner, Corner, Corner, Corner] | null {
  if (profile.kind === 'rect' || profile.kind === 'roundedRect') {
    const centered = profile.center;
    const minX = centered ? -profile.width / 2 : 0;
    const minY = centered ? -profile.height / 2 : 0;
    const maxX = minX + profile.width;
    const maxY = minY + profile.height;
    const tx = profileTransform(profile.transforms);
    const p = (x: number, y: number): Corner => {
      const [px, py] = tx.point([x, y, 0]);
      return [px, py];
    };
    return [p(minX, minY), p(maxX, minY), p(maxX, maxY), p(minX, maxY)];
  }
  if (profile.kind === 'polygon' && profile.points.length === 4) {
    const tx = profileTransform(profile.transforms);
    const pts = profile.points.map(([x, y]) => {
      const [px, py] = tx.point([x, y, 0]);
      return [px, py] as Corner;
    });
    // Verify axis-aligned-ish rectangle (opposite sides parallel, adjacent perpendicular).
    const dot = (ax: number, ay: number, bx: number, by: number) => ax * bx + ay * by;
    const [a, b, c, d] = pts;
    const e0 = [b[0] - a[0], b[1] - a[1]];
    const e1 = [c[0] - b[0], c[1] - b[1]];
    const e2 = [d[0] - c[0], d[1] - c[1]];
    if (Math.abs(dot(e0[0], e0[1], e1[0], e1[1])) > 1e-6) return null;
    if (Math.abs(dot(e1[0], e1[1], e2[0], e2[1])) > 1e-6) return null;
    return [a, b, c, d];
  }
  return null;
}

function buildGenericExtrusionTopology(sketch: Sketch, height: number, center: boolean): Topology {
  const faces = new Map<FaceName, FaceRef>();
  const edges = new Map<EdgeName, EdgeRef>();
  const b = sketch.bounds();
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const zBot = center ? -height / 2 : 0;
  const zTop = center ? height / 2 : height;

  const profile = getSketchCompileProfilePlan(sketch);
  const corners = rectLikeProfileCorners(profile);

  if (corners) {
    const [bl, br, tr, tl] = corners;
    const topU = normalizeAxis([br[0] - bl[0], br[1] - bl[1], 0]);
    const topV = normalizeAxis([tl[0] - bl[0], tl[1] - bl[1], 0]);
    faces.set('top', {
      name: 'top',
      normal: [0, 0, 1],
      center: [cx, cy, zTop],
      planar: true,
      uAxis: topU,
      vAxis: topV,
    });
    faces.set('bottom', {
      name: 'bottom',
      normal: [0, 0, -1],
      center: [cx, cy, zBot],
      planar: true,
      uAxis: topU,
      vAxis: [-topV[0], -topV[1], -topV[2]],
    });
    // Side faces named after the rectangle edge they came from.
    const sides: [string, Corner, Corner][] = [
      ['side-bottom', bl, br],
      ['side-right', br, tr],
      ['side-top', tr, tl],
      ['side-left', tl, bl],
    ];
    for (const [name, p1, p2] of sides) {
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      const len = Math.hypot(dx, dy) || 1;
      // Outward normal for CCW winding.
      const normal: Vec3 = [dy / len, -dx / len, 0];
      faces.set(name, {
        name,
        normal,
        center: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (zTop + zBot) / 2],
        planar: true,
        uAxis: [dx / len, dy / len, 0],
        vAxis: [0, 0, 1],
      });
    }
    return { faces, edges };
  }

  faces.set('top', {
    name: 'top',
    normal: [0, 0, 1],
    center: [cx, cy, zTop],
    planar: true,
    uAxis: [1, 0, 0],
    vAxis: [0, 1, 0],
  });
  faces.set('bottom', {
    name: 'bottom',
    normal: [0, 0, -1],
    center: [cx, cy, zBot],
    planar: true,
    uAxis: [1, 0, 0],
    vAxis: [0, -1, 0],
  });
  faces.set('side', {
    name: 'side',
    normal: [1, 0, 0],
    center: [b.max[0], cy, (zTop + zBot) / 2],
    planar: false,
  });

  return { faces, edges };
}

export function sketchExtrude(
  sketch: Sketch,
  height: number,
  opts?: {
    twist?: number;
    divisions?: number;
    scaleTop?: number | [number, number];
    center?: boolean;
  },
): TrackedShape {
  const scaleTop = typeof opts?.scaleTop === 'number' ? ([opts.scaleTop, opts.scaleTop] as [number, number]) : opts?.scaleTop;
  const basePlan = {
    kind: 'extrude' as const,
    profile: getSketchCompileProfilePlan(sketch),
    height,
    center: opts?.center ?? false,
    scaleTop,
    twist: opts?.twist != null && opts.twist !== 0 ? opts.twist : undefined,
    twistSegments: opts?.divisions != null && opts.divisions > 0 ? opts.divisions : undefined,
  };
  const placement = getSketchPlacement3D(sketch);
  const placementModel = getSketchPlacementModel(sketch);
  const plan =
    placement && placementModel
      ? appendShapeCompileTransform(basePlan, {
          kind: 'workplanePlacement',
          matrix: placement,
          placement: placementModel,
        })
      : basePlan;
  const ownedPlan = createOwnedShapeCompilePlan(plan, 'extrude');
  const shape = buildShapeFromCompilePlan(ownedPlan, sketch.colorHex, {
    fidelity: 'kernel-native',
    sources: ['extrude'],
  });
  const topo = buildGenericExtrusionTopology(sketch, height, opts?.center ?? false);
  if (!placement) return new TrackedShape(shape, topo, 0, true);
  const transformedTopology = transformTopology(topo, placement);
  if (placementModel) return new TrackedShape(shape, transformedTopology, 0, true);
  return new TrackedShape(shape.transform(placement), transformedTopology, 0, true);
}

export function sketchRevolve(sketch: Sketch, degrees = 360, segments?: number): Shape {
  const basePlan = {
    kind: 'revolve' as const,
    profile: getSketchCompileProfilePlan(sketch),
    degrees,
    segments: segments != null && segments > 0 ? segments : undefined,
  };
  const placement = getSketchPlacement3D(sketch);
  const placementModel = getSketchPlacementModel(sketch);
  const plan =
    placement && placementModel
      ? appendShapeCompileTransform(basePlan, {
          kind: 'workplanePlacement',
          matrix: placement,
          placement: placementModel,
        })
      : basePlan;
  const ownedPlan = createOwnedShapeCompilePlan(plan, 'revolve');
  const revolved = buildShapeFromCompilePlan(ownedPlan, sketch.colorHex, {
    fidelity: 'kernel-native',
    sources: ['revolve'],
  });
  if (!placement || placementModel) return revolved;
  return revolved.transform(placement);
}

Sketch.prototype.extrude = function (
  height: number,
  opts?: {
    twist?: number;
    divisions?: number;
    scaleTop?: number | [number, number];
    center?: boolean;
  },
) {
  return sketchExtrude(this, height, opts);
};

Sketch.prototype.revolve = function (degrees = 360, segments?: number) {
  return sketchRevolve(this, degrees, segments);
};

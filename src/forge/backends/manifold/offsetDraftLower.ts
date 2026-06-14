/**
 * Manifold-backed `offsetSolid` and `draft` lowering.
 *
 * forgecad 0.9.13's default (Manifold) backend implements both operations
 * analytically for "vertical prism" primitives (box, cylinder, extrude) and a
 * few composite plans (loft, simple transforms). This mirrors that behaviour so
 * the operations no longer hard-require the OCCT backend.
 *
 * Fidelity: `offsetSolid` here is a SHARP face offset — every face is moved
 * along its normal by `thickness` (the 2D profile is offset with a Miter join
 * and the axial extent is extended by ±thickness). This matches the OCCT
 * BRepOffset result for prismatic solids exactly (e.g. box(20,20,20) + 3 →
 * volume 26³ = 17576). It is NOT a rounded Minkowski offset.
 *
 * Cases that cannot be expressed as a sharp analytic offset on Manifold
 * (non-straight sweeps, multi-loop sweeps, general meshes) still throw the
 * OCCT-required error, exactly as 0.9.13 does — this is an honest "unsupported
 * on this backend" signal, not a silent fallback.
 */
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { ProfileCompilePlan, ShapeCompilePlan, ShapeCompileTransformStep } from '../../compilePlan';
import { cloneProfileCompilePlan } from '../../compilePlan';

const EPS = 1e-9;

const OCCT_REQUIRED = "Offset solid requires the OCCT backend. Add setActiveBackend('occt') at the top of your script.";
const DRAFT_OCCT_REQUIRED =
  "Draft angle requires the OCCT backend. Add setActiveBackend('occt') at the top of your script.";

/** Axial extent of a vertical prism (z range) plus its bottom/top XY profiles. */
interface VerticalPrismBase {
  bottomProfile: ProfileCompilePlan;
  topProfile: ProfileCompilePlan;
  zMin: number;
  zMax: number;
}

function clone(profile: ProfileCompilePlan): ProfileCompilePlan {
  return cloneProfileCompilePlan(profile)!;
}

/** Strip a `queryOwner` wrapper, which is transparent for geometry purposes. */
function unwrapQueryOwner(plan: ShapeCompilePlan): ShapeCompilePlan {
  let current = plan;
  while (current.kind === 'queryOwner') current = current.base;
  return current;
}

/**
 * Extract the bottom/top XY profiles and z-extent of a vertical-prism primitive,
 * respecting the fork's `center` flag (which centers both XY and Z for box, and
 * Z for cylinder/extrude). Returns null for non-prismatic plans.
 */
function verticalPrismBase(plan: ShapeCompilePlan): VerticalPrismBase | null {
  switch (plan.kind) {
    case 'queryOwner':
      return verticalPrismBase(plan.base);
    case 'box': {
      if (![plan.x, plan.y, plan.z].every(Number.isFinite)) return null;
      const profile: ProfileCompilePlan = {
        kind: 'rect',
        width: Math.abs(plan.x),
        height: Math.abs(plan.y),
        center: plan.center,
        transforms: [],
      };
      const z = Math.abs(plan.z);
      const [zMin, zMax] = plan.center ? [-z / 2, z / 2] : [0, z];
      return { bottomProfile: profile, topProfile: clone(profile), zMin, zMax };
    }
    case 'cylinder': {
      const radiusTop = plan.radiusTop ?? plan.radius;
      if (![plan.height, plan.radius, radiusTop].every(Number.isFinite)) return null;
      // A tapered cylinder is not a vertical prism for offset purposes.
      if (Math.abs(radiusTop - plan.radius) > EPS) return null;
      const profile: ProfileCompilePlan = {
        kind: 'circle',
        radius: Math.abs(plan.radius),
        segments: plan.segments,
        transforms: [],
      };
      const h = Math.abs(plan.height);
      const [zMin, zMax] = plan.center ? [-h / 2, h / 2] : [0, h];
      return { bottomProfile: profile, topProfile: clone(profile), zMin, zMax };
    }
    case 'extrude': {
      if (!Number.isFinite(plan.height)) return null;
      if (plan.twist != null && Math.abs(plan.twist) > EPS) return null;
      if (plan.scaleTop && (Math.abs(plan.scaleTop[0] - 1) > EPS || Math.abs(plan.scaleTop[1] - 1) > EPS)) {
        return null;
      }
      const profile = clone(plan.profile);
      const h = Math.abs(plan.height);
      const [zMin, zMax] = plan.center ? [-h / 2, h / 2] : [0, h];
      return { bottomProfile: profile, topProfile: clone(profile), zMin, zMax };
    }
    default:
      return null;
  }
}

/** Wrap a profile in an `offset` plan (Miter join). Identity for ~zero delta. */
function offsetProfile(profile: ProfileCompilePlan, delta: number): ProfileCompilePlan {
  if (Math.abs(delta) <= EPS) return clone(profile);
  return { kind: 'offset', base: clone(profile), delta, join: 'Miter', transforms: [] };
}

/**
 * Distance scale contributed by a transform step, or null if the step is not a
 * uniform-scale / rigid motion (offsetting through a non-uniform transform is
 * not a sharp offset, so we punt to OCCT).
 */
function transformDistanceScale(step: ShapeCompileTransformStep): number | null {
  switch (step.kind) {
    case 'translate':
    case 'rotate':
    case 'rotateAround':
    case 'mirror':
      return 1;
    case 'scale': {
      const sx = Math.abs(step.x);
      const sy = Math.abs(step.y);
      const sz = Math.abs(step.z);
      const scale = Math.max(sx, sy, sz);
      if (
        scale <= EPS ||
        !Number.isFinite(scale) ||
        Math.abs(sx - scale) > EPS ||
        Math.abs(sy - scale) > EPS ||
        Math.abs(sz - scale) > EPS
      ) {
        return null;
      }
      return scale;
    }
    case 'workplanePlacement':
      // Rigid (distance-preserving) placements scale by 1; others are unsupported.
      return isRigidMatrix(step.matrix) ? 1 : null;
  }
}

/** True if a 4x4 matrix is a rigid motion (orthonormal rotation + translation). */
function isRigidMatrix(m: number[]): boolean {
  if (m.length !== 16 || m.some((v) => !Number.isFinite(v))) return false;
  // Column basis vectors must be orthonormal.
  const cols: [number, number, number][] = [
    [m[0], m[1], m[2]],
    [m[4], m[5], m[6]],
    [m[8], m[9], m[10]],
  ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(Math.hypot(...cols[i]) - 1) > EPS) return false;
    for (let j = i + 1; j < 3; j++) {
      const dot = cols[i][0] * cols[j][0] + cols[i][1] * cols[j][1] + cols[i][2] * cols[j][2];
      if (Math.abs(dot) > EPS) return false;
    }
  }
  return Math.abs(m[15] - 1) <= EPS;
}

/**
 * Offset a transformed base: pull the offset down into local space (dividing the
 * thickness by the accumulated uniform-distance scale), offset there, then
 * re-apply the transforms.
 */
function offsetTransformedPlan(
  plan: Extract<ShapeCompilePlan, { kind: 'transform' }>,
  thickness: number,
): ShapeCompilePlan {
  let distanceScale = 1;
  for (const step of plan.steps) {
    const stepScale = transformDistanceScale(step);
    if (stepScale == null) throw new Error(OCCT_REQUIRED);
    distanceScale *= stepScale;
  }
  return {
    kind: 'transform',
    base: offsetSolidPlan({ kind: 'offsetSolid', base: plan.base, thickness: thickness / distanceScale }),
    steps: plan.steps,
  };
}

/** Offset a 2-profile loft by extending its end heights and offsetting profiles. */
function offsetLoftPlan(plan: Extract<ShapeCompilePlan, { kind: 'loft' }>, thickness: number): ShapeCompilePlan {
  if (plan.profiles.length !== plan.heights.length || plan.profiles.length < 2) {
    throw new Error(OCCT_REQUIRED);
  }
  const heights = [...plan.heights];
  heights[0] -= thickness;
  heights[heights.length - 1] += thickness;
  if (
    heights.some((h) => !Number.isFinite(h)) ||
    heights.some((h, i) => i > 0 && h <= heights[i - 1] + EPS)
  ) {
    throw new Error('offsetSolid() collapsed the loft height span.');
  }
  return {
    kind: 'loft',
    profiles: plan.profiles.map((p) => offsetProfile(p, thickness)),
    heights,
    edgeLength: plan.edgeLength,
    boundsPadding: plan.boundsPadding,
  };
}

/**
 * Rewrite an `offsetSolid` plan into an equivalent primitive/loft/transform plan
 * that the standard Manifold lowering can build. Throws OCCT_REQUIRED for shapes
 * that have no sharp analytic offset on Manifold.
 */
export function offsetSolidPlan(plan: Extract<ShapeCompilePlan, { kind: 'offsetSolid' }>): ShapeCompilePlan {
  if (!Number.isFinite(plan.thickness) || Math.abs(plan.thickness) <= EPS) {
    throw new Error('offsetSolid() requires a non-zero finite thickness.');
  }
  const base = unwrapQueryOwner(plan.base);

  if (base.kind === 'transform') {
    return offsetTransformedPlan(base, plan.thickness);
  }
  if (base.kind === 'loft') {
    return offsetLoftPlan(base, plan.thickness);
  }

  const prism = verticalPrismBase(base);
  if (!prism) throw new Error(OCCT_REQUIRED);

  const zMin = prism.zMin - plan.thickness;
  const zMax = prism.zMax + plan.thickness;
  if (zMax <= zMin + EPS) {
    throw new Error('offsetSolid() collapsed the prism height.');
  }
  // Offset the (centered or corner) profile, extrude over the extended z-span,
  // then translate so the extrusion bottom sits at zMin.
  return {
    kind: 'transform',
    base: {
      kind: 'extrude',
      profile: offsetProfile(prism.bottomProfile, plan.thickness),
      height: zMax - zMin,
      center: false,
    },
    steps: [{ kind: 'translate', x: 0, y: 0, z: zMin }],
  };
}

/** Lower an `offsetSolid` plan to a Manifold via the standard shape lowering. */
export function lowerOffsetSolid(
  plan: Extract<ShapeCompilePlan, { kind: 'offsetSolid' }>,
  wasm: ManifoldToplevel,
  lower: (plan: ShapeCompilePlan, wasm: ManifoldToplevel) => Manifold,
): Manifold {
  return lower(offsetSolidPlan(plan), wasm);
}

// ── Draft ────────────────────────────────────────────────────────────────────

/**
 * Rewrite a `draft` plan into a 2-profile loft (bottom profile offset inward,
 * top profile offset outward, per the draft angle about the neutral plane).
 * Only axial (±Z) pull directions on vertical prisms are expressible as a loft;
 * everything else throws DRAFT_OCCT_REQUIRED.
 */
export function draftToLoftPlan(plan: Extract<ShapeCompilePlan, { kind: 'draft' }>): ShapeCompilePlan {
  const [dx, dy, dz] = plan.pullDirection;
  const len = Math.hypot(dx, dy, dz);
  if (len <= EPS) throw new Error(DRAFT_OCCT_REQUIRED);
  const nx = dx / len;
  const ny = dy / len;
  const nz = dz / len;
  if (Math.abs(nx) > EPS || Math.abs(ny) > EPS || Math.abs(Math.abs(nz) - 1) > EPS) {
    throw new Error(DRAFT_OCCT_REQUIRED);
  }

  const base = verticalPrismBase(unwrapQueryOwner(plan.base));
  if (!base) throw new Error(DRAFT_OCCT_REQUIRED);
  if (!(base.zMax > base.zMin + EPS)) throw new Error(DRAFT_OCCT_REQUIRED);

  const tanAngle = Math.tan((plan.angleDeg * Math.PI) / 180);
  const axialSign = nz >= 0 ? 1 : -1;
  // Offset at a given z grows linearly with distance from the neutral plane.
  const offsetAtZ = (z: number) => (axialSign * z - plan.neutralPlaneOffset) * tanAngle;

  return {
    kind: 'loft',
    profiles: [
      offsetProfile(base.bottomProfile, offsetAtZ(base.zMin)),
      offsetProfile(base.topProfile, offsetAtZ(base.zMax)),
    ],
    heights: [base.zMin, base.zMax],
    edgeLength: 1,
    boundsPadding: 1,
  };
}

/** Lower a `draft` plan to a Manifold via the standard shape lowering. */
export function lowerDraft(
  plan: Extract<ShapeCompilePlan, { kind: 'draft' }>,
  wasm: ManifoldToplevel,
  lower: (plan: ShapeCompilePlan, wasm: ManifoldToplevel) => Manifold,
): Manifold {
  return lower(draftToLoftPlan(plan), wasm);
}

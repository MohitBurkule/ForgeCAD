import { intersection, Shape } from '../kernel';
import type { Sketch } from './core';
import './extrude'; // ensure Sketch.prototype.extrude is installed

export type SlicePlane = 'xy' | 'xz' | 'yz';

export interface Slice {
  /** Plane the silhouette profile lives on. */
  on: SlicePlane;
  /** Offset of the plane along its normal (default 0). */
  at?: number;
  /** 2D silhouette profile. */
  profile: Sketch;
}

/**
 * Loft / intersect through a set of cross-section silhouettes.
 *
 * Each slice describes a 2D silhouette on a principal plane (xy, xz, or yz). Each
 * silhouette is extruded into an infinite-prism approximation along its plane normal,
 * and all prisms are intersected. Two orthogonal silhouettes (e.g. side + front views)
 * carve a solid whose projections match each silhouette — the classic "build from two
 * views" construction (e.g. an egg from two ellipses).
 */
export function shapeFromSlices(slices: Slice[]): Shape {
  if (!Array.isArray(slices) || slices.length < 2) {
    throw new Error('Shape.fromSlices requires at least two slices');
  }

  // Extent: extrude each silhouette far enough to fully span every other silhouette.
  let maxReach = 0;
  for (const s of slices) {
    if (!s || typeof s.on !== 'string') throw new Error('Shape.fromSlices: each slice needs an `on` plane and a `profile`');
    const b = s.profile.bounds();
    const reach = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[1]), Math.abs(b.max[1]));
    maxReach = Math.max(maxReach, reach);
  }
  const height = maxReach * 4 + 10;

  const prisms = slices.map((s) => extrudeSliceToPrism(s, height));
  return intersection(...prisms);
}

function extrudeSliceToPrism(slice: Slice, height: number): Shape {
  const at = slice.at ?? 0;
  if (!Number.isFinite(at)) throw new Error('Shape.fromSlices: `at` must be a finite number');

  // Extrude centered so the prism spans the silhouette symmetrically about the plane.
  const solid: Shape = slice.profile.extrude(height, { center: true });

  switch (slice.on) {
    case 'xy':
      // Profile already in XY, extruded along Z.
      return at !== 0 ? solid.translate(0, 0, at) : solid;
    case 'xz': {
      // Map the Z-extrusion onto the Y normal: profile X→X, profile Y→Z.
      const r = solid.rotateX(90);
      return at !== 0 ? r.translate(0, at, 0) : r;
    }
    case 'yz': {
      // Map the Z-extrusion onto the X normal: profile X→Y, profile Y→Z.
      const r = solid.rotateY(-90);
      return at !== 0 ? r.translate(at, 0, 0) : r;
    }
    default:
      throw new Error(`Shape.fromSlices: unknown plane "${slice.on}" (expected xy, xz, or yz)`);
  }
}

// Install static constructor on Shape.
(Shape as unknown as { fromSlices: typeof shapeFromSlices }).fromSlices = shapeFromSlices;

import { fillet } from './fillet';
import { Shape } from './kernel';
import { selectEdge } from './query/edgeQuery';
import type { EdgeSegment } from './mesh/meshEdgeExtraction';
import { type EdgeRef, TrackedShape } from './sketch/topology';

type Vec3 = [number, number, number];

export interface BlendCornerYOptions {
  shape: Shape | TrackedShape;
  /** Named edges to round, e.g. seed.edge('top-right'). */
  edges: EdgeRef[];
  radius: number;
  /** Continuity hint (G0/G1/G2). Recorded for downstream metadata; meshing approximates G1+. */
  continuity?: string;
}

function unwrap(shape: Shape | TrackedShape): Shape {
  return shape instanceof TrackedShape ? shape.toShape() : shape;
}

function isEdgeRef(value: unknown): value is EdgeRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as EdgeRef).start) &&
    Array.isArray((value as EdgeRef).end)
  );
}

function midpoint(e: EdgeRef): Vec3 {
  return [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2, (e.start[2] + e.end[2]) / 2];
}

function direction(e: EdgeRef): Vec3 {
  const d: Vec3 = [e.end[0] - e.start[0], e.end[1] - e.start[1], e.end[2] - e.start[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / len, d[1] / len, d[2] / len];
}

/**
 * Corner and edge blends.
 *
 * `Blend.CornerY` rounds a set of edges meeting at a corner (the classic three-edge
 * "Y" junction) with a single radius, producing a smooth blended body. Edges are
 * referenced by name through `shape.edge('top-right')`.
 */
export const Blend = {
  CornerY(options: BlendCornerYOptions): Shape {
    if (options == null || typeof options !== 'object') {
      throw new Error('Blend.CornerY: options object is required.');
    }
    const shape = unwrap(options.shape);
    if (!(shape instanceof Shape)) throw new Error('Blend.CornerY: `shape` must be a Shape or TrackedShape.');
    if (!Array.isArray(options.edges) || options.edges.length === 0) {
      throw new Error('Blend.CornerY: `edges` must be a non-empty array of named edge references (shape.edge(...)).');
    }
    const radius = options.radius;
    if (typeof radius !== 'number' || !Number.isFinite(radius) || !(radius > 0)) {
      throw new Error('Blend.CornerY: `radius` must be a positive finite number.');
    }

    const segments: EdgeSegment[] = [];
    for (const ref of options.edges) {
      if (!isEdgeRef(ref)) {
        throw new Error('Blend.CornerY: every entry of `edges` must come from shape.edge(name).');
      }
      // Resolve the named topology edge to a concrete mesh edge via its midpoint/direction.
      const seg = selectEdge(shape, { near: midpoint(ref), parallel: direction(ref), convex: true });
      segments.push(seg);
    }

    return fillet(shape, radius, segments);
  },
};

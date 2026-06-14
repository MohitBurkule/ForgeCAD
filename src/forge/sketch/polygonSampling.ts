type Vec2 = [number, number];

const EPS5 = 1e-9;

function cross2(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0];
}

function averagePoint(poly: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const point of poly) {
    x += point[0];
    y += point[1];
  }
  return [x / poly.length, y / poly.length];
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < poly.length; index += 1) {
    const a = poly[index];
    const b = poly[(index + 1) % poly.length];
    const crossValue = cross2(a, b);
    area += crossValue;
    cx += (a[0] + b[0]) * crossValue;
    cy += (a[1] + b[1]) * crossValue;
  }
  if (Math.abs(area) < EPS5) return averagePoint(poly);
  return [cx / (3 * area), cy / (3 * area)];
}

export function isConvexPolygon(poly: Vec2[]): boolean {
  let sign = 0;
  for (let index = 0; index < poly.length; index += 1) {
    const a = poly[index];
    const b = poly[(index + 1) % poly.length];
    const c = poly[(index + 2) % poly.length];
    const turn = cross2([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]);
    if (Math.abs(turn) < EPS5) continue;
    const currentSign = Math.sign(turn);
    if (sign !== 0 && currentSign !== sign) return false;
    sign = currentSign;
  }
  return sign !== 0;
}

function rayPolygonIntersection(origin: Vec2, direction: Vec2, poly: Vec2[]): Vec2 | null {
  let bestT = Infinity;
  let best: Vec2 | null = null;
  for (let index = 0; index < poly.length; index += 1) {
    const a = poly[index];
    const b = poly[(index + 1) % poly.length];
    const edge: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const denom = cross2(direction, edge);
    if (Math.abs(denom) < EPS5) continue;
    const delta: Vec2 = [a[0] - origin[0], a[1] - origin[1]];
    const rayT = cross2(delta, edge) / denom;
    const edgeT = cross2(delta, direction) / denom;
    if (rayT >= -EPS5 && edgeT >= -EPS5 && edgeT <= 1 + EPS5 && rayT < bestT) {
      bestT = rayT;
      best = [origin[0] + direction[0] * rayT, origin[1] + direction[1] * rayT];
    }
  }
  return best;
}

/**
 * Resample a convex polygon at `targetCount` evenly-spaced angles (rays cast
 * from the centroid). Returns null for non-convex polygons or when any ray
 * misses. Unlike arc-length resampling, this gives consistent point
 * correspondence between dissimilar convex sections (e.g. circle vs square),
 * which keeps the lofted ruled surface from twisting and rounding off corners.
 */
export function resamplePolygonByAngle(
  poly: Vec2[],
  targetCount: number,
  center: Vec2 = polygonCentroid(poly),
): Vec2[] | null {
  if (poly.length < 3 || targetCount <= 0) return null;
  if (!isConvexPolygon(poly)) return null;
  const out: Vec2[] = [];
  for (let index = 0; index < targetCount; index += 1) {
    const angle = (index / targetCount) * Math.PI * 2;
    const point = rayPolygonIntersection(center, [Math.cos(angle), Math.sin(angle)], poly);
    if (!point) return null;
    out.push(point);
  }
  return out;
}

export function resamplePolygon(poly: Vec2[], targetCount: number): Vec2[] {
  if (poly.length < 2) return poly;
  if (targetCount <= 0) return [];

  // Calculate cumulative distance
  const dists: number[] = [0];
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    dists.push(dists[dists.length - 1] + d);
  }

  const totalDist = dists[dists.length - 1];
  if (totalDist < 1e-12) {
    return Array.from({ length: targetCount }, () => [poly[0][0], poly[0][1]] as Vec2);
  }

  const out: Vec2[] = [];
  for (let i = 0; i < targetCount; i++) {
    const targetDist = (i / targetCount) * totalDist;

    // Binary search for segment
    let low = 0;
    let high = dists.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (dists[mid] <= targetDist) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const seg = low - 1;
    const t = (targetDist - dists[seg]) / (dists[seg + 1] - dists[seg]);

    const p1 = poly[seg % poly.length];
    const p2 = poly[(seg + 1) % poly.length];
    out.push([p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t]);
  }

  return out;
}

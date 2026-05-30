type Vec2 = [number, number];
type Vec3 = [number, number, number];
type Loop2D = Vec2[];

type SignedLoop = { pts: Loop2D; area: number };

export interface LevelSetInput {
  sdf: (point: Vec3) => number;
  bounds: { min: Vec3; max: Vec3 };
  edgeLength: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vec3Scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function vec3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function vec3Len(v: Vec3): number {
  return Math.sqrt(vec3Dot(v, v));
}

function vec3Norm(v: Vec3): Vec3 {
  const len = vec3Len(v);
  if (len < 1e-9) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function signedArea2D(loop: Loop2D): number {
  let area = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const [x1, y1] = loop[index];
    const [x2, y2] = loop[(index + 1) % loop.length];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

function pointInLoop(point: Vec2, loop: Loop2D): boolean {
  let inside = false;
  const [px, py] = point;
  for (let index = 0, prev = loop.length - 1; index < loop.length; prev = index, index += 1) {
    const [xi, yi] = loop[index];
    const [xj, yj] = loop[prev];
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-20) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointSegDist2D(point: Vec2, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = point[0] - a[0];
  const apy = point[1] - a[1];
  const den = abx * abx + aby * aby;
  const t = den < 1e-12 ? 0 : clamp((apx * abx + apy * aby) / den, 0, 1);
  const qx = a[0] + abx * t;
  const qy = a[1] + aby * t;
  const dx = point[0] - qx;
  const dy = point[1] - qy;
  return Math.sqrt(dx * dx + dy * dy);
}

function loopSignedDistance(point: Vec2, loop: Loop2D): number {
  let minDist = Infinity;
  for (let index = 0; index < loop.length; index += 1) {
    const a = loop[index];
    const b = loop[(index + 1) % loop.length];
    minDist = Math.min(minDist, pointSegDist2D(point, a, b));
  }
  return pointInLoop(point, loop) ? minDist : -minDist;
}

function compilePolygonsSdf(polygons: Vec2[][]): (x: number, y: number) => number {
  const loops: SignedLoop[] = polygons
    .filter((loop) => Array.isArray(loop) && loop.length >= 3)
    .map((loop) => ({ pts: loop.map(([x, y]) => [x, y]), area: signedArea2D(loop) }));

  if (loops.length === 0) {
    return () => -1;
  }

  return (x: number, y: number): number => {
    const point: Vec2 = [x, y];
    let field = -Infinity;
    for (const loop of loops) {
      const loopField = loopSignedDistance(point, loop.pts);
      field = loop.area >= 0 ? Math.max(field, loopField) : Math.min(field, -loopField);
    }
    return field;
  };
}

function makeSweepFrame(tangent: Vec3, preferredUp: Vec3): { x: Vec3; y: Vec3 } {
  let up = vec3Norm(preferredUp);
  if (Math.abs(vec3Dot(up, tangent)) > 0.95) {
    up = Math.abs(tangent[2]) < 0.95 ? [0, 0, 1] : [0, 1, 0];
  }
  let x = vec3Norm(vec3Cross(up, tangent));
  if (vec3Len(x) < 1e-8) {
    const fallback: Vec3 = Math.abs(tangent[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    x = vec3Norm(vec3Cross(fallback, tangent));
  }
  const y = vec3Norm(vec3Cross(tangent, x));
  return { x, y };
}

function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vec3Lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Rodrigues rotation of `v` about a unit `axis`, with rotation given by (cos, sin). */
function rotateVector(v: Vec3, axis: Vec3, cosAngle: number, sinAngle: number): Vec3 {
  const axisDot = vec3Dot(axis, v);
  const cross = vec3Cross(axis, v);
  return [
    v[0] * cosAngle + cross[0] * sinAngle + axis[0] * axisDot * (1 - cosAngle),
    v[1] * cosAngle + cross[1] * sinAngle + axis[1] * axisDot * (1 - cosAngle),
    v[2] * cosAngle + cross[2] * sinAngle + axis[2] * axisDot * (1 - cosAngle),
  ];
}

/** Make `xCandidate` orthonormal to `tangent`, falling back to a fresh frame when degenerate. */
function orthonormalizeFrame(xCandidate: Vec3, tangent: Vec3, fallbackUp: Vec3): { x: Vec3; y: Vec3 } {
  let x = vec3Sub(xCandidate, vec3Scale(tangent, vec3Dot(xCandidate, tangent)));
  if (vec3Len(x) < 1e-8) return makeSweepFrame(tangent, fallbackUp);
  x = vec3Norm(x);
  const y = vec3Norm(vec3Cross(tangent, x));
  return { x, y };
}

interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  t: Vec3;
}

/**
 * Rotation-minimizing (parallel-transport) frames along a polyline. Adjacent
 * frames are related by the minimal rotation that aligns successive tangents,
 * so the profile does not twist or flip between segments — this keeps the
 * swept SDF continuous and prevents the level-set mesher from fragmenting the
 * tube into disconnected bodies.
 */
function computeParallelTransportFrames(pathPoints: Vec3[], preferredUp: Vec3): Frame[] {
  // Per-vertex tangents (averaged across incoming/outgoing for interior points).
  const tangents: Vec3[] = pathPoints.map((_, i) => {
    const incoming = i > 0 ? vec3Norm(vec3Sub(pathPoints[i], pathPoints[i - 1])) : undefined;
    const outgoing = i < pathPoints.length - 1 ? vec3Norm(vec3Sub(pathPoints[i + 1], pathPoints[i])) : undefined;
    if (incoming && outgoing) {
      const blended = vec3Add(incoming, outgoing);
      return vec3Len(blended) > 1e-8 ? vec3Norm(blended) : outgoing;
    }
    return incoming ?? outgoing ?? ([0, 0, 1] as Vec3);
  });

  const firstTangent = vec3Norm(tangents[0]);
  let { x, y } = makeSweepFrame(firstTangent, preferredUp);
  const frames: Frame[] = [{ origin: pathPoints[0], x, y, t: firstTangent }];
  for (let i = 1; i < pathPoints.length; i += 1) {
    const prev = frames[i - 1];
    const tangent = vec3Norm(tangents[i]);
    const axis = vec3Cross(prev.t, tangent);
    const axisLen = vec3Len(axis);
    const cosAngle = clamp(vec3Dot(prev.t, tangent), -1, 1);
    let xCandidate: Vec3;
    let yCandidate: Vec3;
    if (axisLen > 1e-10) {
      const unitAxis = vec3Scale(axis, 1 / axisLen);
      xCandidate = rotateVector(prev.x, unitAxis, cosAngle, axisLen);
      yCandidate = rotateVector(prev.y, unitAxis, cosAngle, axisLen);
    } else if (cosAngle < -0.999999) {
      ({ x: xCandidate, y: yCandidate } = makeSweepFrame(tangent, prev.y));
    } else {
      xCandidate = prev.x;
      yCandidate = prev.y;
    }
    ({ x, y } = orthonormalizeFrame(xCandidate, tangent, yCandidate));
    frames.push({ origin: pathPoints[i], x, y, t: tangent });
  }
  return frames;
}

interface FramedSegment {
  a: Vec3;
  t: Vec3;
  len: number;
  arcStart: number;
  arcEnd: number;
  frameA: Frame;
  frameB: Frame;
}

interface SweepRuntime {
  segments: FramedSegment[];
  totalLen: number;
}

/** Build framed segments with parallel-transport frames and arc-length parameterization. */
function buildSweepRuntime(pathPoints: Vec3[], up: Vec3): SweepRuntime {
  // Drop zero-length duplicate points before framing.
  const clean: Vec3[] = [pathPoints[0]];
  for (let i = 1; i < pathPoints.length; i += 1) {
    if (vec3Len(vec3Sub(pathPoints[i], clean[clean.length - 1])) > 1e-6) clean.push(pathPoints[i]);
  }
  if (clean.length < 2) throw new Error('sweep path has no non-zero segments');

  const frames = computeParallelTransportFrames(clean, up);
  const segments: FramedSegment[] = [];
  let totalLen = 0;
  for (let i = 0; i < clean.length - 1; i += 1) {
    const a = clean[i];
    const delta = vec3Sub(clean[i + 1], a);
    const len = vec3Len(delta);
    if (len < 1e-6) continue;
    const t = vec3Scale(delta, 1 / len);
    segments.push({ a, t, len, arcStart: totalLen, arcEnd: totalLen + len, frameA: frames[i], frameB: frames[i + 1] });
    totalLen += len;
  }
  if (segments.length === 0) throw new Error('sweep path has no non-zero segments');
  return { segments, totalLen };
}

/** Interpolate a frame within a segment by parameter alpha in [0, 1]. */
function interpolateSweepFrame(segment: FramedSegment, alpha: number, origin: Vec3): Frame {
  const tangentCandidate = vec3Lerp(segment.frameA.t, segment.frameB.t, alpha);
  const tangent = vec3Len(tangentCandidate) > 1e-8 ? vec3Norm(tangentCandidate) : segment.t;
  const xCandidate = vec3Lerp(segment.frameA.x, segment.frameB.x, alpha);
  const fallbackUp = vec3Lerp(segment.frameA.y, segment.frameB.y, alpha);
  const { x, y } = orthonormalizeFrame(xCandidate, tangent, fallbackUp);
  return { origin, x, y, t: tangent };
}

interface NearestSweepPoint {
  segment: FramedSegment;
  alpha: number;
  frame: Frame;
  arcLength: number;
  isStart: boolean;
  isEnd: boolean;
}

/** Find the nearest point on the swept path to `point`, with its interpolated frame. */
function findNearestSweepPoint(point: Vec3, segments: FramedSegment[]): NearestSweepPoint {
  let bestIndex = 0;
  let bestAlpha = 0;
  let bestPoint: Vec3 = segments[0].a;
  let bestDist2 = Infinity;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const offset = vec3Sub(point, segment.a);
    const along = clamp(vec3Dot(offset, segment.t), 0, segment.len);
    const alpha = segment.len > 1e-9 ? along / segment.len : 0;
    const pointOnPath = vec3Add(segment.a, vec3Scale(segment.t, along));
    const delta = vec3Sub(point, pointOnPath);
    const dist2 = vec3Dot(delta, delta);
    if (dist2 < bestDist2) {
      bestIndex = i;
      bestAlpha = alpha;
      bestPoint = pointOnPath;
      bestDist2 = dist2;
    }
  }
  const segment = segments[bestIndex];
  return {
    segment,
    alpha: bestAlpha,
    frame: interpolateSweepFrame(segment, bestAlpha, bestPoint),
    arcLength: segment.arcStart + segment.len * bestAlpha,
    isStart: bestIndex === 0 && bestAlpha <= 1e-6,
    isEnd: bestIndex === segments.length - 1 && bestAlpha >= 1 - 1e-6,
  };
}

export function buildLoftLevelSetInput(
  profilePolygons: Vec2[][][],
  heights: number[],
  options: { edgeLength: number; boundsPadding: number },
): LevelSetInput {
  if (profilePolygons.length < 2) {
    throw new Error('loft requires at least two compileable profiles');
  }
  if (profilePolygons.length !== heights.length) {
    throw new Error('loft compile data requires heights.length === profiles.length');
  }

  const sdfs = profilePolygons.map((polygons) => compilePolygonsSdf(polygons));
  const zs = heights.map((height) => height);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygons of profilePolygons) {
    for (const loop of polygons) {
      for (const [x, y] of loop) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const zMin = zs[0];
  const zMax = zs[zs.length - 1];
  const pad = options.boundsPadding;

  return {
    sdf: ([x, y, z]) => {
      let crossField: number;
      if (z <= zMin) {
        crossField = sdfs[0](x, y);
      } else if (z >= zMax) {
        crossField = sdfs[sdfs.length - 1](x, y);
      } else {
        let segment = 0;
        while (segment + 1 < zs.length && z > zs[segment + 1]) segment += 1;
        const z0 = zs[segment];
        const z1 = zs[segment + 1];
        const t = (z - z0) / (z1 - z0);
        const f0 = sdfs[segment](x, y);
        const f1 = sdfs[segment + 1](x, y);
        crossField = f0 * (1 - t) + f1 * t;
      }

      const zCap = Math.min(z - zMin, zMax - z);
      return Math.min(crossField, zCap);
    },
    bounds: {
      min: [minX - pad, minY - pad, zMin - pad],
      max: [maxX + pad, maxY + pad, zMax + pad],
    },
    edgeLength: options.edgeLength,
  };
}

export function buildVariableSweepLevelSetInput(
  sections: { t: number; polygons: Vec2[][] }[],
  pathPoints: Vec3[],
  options: {
    edgeLength: number;
    boundsPadding: number;
    up: Vec3;
  },
): LevelSetInput {
  if (pathPoints.length < 2) {
    throw new Error('variableSweep requires a path with at least two points');
  }
  if (sections.length < 2) {
    throw new Error('variableSweep requires at least two sections');
  }

  // Sort sections by t
  const sortedSections = [...sections].sort((a, b) => a.t - b.t);

  // Compile an SDF for each section profile
  const sectionSdfs = sortedSections.map((s) => ({
    t: s.t,
    sdf: compilePolygonsSdf(s.polygons),
  }));

  // Build framed segments with rotation-minimizing frames (no twist/flips).
  const { segments, totalLen } = buildSweepRuntime(pathPoints, options.up);

  // Compute max profile radius across all sections for bounds padding
  let profileRadius = 0;
  for (const section of sortedSections) {
    for (const loop of section.polygons) {
      for (const [x, y] of loop) {
        profileRadius = Math.max(profileRadius, Math.abs(x), Math.abs(y));
      }
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const [x, y, z] of pathPoints) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  const pad = Math.max(options.boundsPadding, profileRadius);

  /** Interpolate between section SDFs at a given t parameter. */
  function interpolatedSdf(u: number, q: number, tParam: number): number {
    const tc = clamp(tParam, sortedSections[0].t, sortedSections[sortedSections.length - 1].t);

    // Find the two bracketing sections
    if (tc <= sectionSdfs[0].t) return sectionSdfs[0].sdf(u, q);
    if (tc >= sectionSdfs[sectionSdfs.length - 1].t) return sectionSdfs[sectionSdfs.length - 1].sdf(u, q);

    let idx = 0;
    while (idx + 1 < sectionSdfs.length && tc > sectionSdfs[idx + 1].t) idx += 1;

    const s0 = sectionSdfs[idx];
    const s1 = sectionSdfs[idx + 1];
    const blend = (tc - s0.t) / (s1.t - s0.t);
    const f0 = s0.sdf(u, q);
    const f1 = s1.sdf(u, q);
    return f0 * (1 - blend) + f1 * blend;
  }

  const startSeg = segments[0];
  const endSeg = segments[segments.length - 1];

  return {
    sdf: (point) => {
      // Single nearest-segment query, then one profile evaluation. The
      // continuous parallel-transport frame keeps the field smooth across
      // joints, so no max-over-all-segments blend is needed.
      const nearest = findNearestSweepPoint(point, segments);
      const local = vec3Sub(point, nearest.frame.origin);
      const u = vec3Dot(local, nearest.frame.x);
      const q = vec3Dot(local, nearest.frame.y);
      const tAtPoint = totalLen > 1e-9 ? nearest.arcLength / totalLen : 0;
      let field = interpolatedSdf(u, q, tAtPoint);
      // Flat end caps so the tube does not bleed past its endpoints.
      if (nearest.isStart) {
        const startCap = vec3Dot(vec3Sub(point, startSeg.frameA.origin), startSeg.frameA.t);
        field = Math.min(field, startCap);
      } else if (nearest.isEnd) {
        const endCap = -vec3Dot(vec3Sub(point, endSeg.frameB.origin), endSeg.frameB.t);
        field = Math.min(field, endCap);
      }
      return field;
    },
    bounds: {
      min: [minX - pad, minY - pad, minZ - pad],
      max: [maxX + pad, maxY + pad, maxZ + pad],
    },
    edgeLength: options.edgeLength,
  };
}

export function buildSweepLevelSetInput(
  profilePolygons: Vec2[][],
  pathPoints: Vec3[],
  options: {
    edgeLength: number;
    boundsPadding: number;
    up: Vec3;
  },
): LevelSetInput {
  if (pathPoints.length < 2) {
    throw new Error('sweep requires a path with at least two points');
  }

  const profileSdf = compilePolygonsSdf(profilePolygons);
  const { segments } = buildSweepRuntime(pathPoints, options.up);

  let profileRadius = 0;
  for (const loop of profilePolygons) {
    for (const [x, y] of loop) {
      profileRadius = Math.max(profileRadius, Math.abs(x), Math.abs(y));
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const [x, y, z] of pathPoints) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  const pad = Math.max(options.boundsPadding, profileRadius);

  const startSeg = segments[0];
  const endSeg = segments[segments.length - 1];

  return {
    sdf: (point) => {
      // Single nearest-segment query + one profile evaluation, with smooth
      // parallel-transport frames so the swept tube stays connected.
      const nearest = findNearestSweepPoint(point, segments);
      const local = vec3Sub(point, nearest.frame.origin);
      const u = vec3Dot(local, nearest.frame.x);
      const q = vec3Dot(local, nearest.frame.y);
      let field = profileSdf(u, q);
      if (nearest.isStart) {
        const startCap = vec3Dot(vec3Sub(point, startSeg.frameA.origin), startSeg.frameA.t);
        field = Math.min(field, startCap);
      } else if (nearest.isEnd) {
        const endCap = -vec3Dot(vec3Sub(point, endSeg.frameB.origin), endSeg.frameB.t);
        field = Math.min(field, endCap);
      }
      return field;
    },
    bounds: {
      min: [minX - pad, minY - pad, minZ - pad],
      max: [maxX + pad, maxY + pad, maxZ + pad],
    },
    edgeLength: options.edgeLength,
  };
}

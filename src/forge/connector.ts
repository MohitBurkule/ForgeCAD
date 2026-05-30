import type { PortDef, PortInput, PortMap } from './port';
import { normalizePortInput } from './port';
import type { Vec3 } from './transform';
import { Transform } from './transform';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectorGender = 'male' | 'female' | 'neutral';

export interface ConnectorInput extends PortInput {
  connectorType?: string;
  gender?: ConnectorGender;
  measurements?: Record<string, number | string>;
}

// ConnectorDef / ConnectorMap are connector-native aliases for the normalized
// port shapes we store internally. Connectors are represented as ports plus
// optional connector metadata.
export type ConnectorDef = PortDef;
export type ConnectorMap = PortMap;

export interface MatchToOptions {
  force?: boolean;
  angle?: number;
  distance?: number;
}

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

function makeConnector(
  gender: ConnectorGender | undefined,
  connectorType: string | undefined,
  input: PortInput,
  measurements?: Record<string, number | string>,
): ConnectorInput {
  if (connectorType != null && (typeof connectorType !== 'string' || connectorType === '')) {
    throw new Error('connector type must be a non-empty string');
  }
  const out: ConnectorInput = { ...input };
  if (connectorType != null) out.connectorType = connectorType;
  if (gender != null) out.gender = gender;
  if (measurements != null) out.measurements = measurements;
  return out;
}

/**
 * Create a connector — a named attachment point on a shape.
 *
 * Overloads:
 * - `connector(geometry)` — bare connector (position + orientation only)
 * - `connector(type, geometry)` — typed connector for compatibility matching
 * - `connector(type, geometry, measurements)` — typed with measurement metadata
 */
function connectorFactory(
  typeOrInput: string | PortInput,
  inputOrMeasurements?: PortInput | Record<string, number | string>,
  measurements?: Record<string, number | string>,
): ConnectorInput {
  if (typeof typeOrInput !== 'string') {
    // connector(geometry) — bare connector
    return makeConnector(undefined, undefined, typeOrInput);
  }
  // connector(type, geometry, measurements?)
  return makeConnector(undefined, typeOrInput, inputOrMeasurements as PortInput, measurements);
}

connectorFactory.male = (
  typeOrInput: string | PortInput,
  inputOrMeasurements?: PortInput | Record<string, number | string>,
  measurements?: Record<string, number | string>,
): ConnectorInput => {
  if (typeof typeOrInput !== 'string') {
    return makeConnector('male', undefined, typeOrInput);
  }
  return makeConnector('male', typeOrInput, inputOrMeasurements as PortInput, measurements);
};

connectorFactory.female = (
  typeOrInput: string | PortInput,
  inputOrMeasurements?: PortInput | Record<string, number | string>,
  measurements?: Record<string, number | string>,
): ConnectorInput => {
  if (typeof typeOrInput !== 'string') {
    return makeConnector('female', undefined, typeOrInput);
  }
  return makeConnector('female', typeOrInput, inputOrMeasurements as PortInput, measurements);
};

connectorFactory.neutral = (
  typeOrInput: string | PortInput,
  inputOrMeasurements?: PortInput | Record<string, number | string>,
  measurements?: Record<string, number | string>,
): ConnectorInput => {
  if (typeof typeOrInput !== 'string') {
    return makeConnector('neutral', undefined, typeOrInput);
  }
  return makeConnector('neutral', typeOrInput, inputOrMeasurements as PortInput, measurements);
};

export { connectorFactory as connector };

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function normalizeConnectorInput(input: ConnectorInput): ConnectorDef {
  const def = normalizePortInput(input);
  if (input.connectorType != null) def.connectorType = input.connectorType;
  if (input.gender != null) def.gender = input.gender;
  if (input.measurements != null) {
    def.measurements = { ...input.measurements };
  }
  return def;
}

export function normalizeConnectorMapInput(input: Record<string, ConnectorInput>): ConnectorMap {
  const out: ConnectorMap = {};
  for (const [name, connInput] of Object.entries(input)) {
    out[name] = normalizeConnectorInput(connInput);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateConnectorMatch(selfName: string, selfPort: PortDef, targetName: string, targetPort: PortDef, force: boolean): void {
  if (force) return;

  const selfType = selfPort.connectorType;
  const targetType = targetPort.connectorType;
  const selfGender = selfPort.gender;
  const targetGender = targetPort.gender;

  // Both must be connectors (have type)
  if (!selfType && !targetType) return; // plain ports, no validation
  if (selfType && !targetType) {
    throw new Error(
      `matchTo: "${selfName}" is a typed connector ("${selfType}") but "${targetName}" is an untyped connector with no connector type. Use { force: true } to override.`,
    );
  }
  if (!selfType && targetType) {
    throw new Error(
      `matchTo: "${targetName}" is a typed connector ("${targetType}") but "${selfName}" is an untyped connector with no connector type. Use { force: true } to override.`,
    );
  }

  // Type must match
  if (selfType !== targetType) {
    throw new Error(
      `matchTo: connector type mismatch — "${selfName}" is "${selfType}" but "${targetName}" is "${targetType}". Use { force: true } to override.`,
    );
  }

  // Gender check: male↔female or either is neutral
  if (selfGender && targetGender) {
    if (selfGender !== 'neutral' && targetGender !== 'neutral' && selfGender === targetGender) {
      throw new Error(
        `matchTo: gender mismatch — "${selfName}" (${selfGender}) cannot match "${targetName}" (${targetGender}). Male must match female. Use { force: true } to override.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Single-pair alignment: compute Mat4 to move child so its connector
// aligns with the target connector (axes anti-parallel, origins coincident).
//
// This is a simplified version of computeConnectFrame() that doesn't need
// the assembly kinematic chain — it computes a direct world-space transform.
// ---------------------------------------------------------------------------

function len3(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function normalize3(v: Vec3): Vec3 {
  const l = len3(v);
  if (l < 1e-10) throw new Error('Cannot normalize zero-length vector');
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function negate3(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

/**
 * Compute the rotation matrix (as Mat4) that maps basis [cRight, cUp, cAxis]
 * to basis [pRight, pUp, pAxis], then translates so child origin lands on parent origin.
 */
function alignmentMatrix(
  childOrigin: Vec3,
  childAxis: Vec3,
  childUp: Vec3,
  parentOrigin: Vec3,
  parentAxis: Vec3,
  parentUp: Vec3,
): Transform {
  const cRight = normalize3(cross3(childAxis, childUp));
  const pRight = normalize3(cross3(parentAxis, parentUp));

  // Rotation R: maps [cRight, cUp, cAxis] → [pRight, pUp, pAxis]
  const r00 = pRight[0] * cRight[0] + parentUp[0] * childUp[0] + parentAxis[0] * childAxis[0];
  const r01 = pRight[0] * cRight[1] + parentUp[0] * childUp[1] + parentAxis[0] * childAxis[1];
  const r02 = pRight[0] * cRight[2] + parentUp[0] * childUp[2] + parentAxis[0] * childAxis[2];
  const r10 = pRight[1] * cRight[0] + parentUp[1] * childUp[0] + parentAxis[1] * childAxis[0];
  const r11 = pRight[1] * cRight[1] + parentUp[1] * childUp[1] + parentAxis[1] * childAxis[1];
  const r12 = pRight[1] * cRight[2] + parentUp[1] * childUp[2] + parentAxis[1] * childAxis[2];
  const r20 = pRight[2] * cRight[0] + parentUp[2] * childUp[0] + parentAxis[2] * childAxis[0];
  const r21 = pRight[2] * cRight[1] + parentUp[2] * childUp[1] + parentAxis[2] * childAxis[1];
  const r22 = pRight[2] * cRight[2] + parentUp[2] * childUp[2] + parentAxis[2] * childAxis[2];

  // Translation: t = parentOrigin - R * childOrigin
  const rc: Vec3 = [
    r00 * childOrigin[0] + r01 * childOrigin[1] + r02 * childOrigin[2],
    r10 * childOrigin[0] + r11 * childOrigin[1] + r12 * childOrigin[2],
    r20 * childOrigin[0] + r21 * childOrigin[1] + r22 * childOrigin[2],
  ];
  const t = sub3(parentOrigin, rc);

  return Transform.from([r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0, t[0], t[1], t[2], 1] as any);
}

/**
 * Compute the world-space transform matrix to move a child shape so that
 * its connector aligns with a target connector.
 *
 * Convention: axes are anti-parallel (plug-in model). The child's connector
 * axis is flipped to oppose the target's axis.
 */
export function computeSinglePairAlignment(childPort: PortDef, targetPort: PortDef): Transform {
  // Anti-parallel: child axis should oppose target axis
  const childAxis = childPort.axis;
  const childUp = childPort.up;
  const targetAxis = negate3(targetPort.axis);
  const targetUp = targetPort.up;

  return alignmentMatrix(childPort.origin, childAxis, childUp, targetPort.origin, targetAxis, targetUp);
}

// ---------------------------------------------------------------------------
// Multi-pair alignment (Kabsch algorithm)
// ---------------------------------------------------------------------------

/**
 * Kabsch algorithm: find the optimal rigid transform (rotation + translation)
 * that best aligns N source points to N target points in a least-squares sense.
 *
 * For 2+ pairs, uses SVD via the analytical solution for 3x3 matrices.
 * Returns the transform and per-pair residuals for validation.
 */
export function computeMultiPairAlignment(
  pairs: Array<{ childOrigin: Vec3; targetOrigin: Vec3 }>,
  childPorts: PortDef[],
  targetPorts: PortDef[],
  tolerance: number = 0.1,
): { transform: Transform; residuals: number[] } {
  const n = pairs.length;
  if (n === 0) throw new Error('matchTo: no connector pairs provided');

  if (n === 1) {
    // Delegate to single-pair with full axis alignment
    const tx = computeSinglePairAlignment(childPorts[0], targetPorts[0]);
    return { transform: tx, residuals: [0] };
  }

  // Compute centroids
  const srcCentroid: Vec3 = [0, 0, 0];
  const tgtCentroid: Vec3 = [0, 0, 0];
  for (const p of pairs) {
    srcCentroid[0] += p.childOrigin[0];
    srcCentroid[1] += p.childOrigin[1];
    srcCentroid[2] += p.childOrigin[2];
    tgtCentroid[0] += p.targetOrigin[0];
    tgtCentroid[1] += p.targetOrigin[1];
    tgtCentroid[2] += p.targetOrigin[2];
  }
  srcCentroid[0] /= n;
  srcCentroid[1] /= n;
  srcCentroid[2] /= n;
  tgtCentroid[0] /= n;
  tgtCentroid[1] /= n;
  tgtCentroid[2] /= n;

  // Build cross-covariance matrix H = Σ (src_i - srcCentroid) * (tgt_i - tgtCentroid)^T
  // H is 3x3, stored as h[row][col]
  const h = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pairs) {
    const s = sub3(p.childOrigin, srcCentroid);
    const t = sub3(p.targetOrigin, tgtCentroid);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        h[i][j] += s[i] * t[j];
      }
    }
  }

  // SVD of 3x3 matrix via eigenvalue decomposition of H^T * H
  // For a 3x3, we use the analytical approach via quaternion method
  const R = kabschRotation(h);

  // Translation: t = tgtCentroid - R * srcCentroid
  const rSrc: Vec3 = [
    R[0][0] * srcCentroid[0] + R[0][1] * srcCentroid[1] + R[0][2] * srcCentroid[2],
    R[1][0] * srcCentroid[0] + R[1][1] * srcCentroid[1] + R[1][2] * srcCentroid[2],
    R[2][0] * srcCentroid[0] + R[2][1] * srcCentroid[1] + R[2][2] * srcCentroid[2],
  ];
  const t = sub3(tgtCentroid, rSrc);

  const transform = Transform.from([
    R[0][0],
    R[1][0],
    R[2][0],
    0,
    R[0][1],
    R[1][1],
    R[2][1],
    0,
    R[0][2],
    R[1][2],
    R[2][2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ] as any);

  // Compute residuals
  const residuals: number[] = [];
  for (const p of pairs) {
    const transformed = transform.point(p.childOrigin);
    const diff = sub3(transformed, p.targetOrigin);
    residuals.push(len3(diff));
  }

  // Check tolerance
  const maxResidual = Math.max(...residuals);
  if (maxResidual > tolerance) {
    const worstIdx = residuals.indexOf(maxResidual);
    throw new Error(
      `matchTo: connector pairs are inconsistent — pair ${worstIdx} has ${maxResidual.toFixed(3)}mm residual after best-fit (tolerance: ${tolerance}mm). Check that the parts' geometry is compatible.`,
    );
  }

  return { transform, residuals };
}

/**
 * Compute optimal rotation matrix from 3x3 cross-covariance matrix H
 * using SVD. For 3x3, we compute H^T*H eigenvalues via cubic formula,
 * then reconstruct U and V.
 *
 * Simplified approach: use the polar decomposition via iterative method.
 * For our use case (typically 2-6 connector pairs), this is fast enough.
 */
function kabschRotation(h: number[][]): number[][] {
  // Compute H^T * H
  const hth = mat3Mul(mat3Transpose(h), h);

  // Get eigenvalues and eigenvectors of H^T * H (symmetric positive semi-definite)
  const { values, vectors } = symmetricEigen3(hth);

  // Singular values are sqrt of eigenvalues
  const singularValues = values.map((v) => Math.sqrt(Math.max(0, v)));

  // V = eigenvectors of H^T*H (columns)
  const V = vectors;

  // U = H * V * Σ^{-1}
  const U: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let col = 0; col < 3; col++) {
    if (singularValues[col] < 1e-10) continue;
    const invS = 1 / singularValues[col];
    const hv: number[] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 3; k++) {
        hv[i] += h[i][k] * V[k][col];
      }
    }
    for (let i = 0; i < 3; i++) {
      U[i][col] = hv[i] * invS;
    }
  }

  // Ensure proper rotation (det = +1)
  const detU = mat3Det(U);
  const detV = mat3Det(V);
  const d = detU * detV < 0 ? -1 : 1;

  // R = U * diag(1, 1, d) * V^T
  const S = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, d],
  ];
  return mat3Mul(mat3Mul(U, S), mat3Transpose(V));
}

// ---------------------------------------------------------------------------
// 3x3 matrix helpers for Kabsch
// ---------------------------------------------------------------------------

function mat3Mul(a: number[][], b: number[][]): number[][] {
  const r: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        r[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return r;
}

function mat3Transpose(m: number[][]): number[][] {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

function mat3Det(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

/**
 * Eigenvalue decomposition of a 3x3 symmetric matrix.
 * Uses the analytical cubic formula for eigenvalues, then power iteration for eigenvectors.
 */
function symmetricEigen3(m: number[][]): { values: number[]; vectors: number[][] } {
  // Characteristic polynomial: λ³ - tr(A)λ² + (sum of 2x2 minors)λ - det(A) = 0
  const a = m[0][0],
    b = m[0][1],
    c = m[0][2];
  const d = m[1][1],
    e = m[1][2];
  const f = m[2][2];

  const p1 = b * b + c * c + e * e;
  if (p1 < 1e-20) {
    // Already diagonal
    const vals = [a, d, f];
    const vecs = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    // Sort descending
    const indices = [0, 1, 2].sort((i, j) => vals[j] - vals[i]);
    return {
      values: indices.map((i) => vals[i]),
      vectors: reorderColumns(vecs, indices),
    };
  }

  const q = (a + d + f) / 3;
  const p2 = (a - q) * (a - q) + (d - q) * (d - q) + (f - q) * (f - q) + 2 * p1;
  const p = Math.sqrt(p2 / 6);

  // B = (1/p) * (A - q*I)
  const B = [
    [(a - q) / p, b / p, c / p],
    [b / p, (d - q) / p, e / p],
    [c / p, e / p, (f - q) / p],
  ];

  const detB = mat3Det(B);
  let r = detB / 2;
  // Clamp for numerical stability
  r = Math.max(-1, Math.min(1, r));
  const phi = Math.acos(r) / 3;

  const eig1 = q + 2 * p * Math.cos(phi);
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const eig2 = 3 * q - eig1 - eig3; // trace = sum of eigenvalues

  // Sort descending
  const eigenvalues = [eig1, eig2, eig3].sort((a, b) => b - a);

  // Compute eigenvectors by solving (A - λI)v = 0
  const eigenvectors: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let idx = 0; idx < 3; idx++) {
    const lam = eigenvalues[idx];
    const v = nullSpaceVector(
      [
        [a - lam, b, c],
        [b, d - lam, e],
        [c, e, f - lam],
      ],
      eigenvectors.slice(0, idx),
    );
    eigenvectors[idx] = v;
  }

  // Store as columns for V matrix
  const vectors: number[][] = [
    [eigenvectors[0][0], eigenvectors[1][0], eigenvectors[2][0]],
    [eigenvectors[0][1], eigenvectors[1][1], eigenvectors[2][1]],
    [eigenvectors[0][2], eigenvectors[1][2], eigenvectors[2][2]],
  ];

  return { values: eigenvalues, vectors };
}

function reorderColumns(vecs: number[][], indices: number[]): number[][] {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let col = 0; col < 3; col++) {
    const srcCol = indices[col];
    for (let row = 0; row < 3; row++) {
      out[row][col] = vecs[row][srcCol];
    }
  }
  return out;
}

/**
 * Find a unit vector in the null space of a 3x3 matrix,
 * orthogonal to any previously found eigenvectors.
 */
function nullSpaceVector(m: number[][], previousVecs: number[][]): number[] {
  // Try cross product of two rows (pick the pair with largest cross product)
  const rows = [
    [m[0][0], m[0][1], m[0][2]],
    [m[1][0], m[1][1], m[1][2]],
    [m[2][0], m[2][1], m[2][2]],
  ];

  let bestVec: number[] = [0, 0, 0];
  let bestLen = 0;

  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const c = [
        rows[i][1] * rows[j][2] - rows[i][2] * rows[j][1],
        rows[i][2] * rows[j][0] - rows[i][0] * rows[j][2],
        rows[i][0] * rows[j][1] - rows[i][1] * rows[j][0],
      ];
      const l = Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
      if (l > bestLen) {
        bestLen = l;
        bestVec = [c[0] / l, c[1] / l, c[2] / l];
      }
    }
  }

  if (bestLen < 1e-10) {
    // Degenerate: pick any vector orthogonal to previous eigenvectors
    if (previousVecs.length === 0) return [1, 0, 0];
    if (previousVecs.length === 1) {
      const p = previousVecs[0];
      const absX = Math.abs(p[0]);
      const absZ = Math.abs(p[2]);
      const seed: number[] = absX < absZ ? [1, 0, 0] : [0, 0, 1];
      const c = [p[1] * seed[2] - p[2] * seed[1], p[2] * seed[0] - p[0] * seed[2], p[0] * seed[1] - p[1] * seed[0]];
      const l = Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
      return l > 1e-10 ? [c[0] / l, c[1] / l, c[2] / l] : [0, 1, 0];
    }
    // Two previous: cross them
    const a = previousVecs[0];
    const b = previousVecs[1];
    const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const l = Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
    return l > 1e-10 ? [c[0] / l, c[1] / l, c[2] / l] : [0, 0, 1];
  }

  // Orthogonalize against previous eigenvectors
  let v = bestVec;
  for (const prev of previousVecs) {
    const d = v[0] * prev[0] + v[1] * prev[1] + v[2] * prev[2];
    v = [v[0] - d * prev[0], v[1] - d * prev[1], v[2] - d * prev[2]];
  }
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (l < 1e-10) return [0, 0, 1]; // fallback
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function getConnectorNames(ports: ConnectorMap): string[] {
  return Object.keys(ports).sort();
}

export function getConnectorsByType(ports: ConnectorMap, type: string): Array<{ name: string; port: ConnectorDef }> {
  return Object.entries(ports)
    .filter(([, p]) => p.connectorType === type)
    .map(([name, port]) => ({ name, port }));
}

export function getConnectorDistance(ports: ConnectorMap, nameA: string, nameB: string): number {
  const a = ports[nameA];
  const b = ports[nameB];
  if (!a) throw new Error(`connectorDistance: unknown connector "${nameA}"`);
  if (!b) throw new Error(`connectorDistance: unknown connector "${nameB}"`);
  const d = sub3(a.origin, b.origin);
  return len3(d);
}

export function getConnectorMeasurements(ports: ConnectorMap, name: string): Record<string, number | string> {
  const p = ports[name];
  if (!p) throw new Error(`connectorMeasurements: unknown connector "${name}"`);
  return p.measurements ? { ...p.measurements } : {};
}

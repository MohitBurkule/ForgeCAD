/**
 * Geometry helpers for drive wheel regions.
 */

import { Shape, cylinder } from '../../kernel';
import { difference2d, union2d } from '../../sketch/booleans';
import { Sketch } from '../../sketch/core';
import { sketchExtrude } from '../../sketch/extrude';
import { circle2d, polygon } from '../../sketch/primitives';
import { sketchRotateAround } from '../../sketch/transforms';
import { EPSILON, GearMeta, addArcPoints, isFinitePositive, remapErrorPrefix } from './infrastructure';
import { buildSpurGearMeta, createSpurToothSketch, normalizeSpurGearOptions } from './spur';
import { DriveWheelRegionRecord, DriveWheelSolidArcRegionOptions, DriveWheelSpurTeethRegionOptions } from './drive-wheel-types';

interface Bounds3D {
  min: [number, number, number];
  max: [number, number, number];
}

export function requirePositive(scope: string, name: string, value: number): void {
  if (!isFinitePositive(value)) throw new Error(`${scope}: "${name}" must be > 0`);
}

export function requireFiniteAngle(scope: string, name: string, value: number | undefined): void {
  if (value !== undefined && !Number.isFinite(value)) throw new Error(`${scope}: "${name}" must be finite`);
}

export function cutBore(shape: Shape, boreDiameter: number): Shape {
  if (boreDiameter <= 0) return shape;
  const bounds = shape.boundingBox() as Bounds3D;
  const height = bounds.max[2] - bounds.min[2] + 2;
  const cutter = cylinder(height, boreDiameter * 0.5, undefined, 64).translate(0, 0, bounds.min[2] - 1);
  return shape.subtract(cutter);
}

export function bodyOuterRadius(shape: Shape): number | undefined {
  const bounds = shape.boundingBox() as Bounds3D;
  return Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]), Math.abs(bounds.min[1]), Math.abs(bounds.max[1]));
}

export function buildSpurTeethRegion(options: DriveWheelSpurTeethRegionOptions, name: string, faceWidth: number): DriveWheelRegionRecord {
  const scope = 'driveWheel.addSpurTeethBetween';
  const teethOnFullCircle = options.teethOnFullCircle;
  if (!Number.isInteger(teethOnFullCircle) || teethOnFullCircle < 6) {
    throw new Error(`${scope}: "teethOnFullCircle" must be an integer >= 6`);
  }
  const toothCount = options.toothCount;
  if (!Number.isInteger(toothCount) || toothCount < 1 || toothCount > teethOnFullCircle) {
    throw new Error(`${scope}: "toothCount" must be an integer in [1, teethOnFullCircle]`);
  }
  const firstTooth = options.firstTooth ?? 0;
  if (!Number.isInteger(firstTooth) || firstTooth < 0 || firstTooth >= teethOnFullCircle) {
    throw new Error(`${scope}: "firstTooth" must be an integer in [0, teethOnFullCircle)`);
  }

  let normalized: ReturnType<typeof normalizeSpurGearOptions>;
  try {
    normalized = normalizeSpurGearOptions({ ...options, teeth: teethOnFullCircle, faceWidth, boreDiameter: 0 });
  } catch (error) {
    remapErrorPrefix(error, 'spurGear', scope);
  }

  const gearMeta = buildSpurGearMeta(normalized);
  const pitchStepDeg = 360 / teethOnFullCircle;
  const fromAngleDeg = firstTooth * pitchStepDeg - pitchStepDeg * 0.5;
  const toAngleDeg = (firstTooth + toothCount - 1) * pitchStepDeg + pitchStepDeg * 0.5;
  const profile = buildSpurToothRegionProfile(gearMeta, firstTooth, toothCount, normalized.segmentsPerTooth);

  return {
    shape: sketchExtrude(profile, faceWidth).toShape(),
    gearMeta,
    meta: {
      name,
      kind: 'spurTeeth',
      fromAngleDeg,
      toAngleDeg,
      outerRadius: gearMeta.outerRadius,
      rootRadius: gearMeta.rootRadius,
      pitchRadius: gearMeta.pitchRadius,
      module: normalized.module,
      teethOnFullCircle,
      toothCount,
      faceWidth,
    },
  };
}

export function buildSolidArcRegion(options: DriveWheelSolidArcRegionOptions, name: string, faceWidth: number): DriveWheelRegionRecord {
  const scope = 'driveWheel.addSolidArcBetween';
  requirePositive(scope, 'outerRadius', options.outerRadius);
  const innerRadius = options.innerRadius ?? 0;
  if (!Number.isFinite(innerRadius) || innerRadius < 0) throw new Error(`${scope}: "innerRadius" must be >= 0`);
  if (innerRadius >= options.outerRadius) throw new Error(`${scope}: "innerRadius" must be smaller than "outerRadius"`);
  const sweepDeg = normalizedSweep(scope, options.fromAngleDeg, options.toAngleDeg);

  return {
    shape: sketchExtrude(buildSolidArcProfile(options, sweepDeg), faceWidth).toShape(),
    meta: {
      name,
      kind: 'solidArc',
      fromAngleDeg: options.fromAngleDeg,
      toAngleDeg: options.fromAngleDeg + sweepDeg,
      innerRadius,
      outerRadius: options.outerRadius,
      faceWidth,
    },
  };
}

function normalizedSweep(scope: string, fromAngleDeg: number, toAngleDeg: number): number {
  if (!Number.isFinite(fromAngleDeg)) throw new Error(`${scope}: "fromAngleDeg" must be finite`);
  if (!Number.isFinite(toAngleDeg)) throw new Error(`${scope}: "toAngleDeg" must be finite`);
  let sweep = toAngleDeg - fromAngleDeg;
  while (sweep <= 0) sweep += 360;
  if (sweep > 360 + EPSILON) throw new Error(`${scope}: angular sweep must be <= 360 degrees`);
  return Math.min(360, sweep);
}

function buildSpurToothRegionProfile(meta: GearMeta, firstTooth: number, toothCount: number, segmentsPerTooth: number): Sketch {
  const tooth = createSpurToothSketch(meta, segmentsPerTooth);
  const teeth: Sketch[] = [];
  for (let i = 0; i < toothCount; i++) {
    teeth.push(sketchRotateAround(tooth, (360 / meta.teeth) * (firstTooth + i), [0, 0]));
  }
  return union2d(...teeth);
}

function buildSolidArcProfile(options: DriveWheelSolidArcRegionOptions, sweepDeg: number): Sketch {
  const innerRadius = options.innerRadius ?? 0;
  const segments = options.segments ?? Math.max(16, Math.ceil(sweepDeg / 6));
  if (!Number.isInteger(segments) || segments < 4) throw new Error('driveWheel.addSolidArcBetween: "segments" must be an integer >= 4');

  if (Math.abs(sweepDeg - 360) < EPSILON) {
    const outer = circle2d(options.outerRadius, segments);
    return innerRadius > 0 ? difference2d(outer, circle2d(innerRadius, segments)) : outer;
  }

  const start = (options.fromAngleDeg * Math.PI) / 180;
  const end = start + (sweepDeg * Math.PI) / 180;
  const pts: [number, number][] = [];
  if (innerRadius <= 0) pts.push([0, 0]);
  addArcPoints(pts, options.outerRadius, start, end, segments, true, true);
  if (innerRadius > 0) addArcPoints(pts, innerRadius, end, start, segments, true, true);
  return polygon(pts);
}

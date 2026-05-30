/**
 * Drive wheel public metadata and option types.
 */

import { Shape } from '../../kernel';
import { GearMeta } from './infrastructure';
import { SpurGearOptions } from './spur';

export const DRIVE_WHEEL_META_KEY = Symbol.for('forgecad.library.driveWheelMeta');

export type DriveWheelRegionKind = 'body' | 'spurTeeth' | 'solidArc' | 'custom';

export interface DriveWheelRegionMeta {
  name: string;
  kind: DriveWheelRegionKind;
  fromAngleDeg?: number;
  toAngleDeg?: number;
  innerRadius?: number;
  outerRadius?: number;
  module?: number;
  teethOnFullCircle?: number;
  toothCount?: number;
  pitchRadius?: number;
  rootRadius?: number;
  faceWidth?: number;
}

export interface DriveWheelMeta {
  kind: 'driveWheel';
  faceWidth: number;
  boreDiameter: number;
  regions: DriveWheelRegionMeta[];
}

export interface DriveWheelOptions {
  body?: Shape;
  faceWidth?: number;
  boreDiameter?: number;
}

export interface DriveWheelSpurTeethRegionOptions extends Omit<SpurGearOptions, 'teeth' | 'faceWidth' | 'boreDiameter'> {
  name?: string;
  teethOnFullCircle: number;
  toothCount: number;
  firstTooth?: number;
  faceWidth?: number;
}

export interface DriveWheelSolidArcRegionOptions {
  name?: string;
  fromAngleDeg: number;
  toAngleDeg: number;
  innerRadius?: number;
  outerRadius: number;
  faceWidth?: number;
  segments?: number;
}

export interface DriveWheelShapeRegionOptions {
  fromAngleDeg?: number;
  toAngleDeg?: number;
  innerRadius?: number;
  outerRadius?: number;
}

export interface DriveWheelRegionRecord {
  shape: Shape;
  meta: DriveWheelRegionMeta;
  gearMeta?: GearMeta;
}

export function attachDriveWheelMeta(shape: Shape, meta: DriveWheelMeta): Shape {
  (shape as Shape & { [DRIVE_WHEEL_META_KEY]?: DriveWheelMeta })[DRIVE_WHEEL_META_KEY] = meta;
  return shape;
}

/**
 * Read the functional-region metadata attached by `driveWheel().build()`.
 */
export function readDriveWheelMeta(shape: Shape): DriveWheelMeta | null {
  const meta = (shape as Shape & { [DRIVE_WHEEL_META_KEY]?: DriveWheelMeta })[DRIVE_WHEEL_META_KEY];
  return meta ?? null;
}

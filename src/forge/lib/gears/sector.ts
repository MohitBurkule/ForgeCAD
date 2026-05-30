/**
 * Sector gear: a partial tooth window composed with an independent gear body.
 */

import { Shape } from '../../kernel';
import { attachGearMeta, GearMeta } from './infrastructure';
import { NormalizedSpurGearOptions, SpurGearOptions, buildSpurGearMeta, normalizeSpurGearOptions } from './spur';
import { driveWheel } from './drive-wheel';

export interface SectorGearOptions extends Omit<SpurGearOptions, 'teeth'> {
  teethOnFullCircle: number;
  toothCount: number;
  firstTooth?: number;
  body?: Shape;
}

function normalizeSectorGearOptions(options: SectorGearOptions): NormalizedSpurGearOptions & {
  teethOnFullCircle: number;
  toothCount: number;
  firstTooth: number;
  boreDiameter: number;
} {
  const teethOnFullCircle = options.teethOnFullCircle;
  if (!Number.isInteger(teethOnFullCircle) || teethOnFullCircle < 6) {
    throw new Error('sectorGear: "teethOnFullCircle" must be an integer >= 6');
  }
  const toothCount = options.toothCount;
  if (!Number.isInteger(toothCount) || toothCount < 1 || toothCount > teethOnFullCircle) {
    throw new Error('sectorGear: "toothCount" must be an integer in [1, teethOnFullCircle]');
  }
  const firstTooth = options.firstTooth ?? 0;
  if (!Number.isInteger(firstTooth) || firstTooth < 0 || firstTooth >= teethOnFullCircle) {
    throw new Error('sectorGear: "firstTooth" must be an integer in [0, teethOnFullCircle)');
  }

  return {
    ...normalizeSpurGearOptions({ ...options, teeth: teethOnFullCircle }),
    teethOnFullCircle,
    toothCount,
    firstTooth,
    boreDiameter: options.boreDiameter ?? 0,
  };
}

/**
 * Involute sector gear with teeth on only part of the pitch circle.
 *
 * Specify the full-circle pitch as `teethOnFullCircle`, then choose the active
 * tooth window with `firstTooth` and `toothCount`. The body is separate from
 * the tooth region: pass a `gearBody...` shape for spokes, hubs, and product
 * styling, or omit it for a simple root-radius disk.
 *
 * **Example**
 *
 * ```ts
 * const body = lib.gearBodies.spoked({
 *   outerRadius: 22, rimWidth: 3, hubDiameter: 10,
 *   spokeCount: 5, spokeWidth: 2.5, faceWidth: 8, boreDiameter: 5,
 * });
 * const sector = lib.sectorGear({
 *   module: 1.25, teethOnFullCircle: 36, toothCount: 10,
 *   faceWidth: 8, body,
 * });
 * ```
 */
export function sectorGear(options: SectorGearOptions): Shape {
  const normalized = normalizeSectorGearOptions(options);
  if (options.body !== undefined && !(options.body instanceof Shape)) {
    throw new Error('sectorGear: "body" must be a Shape');
  }
  const spurMeta = buildSpurGearMeta(normalized);
  const pitchStepDeg = 360 / normalized.teethOnFullCircle;
  const activeAngleStartDeg = normalized.firstTooth * pitchStepDeg - pitchStepDeg * 0.5;
  const activeAngleEndDeg = (normalized.firstTooth + normalized.toothCount - 1) * pitchStepDeg + pitchStepDeg * 0.5;

  const meta: GearMeta = {
    ...spurMeta,
    kind: 'sector',
    teethOnFullCircle: normalized.teethOnFullCircle,
    firstTooth: normalized.firstTooth,
    toothCount: normalized.toothCount,
    activeAngleStartDeg,
    activeAngleEndDeg,
  };
  const wheel = driveWheel({ body: options.body, faceWidth: normalized.faceWidth, boreDiameter: normalized.boreDiameter })
    .addSpurTeethBetween({
      name: 'teeth',
      module: normalized.module,
      teethOnFullCircle: normalized.teethOnFullCircle,
      toothCount: normalized.toothCount,
      firstTooth: normalized.firstTooth,
      pressureAngleDeg: normalized.pressureAngleDeg,
      faceWidth: normalized.faceWidth,
      backlash: normalized.backlash,
      clearance: normalized.clearance,
      addendum: normalized.addendum,
      dedendum: normalized.dedendum,
      segmentsPerTooth: normalized.segmentsPerTooth,
    })
    .build();
  return attachGearMeta(wheel, meta);
}

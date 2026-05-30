/**
 * Drive wheel builder: compose gear bodies with functional angular regions.
 */

import { Shape } from '../../kernel';
import { connector } from '../../connector';
import { gearBodyDisk } from './bodies';
import { EPSILON } from './infrastructure';
import {
  bodyOuterRadius,
  buildSolidArcRegion,
  buildSpurTeethRegion,
  cutBore,
  requireFiniteAngle,
  requirePositive,
} from './drive-wheel-geometry';
import {
  attachDriveWheelMeta,
  DriveWheelOptions,
  DriveWheelRegionMeta,
  DriveWheelRegionRecord,
  DriveWheelShapeRegionOptions,
  DriveWheelSolidArcRegionOptions,
  DriveWheelSpurTeethRegionOptions,
} from './drive-wheel-types';

export { DRIVE_WHEEL_META_KEY, readDriveWheelMeta } from './drive-wheel-types';
export type {
  DriveWheelMeta,
  DriveWheelOptions,
  DriveWheelRegionKind,
  DriveWheelRegionMeta,
  DriveWheelShapeRegionOptions,
  DriveWheelSolidArcRegionOptions,
  DriveWheelSpurTeethRegionOptions,
} from './drive-wheel-types';

/**
 * Builder for exceptional gears and drive wheels.
 *
 * Start with an optional visual/structural body, then add the angular regions
 * that actually do work: tooth windows, solid stop/dwell arcs, or arbitrary
 * custom shapes. `sectorGear()` is implemented as a thin recipe over this
 * builder.
 */
export class DriveWheelBuilder {
  private readonly body?: Shape;
  private readonly faceWidth?: number;
  private readonly boreDiameter: number;
  private readonly regions: DriveWheelRegionRecord[] = [];

  constructor(options: DriveWheelOptions = {}) {
    if (options.body !== undefined && !(options.body instanceof Shape)) throw new Error('driveWheel: "body" must be a Shape');
    if (options.faceWidth !== undefined) requirePositive('driveWheel', 'faceWidth', options.faceWidth);
    const boreDiameter = options.boreDiameter ?? 0;
    if (!Number.isFinite(boreDiameter) || boreDiameter < 0) throw new Error('driveWheel: "boreDiameter" must be >= 0');
    this.body = options.body;
    this.faceWidth = options.faceWidth;
    this.boreDiameter = boreDiameter;
  }

  /**
   * Add an involute spur-tooth window on part of the pitch circle.
   */
  addSpurTeethBetween(options: DriveWheelSpurTeethRegionOptions): this {
    const faceWidth = this.resolveFaceWidth('driveWheel.addSpurTeethBetween', options.faceWidth);
    this.regions.push(buildSpurTeethRegion(options, this.resolveName('teeth', options.name), faceWidth));
    return this;
  }

  /**
   * Add a constant-radius solid arc region such as a dwell, stop, or pusher.
   */
  addSolidArcBetween(options: DriveWheelSolidArcRegionOptions): this {
    const faceWidth = this.resolveFaceWidth('driveWheel.addSolidArcBetween', options.faceWidth);
    this.regions.push(buildSolidArcRegion(options, this.resolveName('arc', options.name), faceWidth));
    return this;
  }

  /**
   * Add a fully custom region shape while preserving region metadata.
   */
  addShapeRegion(name: string, shape: Shape, options: DriveWheelShapeRegionOptions = {}): this {
    const scope = 'driveWheel.addShapeRegion';
    if (typeof name !== 'string' || name.trim().length === 0) throw new Error(`${scope}: "name" must be a non-empty string`);
    if (!(shape instanceof Shape)) throw new Error(`${scope}: "shape" must be a Shape`);
    requireFiniteAngle(scope, 'fromAngleDeg', options.fromAngleDeg);
    requireFiniteAngle(scope, 'toAngleDeg', options.toAngleDeg);
    if (options.innerRadius !== undefined && (!Number.isFinite(options.innerRadius) || options.innerRadius < 0)) {
      throw new Error(`${scope}: "innerRadius" must be >= 0`);
    }
    if (options.outerRadius !== undefined) requirePositive(scope, 'outerRadius', options.outerRadius);

    this.regions.push({
      shape: shape.clone(),
      meta: {
        name: this.resolveName('region', name),
        kind: 'custom',
        ...options,
      },
    });
    return this;
  }

  /**
   * Build the final wheel shape with a bore connector and region metadata.
   */
  build(): Shape {
    if (this.regions.length === 0 && this.body === undefined) {
      throw new Error('driveWheel: add a body or at least one region before build()');
    }
    const faceWidth = this.resolveBuildFaceWidth();
    const firstGearRegion = this.regions.find((region) => region.gearMeta)?.gearMeta;
    if (firstGearRegion && this.boreDiameter * 0.5 >= firstGearRegion.rootRadius - EPSILON) {
      throw new Error('driveWheel: bore is too large for the first spur-tooth region');
    }

    const body = this.body?.clone() ?? gearBodyDisk({ outerRadius: firstGearRegion?.rootRadius ?? this.defaultBodyRadius(), faceWidth });
    let combined = body;
    for (const region of this.regions) combined = combined.add(region.shape);
    combined = cutBore(combined, this.boreDiameter);

    const withConnectors = combined.withConnectors({
      bore: connector(
        'drive-wheel-bore',
        { origin: [0, 0, faceWidth / 2], axis: [0, 0, 1], kind: 'revolute' },
        this.measurements(faceWidth),
      ),
    });
    return attachDriveWheelMeta(withConnectors, {
      kind: 'driveWheel',
      faceWidth,
      boreDiameter: this.boreDiameter,
      regions: this.regionMetadata(body, faceWidth),
    });
  }

  private measurements(faceWidth: number): Record<string, number> {
    const firstGearRegion = this.regions.find((region) => region.gearMeta)?.gearMeta;
    return {
      faceWidth,
      boreDiameter: this.boreDiameter,
      regionCount: this.regions.length,
      ...(firstGearRegion
        ? {
            module: firstGearRegion.module,
            teethOnFullCircle: firstGearRegion.teeth,
            pitchRadius: firstGearRegion.pitchRadius,
            outerRadius: firstGearRegion.outerRadius,
          }
        : {}),
    };
  }

  private regionMetadata(body: Shape, faceWidth: number): DriveWheelRegionMeta[] {
    return [
      { name: 'body', kind: 'body', outerRadius: bodyOuterRadius(body), faceWidth },
      ...this.regions.map((region) => ({ ...region.meta })),
    ];
  }

  private resolveFaceWidth(scope: string, localFaceWidth: number | undefined): number {
    const faceWidth = localFaceWidth ?? this.faceWidth;
    if (faceWidth === undefined) throw new Error(`${scope}: "faceWidth" is required unless driveWheel({ faceWidth }) was set`);
    requirePositive(scope, 'faceWidth', faceWidth);
    if (this.faceWidth !== undefined && localFaceWidth !== undefined && Math.abs(this.faceWidth - localFaceWidth) > EPSILON) {
      throw new Error(`${scope}: region faceWidth must match driveWheel faceWidth`);
    }
    return faceWidth;
  }

  private resolveBuildFaceWidth(): number {
    const faceWidth = this.faceWidth ?? this.regions.find((region) => region.meta.faceWidth !== undefined)?.meta.faceWidth;
    if (faceWidth === undefined) throw new Error('driveWheel: "faceWidth" is required before build()');
    return faceWidth;
  }

  private defaultBodyRadius(): number {
    const outerRadius = this.regions.reduce((max, region) => Math.max(max, region.meta.outerRadius ?? 0), 0);
    if (outerRadius <= 0) throw new Error('driveWheel: "body" is required when regions do not define an outer radius');
    return outerRadius;
  }

  private resolveName(prefix: string, requested: string | undefined): string {
    const base = requested?.trim() || prefix;
    if (this.regions.every((region) => region.meta.name !== base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}${i}`;
      if (this.regions.every((region) => region.meta.name !== candidate)) return candidate;
    }
  }
}

/**
 * Start a composable exceptional gear or drive wheel.
 */
export function driveWheel(options: DriveWheelOptions = {}): DriveWheelBuilder {
  return new DriveWheelBuilder(options);
}

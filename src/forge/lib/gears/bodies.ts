/**
 * Gear body presets for composing visual/structural gear wheels separately
 * from the tooth regions that do mechanical work.
 */

import { Shape, cylinder } from '../../kernel';
import { difference2d, union2d } from '../../sketch/booleans';
import { Sketch } from '../../sketch/core';
import { sketchExtrude } from '../../sketch/extrude';
import { circle2d, rect } from '../../sketch/primitives';
import { sketchRotateAround, sketchTranslate } from '../../sketch/transforms';
import { isFinitePositive } from './infrastructure';

export interface GearBodyDiskOptions {
  outerRadius: number;
  faceWidth: number;
  boreDiameter?: number;
  segments?: number;
}

export interface GearBodyDiskWithHubOptions extends GearBodyDiskOptions {
  hubDiameter: number;
  hubFaceWidth?: number;
}

export interface GearBodySpokedOptions extends GearBodyDiskOptions {
  rimWidth: number;
  hubDiameter: number;
  spokeCount: number;
  spokeWidth: number;
}

export interface GearBodyFromProfileOptions {
  faceWidth: number;
  boreDiameter?: number;
}

interface Bounds3D {
  min: [number, number, number];
  max: [number, number, number];
}

function requirePositive(scope: string, name: string, value: number): void {
  if (!isFinitePositive(value)) throw new Error(`${scope}: "${name}" must be > 0`);
}

function requireOptionalBore(scope: string, boreDiameter: number | undefined, maxDiameter: number): number {
  const bore = boreDiameter ?? 0;
  if (!Number.isFinite(bore) || bore < 0) throw new Error(`${scope}: "boreDiameter" must be >= 0`);
  if (bore > 0 && bore >= maxDiameter) throw new Error(`${scope}: bore is too large for the body`);
  return bore;
}

function resolveSegments(segments: number | undefined): number | undefined {
  if (segments === undefined) return undefined;
  if (!Number.isInteger(segments) || segments < 12) throw new Error('gear body: "segments" must be an integer >= 12');
  return segments;
}

function cutBore(shape: Shape, boreDiameter: number): Shape {
  if (boreDiameter <= 0) return shape;
  const bounds = shape.boundingBox() as Bounds3D;
  const height = bounds.max[2] - bounds.min[2] + 2;
  const cutter = cylinder(height, boreDiameter * 0.5, undefined, 64).translate(0, 0, bounds.min[2] - 1);
  return shape.subtract(cutter);
}

/**
 * Solid disk/ring gear body, independent from any tooth geometry.
 *
 * Use this when the body is visually simple but still needs a controlled bore
 * and face width before adding a sector or full tooth region.
 */
export function gearBodyDisk(options: GearBodyDiskOptions): Shape {
  requirePositive('gearBodyDisk', 'outerRadius', options.outerRadius);
  requirePositive('gearBodyDisk', 'faceWidth', options.faceWidth);
  const bore = requireOptionalBore('gearBodyDisk', options.boreDiameter, options.outerRadius * 2);
  const segments = resolveSegments(options.segments);
  const outer = circle2d(options.outerRadius, segments);
  const profile = bore > 0 ? difference2d(outer, circle2d(bore * 0.5, segments)) : outer;
  return sketchExtrude(profile, options.faceWidth).toShape();
}

/**
 * Disk gear body with a raised center hub.
 *
 * The hub is centered through the gear face: when `hubFaceWidth` is larger than
 * `faceWidth`, it protrudes equally from both sides.
 */
export function gearBodyDiskWithHub(options: GearBodyDiskWithHubOptions): Shape {
  requirePositive('gearBodyDiskWithHub', 'hubDiameter', options.hubDiameter);
  if (options.hubDiameter >= options.outerRadius * 2) {
    throw new Error('gearBodyDiskWithHub: "hubDiameter" must be smaller than the outer diameter');
  }
  const bore = requireOptionalBore('gearBodyDiskWithHub', options.boreDiameter, options.hubDiameter);
  const base = gearBodyDisk({ ...options, boreDiameter: 0 });
  const hubFaceWidth = options.hubFaceWidth ?? options.faceWidth * 1.5;
  requirePositive('gearBodyDiskWithHub', 'hubFaceWidth', hubFaceWidth);
  const hub = cylinder(hubFaceWidth, options.hubDiameter * 0.5, undefined, options.segments).translate(
    0,
    0,
    (options.faceWidth - hubFaceWidth) * 0.5,
  );
  return cutBore(base.add(hub), bore);
}

/**
 * Spoked gear body with an outer rim, center hub, and radial spokes.
 *
 * Teeth are not included; compose this with `sectorGear({ body })` or another
 * gear/tooth-region builder.
 */
export function gearBodySpoked(options: GearBodySpokedOptions): Shape {
  requirePositive('gearBodySpoked', 'outerRadius', options.outerRadius);
  requirePositive('gearBodySpoked', 'faceWidth', options.faceWidth);
  requirePositive('gearBodySpoked', 'rimWidth', options.rimWidth);
  requirePositive('gearBodySpoked', 'hubDiameter', options.hubDiameter);
  requirePositive('gearBodySpoked', 'spokeWidth', options.spokeWidth);
  if (!Number.isInteger(options.spokeCount) || options.spokeCount < 2) {
    throw new Error('gearBodySpoked: "spokeCount" must be an integer >= 2');
  }

  const hubRadius = options.hubDiameter * 0.5;
  const rimInnerRadius = options.outerRadius - options.rimWidth;
  if (rimInnerRadius <= hubRadius) throw new Error('gearBodySpoked: rim overlaps the hub');
  const bore = requireOptionalBore('gearBodySpoked', options.boreDiameter, options.hubDiameter);
  const segments = resolveSegments(options.segments);

  const rim = difference2d(circle2d(options.outerRadius, segments), circle2d(rimInnerRadius, segments));
  const hub = circle2d(hubRadius, segments);
  const spokeLength = rimInnerRadius - hubRadius + options.spokeWidth;
  const spokeCenter = hubRadius + spokeLength * 0.5 - options.spokeWidth * 0.5;
  const spoke = sketchTranslate(rect(spokeLength, options.spokeWidth), spokeCenter, 0);
  const spokes: Sketch[] = [];
  for (let i = 0; i < options.spokeCount; i++) {
    spokes.push(sketchRotateAround(spoke, (360 / options.spokeCount) * i, [0, 0]));
  }

  const profile = bore > 0 ? difference2d(union2d(rim, hub, ...spokes), circle2d(bore * 0.5, segments)) : union2d(rim, hub, ...spokes);
  return sketchExtrude(profile, options.faceWidth).toShape();
}

/**
 * Extrude a custom 2D profile into a gear body.
 *
 * Use this for brand shapes, asymmetric counterweights, or product-specific
 * wheel silhouettes while still composing functional tooth regions separately.
 */
export function gearBodyFromProfile(profile: Sketch, options: GearBodyFromProfileOptions): Shape {
  if (!(profile instanceof Sketch)) throw new Error('gearBodyFromProfile: "profile" must be a Sketch');
  requirePositive('gearBodyFromProfile', 'faceWidth', options.faceWidth);
  const bore = options.boreDiameter ?? 0;
  if (!Number.isFinite(bore) || bore < 0) throw new Error('gearBodyFromProfile: "boreDiameter" must be >= 0');
  return cutBore(sketchExtrude(profile, options.faceWidth).toShape(), bore);
}

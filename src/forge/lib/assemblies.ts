/**
 * Pre-built parametric mechanical assemblies.
 *
 * Each function returns a plain result object with:
 *   - `parts`: array of `{ name, shape }` for rendering / BOM,
 *   - named Shape handles (e.g. `cover`, `gland`, `screws`),
 *   - `dims`: reference dimensions for assertions and documentation.
 *
 * Geometry is built from the core kernel primitives and the existing
 * fastener helpers — no raw trigonometry, all positioning is axis-aligned
 * or via the `*Along*` orientation helpers below.
 */

import { box, cylinder, Shape, union } from '../kernel';
import { type MetricSize, METRIC_HOLE_TABLE, fastenerHole } from './basic-fasteners';
import { WASHER_TABLE, washer, fastenerSet } from './fasteners';

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function requireNonNegative(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number. Received: ${String(value)}`);
  }
  return value;
}

function resolveBoltInset(raw: number | [number, number] | undefined, fallback: number): [number, number] {
  if (raw === undefined) return [fallback, fallback];
  if (typeof raw === 'number') return [requirePositive(raw, 'boltInset'), requirePositive(raw, 'boltInset')];
  if (raw.length !== 2) throw new Error('boltInset tuple must be [x, y]');
  return [requirePositive(raw[0], 'boltInset[0]'), requirePositive(raw[1], 'boltInset[1]')];
}

function metricWasherSizeForPin(pinDiameter: number): MetricSize {
  if (pinDiameter <= 2) return 'M2';
  if (pinDiameter <= 2.5) return 'M2.5';
  if (pinDiameter <= 3) return 'M3';
  if (pinDiameter <= 4) return 'M4';
  if (pinDiameter <= 5) return 'M5';
  if (pinDiameter <= 6) return 'M6';
  if (pinDiameter <= 8) return 'M8';
  return 'M10';
}

// ---------------------------------------------------------------------------
// Orientation helpers — primitives are built along +Z; lay them along X/Y.
// ---------------------------------------------------------------------------

function cylinderAlongX(length: number, radius: number, xCenter: number, segments?: number): Shape {
  return cylinder(length, radius, undefined, segments).pointAlong([1, 0, 0]).translate(xCenter - length / 2, 0, 0);
}

function cylinderAlongY(length: number, radius: number, yCenter: number, segments?: number): Shape {
  return cylinder(length, radius, undefined, segments).pointAlong([0, 1, 0]).translate(0, yCenter - length / 2, 0);
}

function tubeAlongX(length: number, outerRadius: number, innerRadius: number, xCenter: number, segments?: number): Shape {
  return cylinderAlongX(length, outerRadius, xCenter, segments).subtract(cylinderAlongX(length + 0.4, innerRadius, xCenter, segments));
}

function tubeAlongY(length: number, outerRadius: number, innerRadius: number, yCenter: number, segments?: number): Shape {
  return cylinderAlongY(length, outerRadius, yCenter, segments).subtract(cylinderAlongY(length + 0.4, innerRadius, yCenter, segments));
}

function tubeAlongZ(height: number, outerRadius: number, innerRadius: number, segments?: number): Shape {
  return cylinder(height, outerRadius, undefined, segments).subtract(
    cylinder(height + 0.4, innerRadius, undefined, segments).translate(0, 0, -0.2),
  );
}

function washerAlongX(size: MetricSize, xCenter: number, segments?: number): Shape {
  const dims = WASHER_TABLE[size];
  return washer(size, { segments }).pointAlong([1, 0, 0]).translate(xCenter - dims.t / 2, 0, 0);
}

function placeCutterAtPositions(cutter: Shape, positions: ReadonlyArray<[number, number]>, z: number): Shape {
  return union(...positions.map(([x, y]) => cutter.translate(x, y, z)));
}

// ---------------------------------------------------------------------------
// Bolted service cover
// ---------------------------------------------------------------------------

function validateBoltPositionsForServiceCover(args: {
  positions: ReadonlyArray<[number, number]>;
  coverWidth: number;
  coverDepth: number;
  openingWidth: number;
  openingDepth: number;
  holeRadius: number;
}): void {
  args.positions.forEach(([x, y], index) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`boltedServiceCover: boltPositions[${index}] must contain finite numbers`);
    }
    if (Math.abs(x) + args.holeRadius >= args.coverWidth / 2 || Math.abs(y) + args.holeRadius >= args.coverDepth / 2) {
      throw new Error(`boltedServiceCover: boltPositions[${index}] is too close to the cover edge`);
    }
    const overlapsOpening =
      Math.abs(x) - args.holeRadius <= args.openingWidth / 2 && Math.abs(y) - args.holeRadius <= args.openingDepth / 2;
    if (overlapsOpening) {
      throw new Error(
        `boltedServiceCover: boltPositions[${index}] lands over the service opening; decrease boltInset, increase ledgeWidth, or provide a smaller opening`,
      );
    }
  });
}

export function boltedServiceCover(options: any) {
  const width = requirePositive(options.width, 'width');
  const depth = requirePositive(options.depth, 'depth');
  const coverThickness = requirePositive(options.coverThickness ?? 3, 'coverThickness');
  const parentThickness = requirePositive(options.parentThickness ?? 8, 'parentThickness');
  const ledgeWidth = requirePositive(options.ledgeWidth ?? 8, 'ledgeWidth');
  const gasketThickness = Math.max(0, options.gasketThickness ?? 0.8);
  const gasketInset = Math.max(0, options.gasketInset ?? 2);
  const screwSize: MetricSize = options.screwSize ?? 'M4';
  const segments = options.segments ?? 36;
  const sizeData = METRIC_HOLE_TABLE[screwSize];
  if (!sizeData) throw new Error(`boltedServiceCover: unsupported screwSize "${screwSize}"`);
  const screwLength = requirePositive(
    options.screwLength ?? parentThickness + gasketThickness + coverThickness + 4,
    'screwLength',
  );
  const coverFit = options.coverFit ?? 'normal';
  const counterboreEnabled = options.counterbore ?? true;
  const [insetX, insetY] = resolveBoltInset(options.boltInset, Math.max(ledgeWidth * 0.65, sizeData.head * 0.75));
  if (insetX * 2 >= width || insetY * 2 >= depth) {
    throw new Error('boltedServiceCover: boltInset leaves no room for a four-corner bolt pattern');
  }
  const boltPositions: Array<[number, number]> = options.boltPositions ?? [
    [-width / 2 + insetX, -depth / 2 + insetY],
    [width / 2 - insetX, -depth / 2 + insetY],
    [-width / 2 + insetX, depth / 2 - insetY],
    [width / 2 - insetX, depth / 2 - insetY],
  ];
  if (boltPositions.length === 0) throw new Error('boltedServiceCover: boltPositions must contain at least one point');
  const parentWidth = width + ledgeWidth * 2;
  const parentDepth = depth + ledgeWidth * 2;
  const openingWidth = Math.max(1, width - ledgeWidth * 2);
  const openingDepth = Math.max(1, depth - ledgeWidth * 2);
  validateBoltPositionsForServiceCover({
    positions: boltPositions,
    coverWidth: width,
    coverDepth: depth,
    openingWidth,
    openingDepth,
    holeRadius: sizeData[coverFit as 'normal'] / 2,
  });
  const coverHole = fastenerHole({
    size: screwSize,
    fit: coverFit,
    depth: coverThickness + 0.6,
    center: true,
    segments,
    ...(counterboreEnabled
      ? { counterbore: { depth: Math.min(coverThickness * 0.6, Math.max(0.6, coverThickness - 0.4)) } }
      : {}),
  });
  const parentTap = fastenerHole({ size: screwSize, fit: 'tap', depth: parentThickness + 0.6, center: true, segments });
  const parentThreadEnvelope = fastenerHole({
    size: screwSize,
    fit: 'close',
    depth: parentThickness + 0.6,
    center: true,
    segments,
  });
  const openingCutter = box(openingWidth, openingDepth, parentThickness + 1).translate(0, 0, -0.5);
  const parentTappedPattern = placeCutterAtPositions(parentTap, boltPositions, parentThickness / 2);
  const parentThreadEnvelopePattern = placeCutterAtPositions(parentThreadEnvelope, boltPositions, parentThickness / 2);
  const parent = box(parentWidth, parentDepth, parentThickness)
    .subtract(openingCutter)
    .subtract(parentThreadEnvelopePattern)
    .color('#4b5563');
  let coverBlank = box(width, depth, coverThickness);
  if (options.pullTabs ?? true) {
    const tabWidth = Math.min(width * 0.18, Math.max(sizeData.head * 1.6, 12));
    const tabDepth = Math.max(4, coverThickness * 1.4);
    const tabOverlap = Math.min(0.5, tabDepth * 0.25);
    const tabY = -depth / 2 - tabDepth / 2 + tabOverlap;
    const tabX = width * 0.23;
    coverBlank = union(
      coverBlank,
      box(tabWidth, tabDepth, coverThickness).translate(-tabX, tabY, 0),
      box(tabWidth, tabDepth, coverThickness).translate(tabX, tabY, 0),
    );
  }
  const coverClearancePattern = placeCutterAtPositions(coverHole, boltPositions, coverThickness / 2);
  const cover = coverBlank.subtract(coverClearancePattern).translate(0, 0, parentThickness + gasketThickness).color('#334155');
  const gasket =
    gasketThickness > 0
      ? box(Math.max(1, width - gasketInset * 2), Math.max(1, depth - gasketInset * 2), gasketThickness)
          .subtract(placeCutterAtPositions(coverHole, boltPositions, gasketThickness / 2))
          .translate(0, 0, parentThickness)
          .color('#111827')
      : null;
  const hardware = fastenerSet(screwSize, screwLength, {
    washerUnderHead: false,
    washerUnderNut: false,
    fit: coverFit,
    segments,
  });
  const screwOriginZ = parentThickness + gasketThickness + coverThickness;
  const screws = boltPositions.map(([x, y]) => hardware.bolt.translate(x, y, screwOriginZ).color('#94a3b8'));
  const parts = [
    { name: 'service cover parent ledge with threaded hole envelopes', shape: parent },
    ...(gasket ? [{ name: 'service cover gasket seated on ledge', shape: gasket }] : []),
    { name: 'bolted service cover plate with fused pull tabs', shape: cover },
    ...screws.map((shape, index) => ({ name: `installed ${screwSize} cover screw ${index + 1}`, shape })),
  ];
  return {
    parts,
    parent,
    cover,
    gasket,
    screws,
    boltPositions,
    cutters: {
      coverClearance: coverClearancePattern,
      parentTapped: parentTappedPattern,
      parentThreadEnvelope: parentThreadEnvelopePattern,
    },
    dims: {
      width,
      depth,
      coverThickness,
      parentThickness,
      ledgeWidth,
      gasketThickness,
      screwSize,
      screwLength,
      clearanceDia: sizeData[coverFit as 'normal'],
      tapDia: sizeData.tap,
      threadEnvelopeDia: sizeData.close,
    },
  };
}

// ---------------------------------------------------------------------------
// Snap-latch cover
// ---------------------------------------------------------------------------

export function snapLatchCoverAssembly(options: any) {
  const width = requirePositive(options.width, 'width');
  const depth = requirePositive(options.depth, 'depth');
  const coverThickness = requirePositive(options.coverThickness ?? 2.4, 'coverThickness');
  const parentThickness = requirePositive(options.parentThickness ?? 6, 'parentThickness');
  const ledgeWidth = requirePositive(options.ledgeWidth ?? 8, 'ledgeWidth');
  const runningClearance = requirePositive(options.runningClearance ?? 0.25, 'runningClearance');
  const faceClearance = requirePositive(options.faceClearance ?? 0.04, 'faceClearance');
  const latchWidth = requirePositive(options.latchWidth ?? Math.min(width * 0.22, Math.max(12, width * 0.16)), 'latchWidth');
  const latchThickness = requirePositive(options.latchThickness ?? 1.6, 'latchThickness');
  const hookThrow = requirePositive(options.hookThrow ?? 3.2, 'hookThrow');
  const hookThickness = requirePositive(options.hookThickness ?? 1.6, 'hookThickness');
  const openingWidth = width - ledgeWidth * 2;
  const openingDepth = depth - ledgeWidth * 2;
  if (openingWidth <= Math.max(8, latchWidth * 0.8) || openingDepth <= 8) {
    throw new Error('snapLatchCoverAssembly: ledgeWidth leaves too little service opening under the cover');
  }
  if (latchWidth >= openingWidth) {
    throw new Error('snapLatchCoverAssembly: latchWidth must fit along the receiver opening');
  }
  if (latchThickness + runningClearance * 2 >= ledgeWidth) {
    throw new Error('snapLatchCoverAssembly: latchThickness and clearance must fit inside the receiver ledge');
  }
  if (hookThrow + latchThickness / 2 + runningClearance >= ledgeWidth * 1.5) {
    throw new Error('snapLatchCoverAssembly: hookThrow is too large for the available underside catch land');
  }
  const parentWidth = width + ledgeWidth * 2;
  const parentDepth = depth + ledgeWidth * 2;
  const fuseOverlap = Math.min(0.04, faceClearance * 0.7);
  const hookClearance = Math.min(0.08, runningClearance * 0.32);
  const coverMinZ = parentThickness + faceClearance;
  const stemMinZ = -hookClearance - hookThickness;
  const stemHeight = coverMinZ + fuseOverlap - stemMinZ;
  const slotY = openingDepth / 2 + ledgeWidth / 2;
  const latchWindow = (sign: number) =>
    box(latchWidth + runningClearance * 2, latchThickness + runningClearance * 2, parentThickness + 0.8).translate(
      0,
      sign * slotY,
      -0.4,
    );
  const latchWindows = union(latchWindow(1), latchWindow(-1));
  const serviceOpening = box(openingWidth, openingDepth, parentThickness + 1).translate(0, 0, -0.5);
  const parent = box(parentWidth, parentDepth, parentThickness).subtract(serviceOpening).subtract(latchWindows).color('#475569');
  const coverPlate = box(width, depth, coverThickness).translate(0, 0, coverMinZ);
  const snapHook = (sign: number) => {
    const y = sign * slotY;
    const stem = box(latchWidth, latchThickness, stemHeight).translate(0, y, stemMinZ);
    const barb = box(latchWidth, latchThickness + hookThrow, hookThickness).translate(0, y + sign * (hookThrow / 2), stemMinZ);
    const rootRib = box(latchWidth, Math.max(latchThickness, hookThrow * 0.55), coverThickness * 0.65).translate(
      0,
      y - sign * (ledgeWidth * 0.18),
      coverMinZ,
    );
    return union(stem, barb, rootRib);
  };
  const cover = union(coverPlate, snapHook(1), snapHook(-1)).color('#111827');
  const parts = [
    { name: 'snap cover receiver frame with latch windows and catch lands', shape: parent },
    { name: 'one-piece snap cover with fused hooks and underside barbs', shape: cover },
  ];
  return {
    parts,
    parent,
    cover,
    cutters: { serviceOpening, latchWindows },
    dims: {
      width,
      depth,
      parentWidth,
      parentDepth,
      openingWidth,
      openingDepth,
      coverThickness,
      parentThickness,
      ledgeWidth,
      latchWidth,
      latchThickness,
      hookThrow,
      hookThickness,
      runningClearance,
      faceClearance,
    },
  };
}

// ---------------------------------------------------------------------------
// Captured cartridge guide
// ---------------------------------------------------------------------------

export function capturedCartridgeGuideAssembly(options: any) {
  const length = requirePositive(options.length, 'length');
  const guideWidth = requirePositive(options.guideWidth ?? 42, 'guideWidth');
  const baseThickness = requirePositive(options.baseThickness ?? 3, 'baseThickness');
  const wallThickness = requirePositive(options.wallThickness ?? 2.5, 'wallThickness');
  const wallHeight = requirePositive(options.wallHeight ?? 12, 'wallHeight');
  const lipWidth = requirePositive(options.lipWidth ?? 4, 'lipWidth');
  const lipThickness = requirePositive(options.lipThickness ?? 2, 'lipThickness');
  const rearStopLength = requirePositive(options.rearStopLength ?? 7, 'rearStopLength');
  const runningClearance = requirePositive(options.runningClearance ?? 0.35, 'runningClearance');
  const cartridgeLength = requirePositive(options.cartridgeLength ?? length * 0.58, 'cartridgeLength');
  const cartridgeHeight = requirePositive(options.cartridgeHeight ?? 10, 'cartridgeHeight');
  const flangeThickness = requirePositive(options.flangeThickness ?? 3, 'flangeThickness');
  const pullTabLength = requirePositive(options.pullTabLength ?? 10, 'pullTabLength');
  const innerWidth = guideWidth - wallThickness * 2;
  const throatWidth = innerWidth - lipWidth * 2;
  if (innerWidth <= 0) throw new Error('capturedCartridgeGuideAssembly: wallThickness leaves no inner guide width');
  if (throatWidth <= 0) throw new Error('capturedCartridgeGuideAssembly: lipWidth closes the guide throat');
  if (wallHeight <= lipThickness + flangeThickness + runningClearance * 2) {
    throw new Error('capturedCartridgeGuideAssembly: wallHeight leaves too little vertical capture clearance');
  }
  const cartridgeWidth = requirePositive(options.cartridgeWidth ?? innerWidth - runningClearance * 2, 'cartridgeWidth');
  const cartridgeBodyWidth = throatWidth - runningClearance * 2;
  if (cartridgeBodyWidth <= 0) {
    throw new Error('capturedCartridgeGuideAssembly: throatWidth and runningClearance leave no cartridge body width');
  }
  if (cartridgeWidth >= innerWidth - runningClearance) {
    throw new Error('capturedCartridgeGuideAssembly: cartridgeWidth leaves too little side clearance inside the guide');
  }
  if (cartridgeWidth <= throatWidth + runningClearance) {
    throw new Error(
      'capturedCartridgeGuideAssembly: cartridge flange must be wider than the guide throat so the cartridge is captured',
    );
  }
  const maxInsertion = length - rearStopLength - cartridgeLength;
  if (maxInsertion <= 0) {
    throw new Error('capturedCartridgeGuideAssembly: length, rearStopLength, and cartridgeLength leave no insertion travel');
  }
  const insertion = options.insertion ?? maxInsertion * 0.4;
  if (!Number.isFinite(insertion) || insertion < 0 || insertion > maxInsertion) {
    throw new Error(`capturedCartridgeGuideAssembly: insertion must be between 0 and ${maxInsertion}`);
  }
  const cartridgeCenterX = -length / 2 + cartridgeLength / 2 + insertion;
  const fuseOverlap = Math.min(0.04, runningClearance * 0.1);
  const sideY = guideWidth / 2 - wallThickness / 2;
  const lipY = guideWidth / 2 - wallThickness - lipWidth / 2 + fuseOverlap / 2;
  const guide = union(
    box(length, guideWidth, baseThickness),
    box(length, wallThickness, wallHeight + fuseOverlap).translate(0, sideY, baseThickness - fuseOverlap),
    box(length, wallThickness, wallHeight + fuseOverlap).translate(0, -sideY, baseThickness - fuseOverlap),
    box(length, lipWidth, lipThickness + fuseOverlap).translate(0, lipY, baseThickness + wallHeight - fuseOverlap),
    box(length, lipWidth, lipThickness + fuseOverlap).translate(0, -lipY, baseThickness + wallHeight - fuseOverlap),
    box(rearStopLength, throatWidth, Math.max(flangeThickness + runningClearance, 4)).translate(
      length / 2 - rearStopLength / 2,
      0,
      baseThickness - fuseOverlap,
    ),
  ).color('#475569');
  const flangeZ = baseThickness + runningClearance;
  const bodyHeight = Math.max(1, cartridgeHeight - flangeThickness);
  const bodyZ = flangeZ + flangeThickness;
  const tabOverlap = Math.min(0.6, pullTabLength * 0.15);
  const pullTabX = cartridgeCenterX - cartridgeLength / 2 - pullTabLength / 2 + tabOverlap;
  const pullTabWidth = Math.max(cartridgeBodyWidth * 0.55, 12);
  const cartridge = union(
    box(cartridgeLength, cartridgeWidth, flangeThickness).translate(cartridgeCenterX, 0, flangeZ),
    box(cartridgeLength * 0.88, cartridgeBodyWidth, bodyHeight).translate(cartridgeCenterX, 0, bodyZ),
    box(pullTabLength, pullTabWidth, Math.max(flangeThickness, 3)).translate(pullTabX, 0, flangeZ),
  ).color('#111827');
  const parts = [
    { name: 'captured cartridge guide with return lips and rear stop', shape: guide },
    { name: 'removable cartridge with captured flange and pull tab', shape: cartridge },
  ];
  return {
    parts,
    guide,
    cartridge,
    dims: {
      length,
      guideWidth,
      innerWidth,
      throatWidth,
      baseThickness,
      wallThickness,
      wallHeight,
      lipWidth,
      lipThickness,
      rearStopLength,
      cartridgeLength,
      cartridgeWidth,
      cartridgeBodyWidth,
      cartridgeHeight,
      flangeThickness,
      pullTabLength,
      runningClearance,
      maxInsertion,
      insertion,
      cartridgeCenterX,
    },
  };
}

// ---------------------------------------------------------------------------
// Captured linear slide
// ---------------------------------------------------------------------------

export function capturedLinearSlide(options: any) {
  const length = requirePositive(options.length, 'length');
  const railWidth = requirePositive(options.railWidth ?? 38, 'railWidth');
  const baseThickness = requirePositive(options.baseThickness ?? 2.4, 'baseThickness');
  const wallThickness = requirePositive(options.wallThickness ?? 2, 'wallThickness');
  const wallHeight = requirePositive(options.wallHeight ?? 9, 'wallHeight');
  const lipWidth = requirePositive(options.lipWidth ?? 4, 'lipWidth');
  const lipThickness = requirePositive(options.lipThickness ?? 1.8, 'lipThickness');
  const runningClearance = requirePositive(options.runningClearance ?? 0.35, 'runningClearance');
  const endStopLength = requirePositive(options.endStopLength ?? 6, 'endStopLength');
  const carriageLength = requirePositive(options.carriageLength ?? length * 0.32, 'carriageLength');
  const innerWidth = railWidth - wallThickness * 2;
  const throatWidth = innerWidth - lipWidth * 2;
  if (innerWidth <= 0) throw new Error('capturedLinearSlide: wallThickness leaves no inner rail width');
  if (throatWidth <= 0) throw new Error('capturedLinearSlide: lipWidth closes the rail throat');
  const carriageWidth = requirePositive(options.carriageWidth ?? innerWidth - runningClearance * 2, 'carriageWidth');
  const carriageThickness = requirePositive(options.carriageThickness ?? 4, 'carriageThickness');
  if (carriageWidth >= innerWidth - runningClearance) {
    throw new Error('capturedLinearSlide: carriageWidth leaves too little side clearance inside the rail');
  }
  if (carriageWidth <= throatWidth + runningClearance) {
    throw new Error('capturedLinearSlide: carriageWidth must be wider than the lip throat so the rail actually captures it');
  }
  if (carriageThickness + runningClearance * 2 >= wallHeight) {
    throw new Error('capturedLinearSlide: carriage is too tall to clear the return lips');
  }
  const maxTravel = length - endStopLength * 2 - carriageLength;
  if (maxTravel <= 0) {
    throw new Error('capturedLinearSlide: rail length, end stops, and carriage length leave no travel');
  }
  const travel = options.travel ?? maxTravel / 2;
  if (!Number.isFinite(travel) || travel < 0 || travel > maxTravel) {
    throw new Error(`capturedLinearSlide: travel must be between 0 and ${maxTravel}`);
  }
  const carriageCenterX = -maxTravel / 2 + travel;
  const fuseOverlap = Math.min(0.04, runningClearance * 0.1);
  const sideY = railWidth / 2 - wallThickness / 2;
  const lipY = railWidth / 2 - wallThickness - lipWidth / 2 + fuseOverlap / 2;
  const stopZ = baseThickness - fuseOverlap;
  const rail = union(
    box(length, railWidth, baseThickness),
    box(length, wallThickness, wallHeight + fuseOverlap).translate(0, sideY, baseThickness - fuseOverlap),
    box(length, wallThickness, wallHeight + fuseOverlap).translate(0, -sideY, baseThickness - fuseOverlap),
    box(length, lipWidth, lipThickness + fuseOverlap).translate(0, lipY, baseThickness + wallHeight - fuseOverlap),
    box(length, lipWidth, lipThickness + fuseOverlap).translate(0, -lipY, baseThickness + wallHeight - fuseOverlap),
    box(endStopLength, throatWidth, carriageThickness + fuseOverlap).translate(-length / 2 + endStopLength / 2, 0, stopZ),
    box(endStopLength, throatWidth, carriageThickness + fuseOverlap).translate(length / 2 - endStopLength / 2, 0, stopZ),
  ).color('#475569');
  const carriage = union(
    box(carriageLength, carriageWidth, carriageThickness),
    box(carriageLength * 0.78, throatWidth - runningClearance * 2, Math.max(1, carriageThickness * 0.38)).translate(
      0,
      0,
      carriageThickness,
    ),
  )
    .translate(carriageCenterX, 0, baseThickness + runningClearance)
    .color('#111827');
  const parts = [
    { name: 'captured linear rail with return lips and end stops', shape: rail },
    { name: 'sliding carriage captured under rail lips', shape: carriage },
  ];
  return {
    parts,
    rail,
    carriage,
    dims: {
      length,
      railWidth,
      innerWidth,
      throatWidth,
      baseThickness,
      wallThickness,
      wallHeight,
      lipWidth,
      lipThickness,
      carriageLength,
      carriageWidth,
      carriageThickness,
      endStopLength,
      runningClearance,
      maxTravel,
      travel,
      carriageCenterX,
    },
  };
}

// ---------------------------------------------------------------------------
// Clevis pin joint
// ---------------------------------------------------------------------------

export function clevisPinJointAssembly(options: any = {}) {
  const pinDiameter = requirePositive(options.pinDiameter ?? 4, 'pinDiameter');
  const pinClearance = requireNonNegative(options.pinClearance ?? 0.3, 'pinClearance');
  const boreDiameter = pinDiameter + pinClearance;
  const linkThickness = requirePositive(options.linkThickness ?? Math.max(5, pinDiameter * 1.5), 'linkThickness');
  const earThickness = requirePositive(options.earThickness ?? Math.max(3.5, pinDiameter), 'earThickness');
  const runningClearance = requireNonNegative(options.runningClearance ?? 0.25, 'runningClearance');
  const linkArmWidth = requirePositive(options.linkArmWidth ?? pinDiameter * 2.4, 'linkArmWidth');
  const eyeOuterRadius = requirePositive(
    options.eyeOuterRadius ?? Math.max(pinDiameter * 1.8, linkArmWidth / 2 + 1.4),
    'eyeOuterRadius',
  );
  const earLength = requirePositive(options.earLength ?? Math.max(eyeOuterRadius * 2.55, pinDiameter * 4.2), 'earLength');
  const earHeight = requirePositive(options.earHeight ?? Math.max(eyeOuterRadius * 2.25, pinDiameter * 4.4), 'earHeight');
  const linkArmLength = requirePositive(options.linkArmLength ?? 34, 'linkArmLength');
  const retainerThickness = requirePositive(options.retainerThickness ?? Math.max(1.2, pinDiameter * 0.35), 'retainerThickness');
  const segments = options.segments ?? 40;
  if (eyeOuterRadius <= boreDiameter / 2 + Math.max(0.8, pinDiameter * 0.25)) {
    throw new Error('clevisPinJointAssembly: eyeOuterRadius leaves too little material around the pin bore');
  }
  if (earHeight <= boreDiameter + Math.max(3, pinDiameter)) {
    throw new Error('clevisPinJointAssembly: earHeight leaves too little material around the pin bore');
  }
  if (earLength / 2 <= eyeOuterRadius + runningClearance) {
    throw new Error('clevisPinJointAssembly: earLength must extend behind the link eye for a rear clevis bridge');
  }
  const clevisGap = linkThickness + runningClearance * 2;
  const earCenterY = clevisGap / 2 + earThickness / 2;
  const totalStackY = clevisGap + earThickness * 2;
  const pinLength = totalStackY + retainerThickness * 2 + runningClearance * 2;
  const bridgeClearX = -eyeOuterRadius - runningClearance;
  const bridgeLength = Math.max(pinDiameter * 2.2, 4);
  const bridgeHeight = Math.min(earHeight * 0.48, Math.max(pinDiameter * 1.4, eyeOuterRadius * 0.75));
  const bridgeCenterX = bridgeClearX - bridgeLength / 2;
  const bridgeCenterZ = -earHeight / 2 + bridgeHeight / 2;
  const pinBore = cylinderAlongY(totalStackY + 0.8, boreDiameter / 2, 0, segments);
  const clevisBlank = union(
    box(earLength, earThickness, earHeight).translate(0, earCenterY, -earHeight / 2),
    box(earLength, earThickness, earHeight).translate(0, -earCenterY, -earHeight / 2),
    box(bridgeLength, totalStackY, bridgeHeight).translate(bridgeCenterX, 0, bridgeCenterZ),
  );
  const clevis = clevisBlank.subtract(pinBore).color('#475569');
  const eye = tubeAlongY(linkThickness, eyeOuterRadius, boreDiameter / 2, 0, segments);
  const armOverlap = Math.min(eyeOuterRadius * 0.65, linkArmLength * 0.25);
  const armCenterX = eyeOuterRadius - armOverlap + linkArmLength / 2;
  const linkArm = box(linkArmLength, linkThickness, linkArmWidth).translate(armCenterX, 0, -linkArmWidth / 2);
  const link = union(eye, linkArm).color('#111827');
  const pinCore = cylinderAlongY(pinLength, pinDiameter / 2, 0, segments);
  const headRadius = Math.max(pinDiameter * 0.9, boreDiameter / 2 + 0.8);
  const headY = totalStackY / 2 + runningClearance + retainerThickness / 2;
  const headA = cylinderAlongY(retainerThickness, headRadius, headY, segments);
  const headB = cylinderAlongY(retainerThickness, headRadius, -headY, segments);
  const pin = union(pinCore, headA, headB).color('#cbd5e1');
  const cutter = cylinderAlongY(pinLength + 1, boreDiameter / 2, 0, segments);
  const parts = [
    { name: 'bored clevis yoke with rear bridge', shape: clevis },
    { name: 'center link eye captured in clevis', shape: link },
    { name: 'retained clevis pin through link eye', shape: pin },
  ];
  return {
    parts,
    clevis,
    link,
    pin,
    cutters: { pinBore: cutter },
    dims: {
      pinDiameter,
      boreDiameter,
      linkThickness,
      earThickness,
      runningClearance,
      earLength,
      earHeight,
      linkArmLength,
      linkArmWidth,
      eyeOuterRadius,
      retainerThickness,
      pinLength,
      clevisGap,
    },
  };
}

// ---------------------------------------------------------------------------
// Pinned lever pivot stack
// ---------------------------------------------------------------------------

export function pinnedLeverAssembly(options: any) {
  const armLength = requirePositive(options.armLength, 'armLength');
  const armWidth = requirePositive(options.armWidth ?? 10, 'armWidth');
  const leverThickness = requirePositive(options.leverThickness ?? 5, 'leverThickness');
  const pinDiameter = requirePositive(options.pinDiameter ?? 5, 'pinDiameter');
  const pinClearance = requireNonNegative(options.pinClearance ?? 0.25, 'pinClearance');
  const boreDiameter = pinDiameter + pinClearance;
  const hubRadius = requirePositive(options.hubRadius ?? Math.max(armWidth * 0.85, pinDiameter * 1.8), 'hubRadius');
  const supportThickness = requirePositive(options.supportThickness ?? Math.max(6, pinDiameter * 1.4), 'supportThickness');
  const supportWidth = requirePositive(options.supportWidth ?? hubRadius * 2 + 18, 'supportWidth');
  const supportDepth = requirePositive(options.supportDepth ?? Math.max(armWidth + 18, hubRadius * 2 + 10), 'supportDepth');
  const washerSize: MetricSize = options.washerSize ?? metricWasherSizeForPin(pinDiameter);
  const washerDims = WASHER_TABLE[washerSize];
  if (!washerDims) throw new Error(`pinnedLeverAssembly: unsupported washerSize "${washerSize}"`);
  if (washerDims.id <= pinDiameter) {
    throw new Error(`pinnedLeverAssembly: ${washerSize} washer inner diameter is too small for a ${pinDiameter} mm pin`);
  }
  if (hubRadius <= boreDiameter / 2 + Math.max(1, pinDiameter * 0.25)) {
    throw new Error('pinnedLeverAssembly: hubRadius leaves too little material around the pivot bore');
  }
  if (supportWidth <= boreDiameter + 4 || supportDepth <= boreDiameter + 4) {
    throw new Error('pinnedLeverAssembly: support dimensions leave too little material around the pivot bore');
  }
  const segments = options.segments ?? 40;
  const gripLength = requirePositive(options.gripLength ?? Math.min(armLength * 0.32, Math.max(16, armWidth * 2.4)), 'gripLength');
  const gripWidth = requirePositive(options.gripWidth ?? armWidth * 1.55, 'gripWidth');
  if (gripLength >= armLength) throw new Error('pinnedLeverAssembly: gripLength must be shorter than armLength');
  const armOverlap = Math.min(hubRadius * 0.65, armLength * 0.25);
  const armStartX = hubRadius - armOverlap;
  const armCenterX = armStartX + armLength / 2;
  const gripCenterX = armStartX + armLength - gripLength / 2;
  const runningClearance = 0.03;
  const lowerWasherZ = supportThickness + runningClearance;
  const leverZ = lowerWasherZ + washerDims.t + runningClearance;
  const upperWasherZ = leverZ + leverThickness + runningClearance;
  const stackHeight = upperWasherZ + washerDims.t;
  const pinHeadThickness = Math.max(washerDims.t, pinDiameter * 0.35);
  const pinHeadRadius = Math.max(washerDims.od * 0.42, pinDiameter * 0.8);
  const supportBore = cylinder(supportThickness + 1, boreDiameter / 2, undefined, segments).translate(0, 0, -0.5);
  let supportBlank = box(supportWidth, supportDepth, supportThickness);
  if (options.stopBlock ?? true) {
    const stopLength = Math.min(armLength * 0.22, Math.max(10, armWidth * 1.4));
    const stopWidth = Math.max(4, pinDiameter * 0.7);
    const stopHeight = supportThickness;
    const stopX = hubRadius + stopLength / 2;
    const stopY = armWidth / 2 + stopWidth / 2 + runningClearance;
    supportBlank = union(supportBlank, box(stopLength, stopWidth, stopHeight).translate(stopX, stopY, 0));
  }
  const support = supportBlank.subtract(supportBore).color('#475569');
  const hub = cylinder(leverThickness, hubRadius, undefined, segments);
  const arm = box(armLength, armWidth, leverThickness).translate(armCenterX, 0, 0);
  const grip = box(gripLength, gripWidth, leverThickness).translate(gripCenterX, 0, 0);
  const leverSolids = [hub, arm, grip];
  if (options.detentBoss ?? true) {
    const bossRadius = Math.min(armWidth * 0.42, hubRadius * 0.42);
    const bossX = hubRadius + Math.min(armLength * 0.22, armWidth * 2);
    const bossY = -armWidth / 2 - bossRadius * 0.45;
    leverSolids.push(cylinder(leverThickness, bossRadius, undefined, segments).translate(bossX, bossY, 0));
  }
  const leverBore = cylinder(leverThickness + 1, boreDiameter / 2, undefined, segments).translate(0, 0, -0.5);
  const lever = union(...leverSolids).subtract(leverBore).translate(0, 0, leverZ).color('#7f1d1d');
  const lowerWasher = washer(washerSize, { segments }).translate(0, 0, lowerWasherZ).color('#94a3b8');
  const upperWasher = washer(washerSize, { segments }).translate(0, 0, upperWasherZ).color('#94a3b8');
  const shaft = cylinder(stackHeight, pinDiameter / 2, undefined, segments);
  const lowerRetainer = cylinder(pinHeadThickness, pinHeadRadius, undefined, segments).translate(0, 0, -pinHeadThickness - runningClearance);
  const upperHead = cylinder(pinHeadThickness, pinHeadRadius, undefined, segments).translate(0, 0, stackHeight + runningClearance);
  const pin = union(shaft, lowerRetainer, upperHead).color('#cbd5e1');
  const pivotBore = cylinder(stackHeight + 1, boreDiameter / 2, undefined, segments).translate(0, 0, -0.5);
  const parts = [
    { name: 'pivot support block with bearing bore and low stop land', shape: support },
    { name: 'lower thrust washer under pinned lever', shape: lowerWasher },
    { name: 'fused pinned lever with hub arm grip and detent boss', shape: lever },
    { name: 'upper thrust washer over pinned lever', shape: upperWasher },
    { name: 'retained pivot pin through lever stack', shape: pin },
  ];
  return {
    parts,
    support,
    lever,
    pin,
    washers: { lower: lowerWasher, upper: upperWasher },
    cutters: { pivotBore },
    dims: {
      armLength,
      armWidth,
      leverThickness,
      hubRadius,
      pinDiameter,
      boreDiameter,
      supportWidth,
      supportDepth,
      supportThickness,
      washerSize,
      washerThickness: washerDims.t,
      stackHeight,
    },
  };
}

// ---------------------------------------------------------------------------
// Knuckled hinge
// ---------------------------------------------------------------------------

export function knuckledHingeAssembly(options: any) {
  const length = requirePositive(options.length, 'length');
  const leafLength = requirePositive(options.leafLength ?? 36, 'leafLength');
  const leafThickness = requirePositive(options.leafThickness ?? 1.6, 'leafThickness');
  const barrelOuterRadius = requirePositive(options.barrelOuterRadius ?? 3, 'barrelOuterRadius');
  const pinDiameter = requirePositive(options.pinDiameter ?? 2, 'pinDiameter');
  const pinClearance = requireNonNegative(options.pinClearance ?? 0.25, 'pinClearance');
  const boreDiameter = pinDiameter + pinClearance;
  const knuckleGap = requireNonNegative(options.knuckleGap ?? 0.45, 'knuckleGap');
  const openAngleDeg = Number.isFinite(options.openAngleDeg ?? 35) ? options.openAngleDeg ?? 35 : 35;
  const retainerThickness = requirePositive(options.retainerThickness ?? Math.max(leafThickness, pinDiameter * 0.7), 'retainerThickness');
  const segments = options.segments ?? 36;
  const knuckleCount = options.knuckleCount ?? 5;
  if (!Number.isInteger(knuckleCount) || knuckleCount < 3 || knuckleCount % 2 === 0) {
    throw new Error('knuckledHingeAssembly: knuckleCount must be an odd integer >= 3');
  }
  if (barrelOuterRadius <= boreDiameter / 2 + Math.max(0.35, pinDiameter * 0.18)) {
    throw new Error('knuckledHingeAssembly: barrelOuterRadius leaves too little wall around the pin bore');
  }
  const knuckleLength = (length - knuckleGap * (knuckleCount - 1)) / knuckleCount;
  if (knuckleLength <= pinDiameter * 1.4) {
    throw new Error('knuckledHingeAssembly: length, knuckleCount, and knuckleGap make knuckles too short');
  }
  const leafRootClearance = Math.max(0.12, Math.min(knuckleGap * 0.35, 0.35));
  const barrelLeafOverlap = Math.min(barrelOuterRadius * 0.18, leafThickness * 0.35);
  const bridgeDepth = leafRootClearance + barrelLeafOverlap + 0.2;
  const fixedLeafPlate = box(length, leafLength, leafThickness).translate(
    0,
    barrelOuterRadius + leafRootClearance + leafLength / 2,
    -leafThickness / 2,
  );
  const movingLeafPlate = box(length, leafLength, leafThickness).translate(
    0,
    -barrelOuterRadius - leafRootClearance - leafLength / 2,
    -leafThickness / 2,
  );
  const fixedKnuckles: Shape[] = [];
  const movingKnuckles: Shape[] = [];
  const fixedBridges: Shape[] = [];
  const movingBridges: Shape[] = [];
  for (let index = 0; index < knuckleCount; index += 1) {
    const xStart = -length / 2 + index * (knuckleLength + knuckleGap);
    const xCenter = xStart + knuckleLength / 2;
    const knuckle = tubeAlongX(knuckleLength, barrelOuterRadius, boreDiameter / 2, xCenter, segments);
    if (index % 2 === 0) {
      fixedKnuckles.push(knuckle);
      fixedBridges.push(
        box(knuckleLength, bridgeDepth, leafThickness).translate(
          xCenter,
          barrelOuterRadius - barrelLeafOverlap + bridgeDepth / 2,
          -leafThickness / 2,
        ),
      );
    } else {
      movingKnuckles.push(knuckle);
      movingBridges.push(
        box(knuckleLength, bridgeDepth, leafThickness).translate(
          xCenter,
          -barrelOuterRadius + barrelLeafOverlap - bridgeDepth / 2,
          -leafThickness / 2,
        ),
      );
    }
  }
  const fixedLeaf = union(fixedLeafPlate, ...fixedKnuckles, ...fixedBridges).color('#475569');
  const movingLeaf = union(movingLeafPlate, ...movingKnuckles, ...movingBridges).rotateX(openAngleDeg).color('#111827');
  const pinCore = cylinderAlongX(length + retainerThickness * 2, pinDiameter / 2, 0, segments);
  const retainerRadius = Math.max(barrelOuterRadius * 0.85, pinDiameter);
  const leftHead = cylinderAlongX(retainerThickness, retainerRadius, -length / 2 - retainerThickness / 2, segments);
  const rightHead = cylinderAlongX(retainerThickness, retainerRadius, length / 2 + retainerThickness / 2, segments);
  const pin = union(pinCore, leftHead, rightHead).color('#cbd5e1');
  const pinBore = cylinderAlongX(length + retainerThickness * 2, boreDiameter / 2, 0, segments);
  const parts = [
    { name: 'fixed hinge leaf with alternating knuckles', shape: fixedLeaf },
    { name: 'moving hinge leaf with alternating knuckles', shape: movingLeaf },
    { name: 'retained hinge pin through knuckle stack', shape: pin },
  ];
  return {
    parts,
    fixedLeaf,
    movingLeaf,
    pin,
    cutters: { pinBore },
    dims: {
      length,
      leafLength,
      leafThickness,
      barrelOuterRadius,
      pinDiameter,
      boreDiameter,
      knuckleGap,
      knuckleCount,
      knuckleLength,
      openAngleDeg,
      retainerThickness,
    },
  };
}

// ---------------------------------------------------------------------------
// Living hinge cover
// ---------------------------------------------------------------------------

export function livingHingeCoverAssembly(options: any) {
  const width = requirePositive(options.width, 'width');
  const coverDepth = requirePositive(options.coverDepth ?? 42, 'coverDepth');
  const fixedLeafDepth = requirePositive(options.fixedLeafDepth ?? 18, 'fixedLeafDepth');
  const leafThickness = requirePositive(options.leafThickness ?? 2, 'leafThickness');
  const hingeWebWidth = requirePositive(options.hingeWebWidth ?? 3.2, 'hingeWebWidth');
  const hingeWebThickness = requirePositive(options.hingeWebThickness ?? 0.45, 'hingeWebThickness');
  const pullLipDepth = requirePositive(options.pullLipDepth ?? 5, 'pullLipDepth');
  const snapBarbWidth = requirePositive(options.snapBarbWidth ?? width * 0.35, 'snapBarbWidth');
  const snapBarbDepth = requirePositive(options.snapBarbDepth ?? 2.4, 'snapBarbDepth');
  const snapBarbHeight = requirePositive(options.snapBarbHeight ?? 1.4, 'snapBarbHeight');
  const catchLandDepth = requirePositive(options.catchLandDepth ?? 2.4, 'catchLandDepth');
  if (hingeWebThickness >= leafThickness * 0.55) {
    throw new Error('livingHingeCoverAssembly: hingeWebThickness must be much thinner than the rigid leaves');
  }
  if (hingeWebWidth >= Math.min(coverDepth, fixedLeafDepth) * 0.45) {
    throw new Error('livingHingeCoverAssembly: hingeWebWidth is too wide for the selected leaves');
  }
  if (snapBarbWidth >= width - 2) {
    throw new Error('livingHingeCoverAssembly: snapBarbWidth must leave side material on the cover leaf');
  }
  const fuseOverlap = Math.min(0.04, hingeWebWidth * 0.02);
  const fixedCenterY = -hingeWebWidth / 2 - fixedLeafDepth / 2 + fuseOverlap / 2;
  const coverCenterY = hingeWebWidth / 2 + coverDepth / 2 - fuseOverlap / 2;
  const fixedLeaf = box(width, fixedLeafDepth + fuseOverlap, leafThickness).translate(0, fixedCenterY, 0);
  const movingLeaf = box(width, coverDepth + fuseOverlap, leafThickness).translate(0, coverCenterY, 0);
  const hingeWeb = box(width, hingeWebWidth + fuseOverlap * 2, hingeWebThickness).translate(0, 0, 0);
  const pullLip = box(width * 0.92, pullLipDepth, leafThickness).translate(0, coverCenterY + coverDepth / 2 + pullLipDepth / 2 - fuseOverlap, 0);
  const snapBarb = box(snapBarbWidth, snapBarbDepth, snapBarbHeight).translate(0, coverCenterY + coverDepth / 2 - snapBarbDepth / 2, leafThickness);
  const catchLand = box(width * 0.55, catchLandDepth, Math.max(0.8, leafThickness * 0.45)).translate(
    0,
    fixedCenterY - fixedLeafDepth / 2 + catchLandDepth / 2,
    leafThickness,
  );
  const cover = union(fixedLeaf, movingLeaf, hingeWeb, pullLip, snapBarb, catchLand).color('#0f766e');
  const overallDepth = fixedLeafDepth + hingeWebWidth + coverDepth + pullLipDepth;
  const flexRatio = leafThickness / hingeWebThickness;
  return {
    parts: [{ name: 'one-piece molded living hinge cover with snap barb', shape: cover }],
    cover,
    fixedLeaf,
    movingLeaf,
    hingeWeb,
    snapBarb,
    catchLand,
    dims: {
      width,
      coverDepth,
      fixedLeafDepth,
      leafThickness,
      hingeWebWidth,
      hingeWebThickness,
      pullLipDepth,
      snapBarbWidth,
      snapBarbDepth,
      snapBarbHeight,
      catchLandDepth,
      flexRatio,
      overallDepth,
    },
  };
}

// ---------------------------------------------------------------------------
// Retained shaft / knob stack
// ---------------------------------------------------------------------------

export function retainedShaftAssembly(options: any) {
  const supportSpacing = requirePositive(options.supportSpacing, 'supportSpacing');
  const shaftDiameter = requirePositive(options.shaftDiameter ?? 8, 'shaftDiameter');
  const boreClearance = requireNonNegative(options.boreClearance ?? 0.35, 'boreClearance');
  const boreDiameter = shaftDiameter + boreClearance;
  const supportThickness = requirePositive(options.supportThickness ?? Math.max(5, shaftDiameter * 0.75), 'supportThickness');
  const washerSize: MetricSize = options.washerSize ?? metricWasherSizeForPin(shaftDiameter);
  const washerDims = WASHER_TABLE[washerSize];
  if (!washerDims) throw new Error(`retainedShaftAssembly: unsupported washerSize "${washerSize}"`);
  if (washerDims.id <= shaftDiameter) {
    throw new Error(`retainedShaftAssembly: ${washerSize} washer inner diameter is too small for a ${shaftDiameter} mm shaft`);
  }
  const knobDiameter = requirePositive(options.knobDiameter ?? shaftDiameter * 3, 'knobDiameter');
  const knobThickness = requirePositive(options.knobThickness ?? Math.max(8, shaftDiameter), 'knobThickness');
  const retainerThickness = requirePositive(options.retainerThickness ?? Math.max(washerDims.t, shaftDiameter * 0.35), 'retainerThickness');
  const runningClearance = requireNonNegative(options.runningClearance ?? 0.05, 'runningClearance');
  const supportWidth = requirePositive(options.supportWidth ?? Math.max(28, knobDiameter * 1.25), 'supportWidth');
  const supportHeight = requirePositive(options.supportHeight ?? Math.max(34, knobDiameter * 1.45), 'supportHeight');
  const segments = options.segments ?? 40;
  if (supportSpacing <= supportThickness) {
    throw new Error('retainedShaftAssembly: supportSpacing must leave a gap between support cheeks');
  }
  if (supportWidth <= boreDiameter + 4 || supportHeight <= boreDiameter + 4) {
    throw new Error('retainedShaftAssembly: support dimensions leave too little material around the shaft bore');
  }
  const leftSupportX = -supportSpacing / 2;
  const rightSupportX = supportSpacing / 2;
  const leftOuterFaceX = leftSupportX - supportThickness / 2;
  const rightOuterFaceX = rightSupportX + supportThickness / 2;
  const leftWasherX = leftOuterFaceX - runningClearance - washerDims.t / 2;
  const rightWasherX = rightOuterFaceX + runningClearance + washerDims.t / 2;
  const leftKnobX = leftOuterFaceX - runningClearance * 2 - washerDims.t - knobThickness / 2;
  const rightKnobX = rightOuterFaceX + runningClearance * 2 + washerDims.t + knobThickness / 2;
  const leftStackOuterX = leftKnobX - knobThickness / 2;
  const rightStackOuterX = rightKnobX + knobThickness / 2;
  const minimumShaftLength = rightStackOuterX - leftStackOuterX + retainerThickness * 2 + runningClearance * 2;
  const shaftLength = requirePositive(options.shaftLength ?? minimumShaftLength, 'shaftLength');
  if (shaftLength < minimumShaftLength) {
    throw new Error('retainedShaftAssembly: shaftLength is too short to retain both supports, washers, and knobs');
  }
  const supportBore = cylinderAlongX(supportThickness + 1, boreDiameter / 2, 0, segments);
  const makeSupport = (x: number) =>
    box(supportThickness, supportWidth, supportHeight)
      .translate(x, 0, -supportHeight / 2)
      .subtract(supportBore.translate(x, 0, 0))
      .color('#334155');
  const knobBore = cylinder(knobThickness + 1, boreDiameter / 2, undefined, segments).translate(0, 0, -0.5);
  const makeKnob = (x: number) =>
    cylinder(knobThickness, knobDiameter / 2, undefined, 18)
      .subtract(knobBore)
      .pointAlong([1, 0, 0])
      .translate(x - knobThickness / 2, 0, 0)
      .color('#111827');
  const retainerRadius = Math.max(shaftDiameter * 0.85, knobDiameter * 0.36);
  const shaftCore = cylinderAlongX(shaftLength, shaftDiameter / 2, 0, segments);
  const leftRetainer = cylinderAlongX(retainerThickness, retainerRadius, -shaftLength / 2 + retainerThickness / 2, segments);
  const rightRetainer = cylinderAlongX(retainerThickness, retainerRadius, shaftLength / 2 - retainerThickness / 2, segments);
  const shaft = union(shaftCore, leftRetainer, rightRetainer).color('#cbd5e1');
  const leftSupport = makeSupport(leftSupportX);
  const rightSupport = makeSupport(rightSupportX);
  const leftWasher = washerAlongX(washerSize, leftWasherX, segments).color('#94a3b8');
  const rightWasher = washerAlongX(washerSize, rightWasherX, segments).color('#94a3b8');
  const leftKnob = makeKnob(leftKnobX);
  const rightKnob = makeKnob(rightKnobX);
  const shaftBore = cylinderAlongX(supportThickness + knobThickness + 2, boreDiameter / 2, 0, segments);
  const parts = [
    { name: 'left bored support cheek for retained shaft', shape: leftSupport },
    { name: 'right bored support cheek for retained shaft', shape: rightSupport },
    { name: 'retained through shaft with end heads', shape: shaft },
    { name: `left ${washerSize} thrust washer on shaft`, shape: leftWasher },
    { name: `right ${washerSize} thrust washer on shaft`, shape: rightWasher },
    { name: 'left retained hand knob with shaft bore', shape: leftKnob },
    { name: 'right retained hand knob with shaft bore', shape: rightKnob },
  ];
  return {
    parts,
    supports: { left: leftSupport, right: rightSupport },
    shaft,
    washers: { left: leftWasher, right: rightWasher },
    knobs: { left: leftKnob, right: rightKnob },
    cutters: { shaftBore },
    dims: {
      supportSpacing,
      supportThickness,
      supportWidth,
      supportHeight,
      shaftDiameter,
      shaftLength,
      boreDiameter,
      washerSize,
      washerThickness: washerDims.t,
      knobDiameter,
      knobThickness,
      retainerThickness,
      runningClearance,
    },
  };
}

// ---------------------------------------------------------------------------
// Seated bearing stack
// ---------------------------------------------------------------------------

export function seatedBearingAssembly(options: any) {
  const bearingOuterDiameter = requirePositive(options.bearingOuterDiameter, 'bearingOuterDiameter');
  const bearingInnerDiameter = requirePositive(options.bearingInnerDiameter, 'bearingInnerDiameter');
  const bearingWidth = requirePositive(options.bearingWidth, 'bearingWidth');
  const shaftDiameter = requirePositive(options.shaftDiameter ?? Math.max(1, bearingInnerDiameter - 0.4), 'shaftDiameter');
  const pocketClearance = requireNonNegative(options.pocketClearance ?? 0.2, 'pocketClearance');
  const shaftClearance = requireNonNegative(options.shaftClearance ?? 0.35, 'shaftClearance');
  const runningClearance = requireNonNegative(options.runningClearance ?? 0.05, 'runningClearance');
  const housingThickness = requirePositive(options.housingThickness ?? bearingWidth + 5, 'housingThickness');
  const bossHeight = requirePositive(options.bossHeight ?? Math.max(2, bearingWidth * 0.45), 'bossHeight');
  const bossOuterDiameter = requirePositive(
    options.bossOuterDiameter ?? bearingOuterDiameter + Math.max(8, bearingOuterDiameter * 0.36),
    'bossOuterDiameter',
  );
  const housingWidth = requirePositive(options.housingWidth ?? Math.max(bossOuterDiameter + 12, bearingOuterDiameter * 2.1), 'housingWidth');
  const housingDepth = requirePositive(options.housingDepth ?? Math.max(bossOuterDiameter + 12, bearingOuterDiameter * 1.8), 'housingDepth');
  const shaftOverhang = requirePositive(options.shaftOverhang ?? Math.max(8, bearingOuterDiameter * 0.45), 'shaftOverhang');
  const shoulderDiameter = requirePositive(options.shoulderDiameter ?? Math.max(shaftDiameter * 1.65, bearingInnerDiameter + 2), 'shoulderDiameter');
  const shoulderThickness = requirePositive(options.shoulderThickness ?? Math.max(1.5, shaftDiameter * 0.32), 'shoulderThickness');
  const segments = options.segments ?? 48;
  if (bearingOuterDiameter <= bearingInnerDiameter + Math.max(1, bearingOuterDiameter * 0.08)) {
    throw new Error('seatedBearingAssembly: bearingOuterDiameter leaves too little bearing wall around the bore');
  }
  if (shaftDiameter + shaftClearance >= bearingInnerDiameter) {
    throw new Error('seatedBearingAssembly: shaftDiameter plus shaftClearance must fit inside the bearing bore');
  }
  if (shoulderDiameter >= bearingOuterDiameter - runningClearance * 2) {
    throw new Error('seatedBearingAssembly: shoulderDiameter must stay smaller than the bearing outer race');
  }
  const pocketDiameter = bearingOuterDiameter + pocketClearance;
  const shaftBoreDiameter = shaftDiameter + shaftClearance;
  const totalHousingHeight = housingThickness + bossHeight;
  const pocketDepth = bearingWidth + runningClearance * 2;
  if (pocketDepth >= totalHousingHeight - runningClearance) {
    throw new Error('seatedBearingAssembly: housingThickness and bossHeight must leave a shoulder below the bearing pocket');
  }
  if (bossOuterDiameter <= pocketDiameter + Math.max(2, bearingOuterDiameter * 0.12)) {
    throw new Error('seatedBearingAssembly: bossOuterDiameter leaves too little wall around the bearing pocket');
  }
  if (housingWidth <= pocketDiameter + 6 || housingDepth <= pocketDiameter + 6) {
    throw new Error('seatedBearingAssembly: housing dimensions leave too little material around the bearing pocket');
  }
  if (shoulderThickness * 2 + runningClearance * 2 >= shaftOverhang) {
    throw new Error('seatedBearingAssembly: shaftOverhang must leave room for retaining collars outside the housing');
  }
  const pocketBottomZ = totalHousingHeight - pocketDepth;
  const bearingZ = pocketBottomZ + runningClearance;
  const lowerShoulderZ = -runningClearance - shoulderThickness;
  const upperShoulderZ = totalHousingHeight + runningClearance;
  const shaftLength = totalHousingHeight + shaftOverhang * 2;
  const bossFuseOverlap = Math.min(0.08, Math.max(0.02, bossHeight * 0.03));
  const bearingPocket = cylinder(pocketDepth + 0.4, pocketDiameter / 2, undefined, segments).translate(0, 0, pocketBottomZ - 0.2);
  const shaftBore = cylinder(totalHousingHeight + 1, shaftBoreDiameter / 2, undefined, segments).translate(0, 0, -0.5);
  const housingBase = box(housingWidth, housingDepth, housingThickness).subtract(bearingPocket).subtract(shaftBore);
  const housingBoss = cylinder(bossHeight + bossFuseOverlap, bossOuterDiameter / 2, undefined, segments)
    .translate(0, 0, housingThickness - bossFuseOverlap)
    .subtract(bearingPocket);
  const housing = union(housingBase, housingBoss).color('#475569');
  const bearingRing = tubeAlongZ(bearingWidth, bearingOuterDiameter / 2, bearingInnerDiameter / 2, segments);
  const shieldInset = Math.min(bearingWidth * 0.18, 0.7);
  const shieldOuterRadius = bearingOuterDiameter / 2 - Math.max(0.45, (bearingOuterDiameter - bearingInnerDiameter) * 0.08);
  const shieldInnerRadius = bearingInnerDiameter / 2 + Math.max(0.2, (bearingOuterDiameter - bearingInnerDiameter) * 0.035);
  const bearingShield =
    shieldOuterRadius > shieldInnerRadius + 0.2
      ? union(
          tubeAlongZ(Math.min(0.35, bearingWidth * 0.08), shieldOuterRadius, shieldInnerRadius, segments).translate(0, 0, shieldInset),
          tubeAlongZ(Math.min(0.35, bearingWidth * 0.08), shieldOuterRadius, shieldInnerRadius, segments).translate(
            0,
            0,
            bearingWidth - shieldInset - Math.min(0.35, bearingWidth * 0.08),
          ),
        )
      : null;
  const bearing = (bearingShield ? union(bearingRing, bearingShield) : bearingRing).translate(0, 0, bearingZ).color('#111827');
  const shaftCore = cylinder(shaftLength, shaftDiameter / 2, undefined, segments).translate(0, 0, -shaftOverhang);
  const lowerShoulder = cylinder(shoulderThickness, shoulderDiameter / 2, undefined, segments).translate(0, 0, lowerShoulderZ);
  const upperShoulder = cylinder(shoulderThickness, shoulderDiameter / 2, undefined, segments).translate(0, 0, upperShoulderZ);
  const shaft = union(shaftCore, lowerShoulder, upperShoulder).color('#cbd5e1');
  const parts = [
    { name: 'bearing housing with counterbore pocket and shoulder', shape: housing },
    { name: 'purchased radial bearing seated in counterbore', shape: bearing },
    { name: 'shaft through bearing bore with retaining collars', shape: shaft },
  ];
  return {
    parts,
    housing,
    bearing,
    shaft,
    cutters: { bearingPocket, shaftBore },
    dims: {
      bearingOuterDiameter,
      bearingInnerDiameter,
      bearingWidth,
      shaftDiameter,
      housingWidth,
      housingDepth,
      housingThickness,
      bossOuterDiameter,
      bossHeight,
      totalHousingHeight,
      pocketDiameter,
      pocketDepth,
      shaftBoreDiameter,
      runningClearance,
      shaftLength,
      shoulderDiameter,
      shoulderThickness,
    },
  };
}

// ---------------------------------------------------------------------------
// Cable gland anchor
// ---------------------------------------------------------------------------

export function cableGlandAnchorAssembly(options: any) {
  const cableDiameter = requirePositive(options.cableDiameter, 'cableDiameter');
  const panelThickness = requirePositive(options.panelThickness ?? 3, 'panelThickness');
  const panelWidth = requirePositive(options.panelWidth ?? Math.max(54, cableDiameter * 7), 'panelWidth');
  const panelHeight = requirePositive(options.panelHeight ?? Math.max(38, cableDiameter * 5), 'panelHeight');
  const runningClearance = requirePositive(options.runningClearance ?? 0.35, 'runningClearance');
  const panelHoleClearance = requirePositive(options.panelHoleClearance ?? 0.25, 'panelHoleClearance');
  const cableBoreDiameter = cableDiameter + runningClearance * 2;
  const glandOuterDiameter = requirePositive(options.glandOuterDiameter ?? cableDiameter + Math.max(6, cableDiameter * 0.9), 'glandOuterDiameter');
  const nutOuterDiameter = requirePositive(options.nutOuterDiameter ?? glandOuterDiameter + Math.max(6, cableDiameter * 0.8), 'nutOuterDiameter');
  const nutThickness = requirePositive(options.nutThickness ?? Math.max(4, cableDiameter * 0.8), 'nutThickness');
  const flangeDiameter = requirePositive(options.flangeDiameter ?? glandOuterDiameter + Math.max(5, cableDiameter * 0.7), 'flangeDiameter');
  const flangeThickness = requirePositive(options.flangeThickness ?? Math.max(2, panelThickness * 0.45), 'flangeThickness');
  const minGlandLength = panelThickness + nutThickness + flangeThickness + runningClearance * 4;
  const glandLength = requirePositive(options.glandLength ?? minGlandLength + Math.max(8, cableDiameter), 'glandLength');
  const cableLength = requirePositive(options.cableLength ?? glandLength + Math.max(36, cableDiameter * 5), 'cableLength');
  const segments = options.segments ?? 40;
  if (glandOuterDiameter <= cableBoreDiameter + Math.max(1.2, cableDiameter * 0.18)) {
    throw new Error('cableGlandAnchorAssembly: glandOuterDiameter leaves too little wall around the cable bore');
  }
  if (nutOuterDiameter <= glandOuterDiameter + Math.max(1.5, cableDiameter * 0.2)) {
    throw new Error('cableGlandAnchorAssembly: nutOuterDiameter must leave material around the gland body');
  }
  if (flangeDiameter <= glandOuterDiameter + Math.max(1.2, cableDiameter * 0.16)) {
    throw new Error('cableGlandAnchorAssembly: flangeDiameter must be larger than the gland body');
  }
  if (panelWidth <= flangeDiameter + 8 || panelHeight <= flangeDiameter + 8) {
    throw new Error('cableGlandAnchorAssembly: panel dimensions leave too little material around the gland hole');
  }
  if (glandLength <= minGlandLength) {
    throw new Error('cableGlandAnchorAssembly: glandLength must span the panel, flange, compression nut, and clearances');
  }
  if (cableLength <= glandLength + runningClearance * 2) {
    throw new Error('cableGlandAnchorAssembly: cableLength must extend beyond the gland body');
  }
  const panelHoleDiameter = glandOuterDiameter + panelHoleClearance * 2;
  const glandOuterRadius = glandOuterDiameter / 2;
  const cableBoreRadius = cableBoreDiameter / 2;
  const faceClearance = Math.min(0.05, runningClearance * 0.15);
  const flangePocketDepth = Math.min(Math.max(0.35, panelThickness * 0.18), panelThickness * 0.4, flangeThickness * 0.55);
  const panelHole = cylinderAlongX(panelThickness + 0.8, panelHoleDiameter / 2, 0, segments);
  const flangeSeatPocket = cylinderAlongX(
    flangePocketDepth + 0.2,
    flangeDiameter / 2 + panelHoleClearance,
    panelThickness / 2 - flangePocketDepth / 2,
    segments,
  );
  const cableBore = cylinderAlongX(glandLength + 0.8, cableBoreRadius, 0, segments);
  const panel = box(panelThickness, panelWidth, panelHeight).translate(0, 0, -panelHeight / 2).subtract(panelHole).subtract(flangeSeatPocket).color('#475569');
  const glandBody = tubeAlongX(glandLength, glandOuterRadius, cableBoreRadius, 0, segments);
  const flangeCenterX = panelThickness / 2 - flangePocketDepth + faceClearance + flangeThickness / 2;
  const flange = tubeAlongX(flangeThickness, flangeDiameter / 2, cableBoreRadius, flangeCenterX, segments);
  const gland = union(glandBody, flange).color('#94a3b8');
  const nutInnerRadius = glandOuterRadius + Math.min(0.12, runningClearance * 0.4);
  const nutCenterX = -panelThickness / 2 - faceClearance - nutThickness / 2;
  const compressionNut = tubeAlongX(nutThickness, nutOuterDiameter / 2, nutInnerRadius, nutCenterX, segments).color('#cbd5e1');
  const cable = cylinderAlongX(cableLength, cableDiameter / 2, 0, segments).color('#111827');
  const parts = [
    { name: 'panel with gland clearance hole', shape: panel },
    { name: 'hollow cable gland body with panel flange', shape: gland },
    { name: 'compression nut around gland body', shape: compressionNut },
    { name: 'routed cable through gland bore', shape: cable },
  ];
  return {
    parts,
    panel,
    gland,
    compressionNut,
    cable,
    cutters: { panelHole, flangeSeatPocket, cableBore },
    dims: {
      cableDiameter,
      cableBoreDiameter,
      panelThickness,
      panelWidth,
      panelHeight,
      glandOuterDiameter,
      glandLength,
      nutOuterDiameter,
      nutThickness,
      flangeDiameter,
      flangeThickness,
      runningClearance,
      faceClearance,
      flangePocketDepth,
      panelHoleDiameter,
      cableLength,
    },
  };
}

// ---------------------------------------------------------------------------
// Hose barb port
// ---------------------------------------------------------------------------

export function hoseBarbPortAssembly(options: any) {
  const hoseInnerDiameter = requirePositive(options.hoseInnerDiameter, 'hoseInnerDiameter');
  const runningClearance = requirePositive(options.runningClearance ?? 0.18, 'runningClearance');
  const faceClearance = requirePositive(options.faceClearance ?? 0.04, 'faceClearance');
  const barbRootDiameter = requirePositive(
    options.barbRootDiameter ?? Math.max(1, hoseInnerDiameter - Math.max(0.25, hoseInnerDiameter * 0.06)),
    'barbRootDiameter',
  );
  const barbPeakDiameter = requirePositive(options.barbPeakDiameter ?? hoseInnerDiameter + Math.max(0.65, hoseInnerDiameter * 0.12), 'barbPeakDiameter');
  const installedHoseBoreDiameter = barbPeakDiameter + runningClearance * 2;
  const hoseOuterDiameter = requirePositive(
    options.hoseOuterDiameter ?? Math.max(installedHoseBoreDiameter + 2.4, hoseInnerDiameter + Math.max(3, hoseInnerDiameter * 0.55)),
    'hoseOuterDiameter',
  );
  const fluidBoreDiameter = requirePositive(options.fluidBoreDiameter ?? hoseInnerDiameter * 0.65, 'fluidBoreDiameter');
  const blockThickness = requirePositive(options.blockThickness ?? Math.max(7, hoseInnerDiameter * 1.2), 'blockThickness');
  const barbCount = options.barbCount ?? 3;
  const barbLength = requirePositive(options.barbLength ?? Math.max(2.6, hoseInnerDiameter * 0.55), 'barbLength');
  const barbStackLength = barbCount * barbLength;
  const shoulderDiameter = requirePositive(options.shoulderDiameter ?? barbPeakDiameter + Math.max(4, hoseInnerDiameter * 0.65), 'shoulderDiameter');
  const shoulderThickness = requirePositive(options.shoulderThickness ?? Math.max(2, hoseInnerDiameter * 0.35), 'shoulderThickness');
  const bossDiameter = requirePositive(options.bossDiameter ?? shoulderDiameter + Math.max(4, hoseInnerDiameter * 0.6), 'bossDiameter');
  const bossHeight = requirePositive(options.bossHeight ?? Math.max(2.4, hoseInnerDiameter * 0.45), 'bossHeight');
  const blockWidth = requirePositive(options.blockWidth ?? bossDiameter + Math.max(14, hoseInnerDiameter * 2.4), 'blockWidth');
  const blockHeight = requirePositive(options.blockHeight ?? bossDiameter + Math.max(12, hoseInnerDiameter * 2.1), 'blockHeight');
  const hoseLength = requirePositive(options.hoseLength ?? barbStackLength + Math.max(32, hoseInnerDiameter * 5), 'hoseLength');
  const clampWidth = requirePositive(options.clampWidth ?? Math.max(4, hoseOuterDiameter * 0.45), 'clampWidth');
  const clampThickness = requirePositive(options.clampThickness ?? 0.9, 'clampThickness');
  const segments = options.segments ?? 40;
  if (!Number.isInteger(barbCount) || barbCount < 1 || barbCount > 8) {
    throw new Error('hoseBarbPortAssembly: barbCount must be an integer from 1 to 8');
  }
  if (barbPeakDiameter <= hoseInnerDiameter) {
    throw new Error('hoseBarbPortAssembly: barbPeakDiameter must exceed hoseInnerDiameter so the barb retains the hose');
  }
  if (barbRootDiameter >= barbPeakDiameter - Math.max(0.25, hoseInnerDiameter * 0.04)) {
    throw new Error('hoseBarbPortAssembly: barbRootDiameter must leave a visible barb rise');
  }
  if (fluidBoreDiameter >= barbRootDiameter - Math.max(0.8, hoseInnerDiameter * 0.12)) {
    throw new Error('hoseBarbPortAssembly: fluidBoreDiameter leaves too little wall in the barb fitting');
  }
  if (hoseOuterDiameter <= installedHoseBoreDiameter + Math.max(1.2, hoseInnerDiameter * 0.16)) {
    throw new Error('hoseBarbPortAssembly: hoseOuterDiameter leaves too little hose wall around the installed barb envelope');
  }
  if (shoulderDiameter <= barbPeakDiameter + Math.max(1.5, hoseInnerDiameter * 0.2)) {
    throw new Error('hoseBarbPortAssembly: shoulderDiameter must be larger than the barb peaks');
  }
  if (bossDiameter <= shoulderDiameter + Math.max(1.5, hoseInnerDiameter * 0.2)) {
    throw new Error('hoseBarbPortAssembly: bossDiameter must leave material around the shoulder seat');
  }
  if (blockWidth <= bossDiameter + 8 || blockHeight <= bossDiameter + 8) {
    throw new Error('hoseBarbPortAssembly: receiver block dimensions leave too little material around the port boss');
  }
  const portBoreDiameter = barbRootDiameter + runningClearance * 2;
  const portBore = cylinderAlongX(blockThickness + bossHeight + 0.8, portBoreDiameter / 2, bossHeight / 2, segments);
  const fuseOverlap = Math.min(0.04, faceClearance * 0.7);
  const bossCenterX = blockThickness / 2 + bossHeight / 2 - fuseOverlap;
  const receiver = union(
    box(blockThickness, blockWidth, blockHeight).translate(0, 0, -blockHeight / 2),
    cylinderAlongX(bossHeight + fuseOverlap, bossDiameter / 2, bossCenterX, segments),
  )
    .subtract(portBore)
    .color('#475569');
  const bossFaceX = blockThickness / 2 + bossHeight;
  const shoulderCenterX = bossFaceX + faceClearance + shoulderThickness / 2;
  const barbStartX = shoulderCenterX + shoulderThickness / 2;
  const fittingStartX = -blockThickness / 2 - runningClearance;
  const fittingEndX = barbStartX + barbStackLength;
  const fittingCore = tubeAlongX(fittingEndX - fittingStartX, barbRootDiameter / 2, fluidBoreDiameter / 2, (fittingStartX + fittingEndX) / 2, segments);
  const shoulder = tubeAlongX(shoulderThickness, shoulderDiameter / 2, fluidBoreDiameter / 2, shoulderCenterX, segments);
  const barbSolids: Shape[] = [];
  const ridgeLength = Math.max(0.8, Math.min(barbLength * 0.45, hoseInnerDiameter * 0.28));
  for (let index = 0; index < barbCount; index += 1) {
    const startX = barbStartX + index * barbLength;
    const ridgeCenterX = startX + barbLength - ridgeLength / 2;
    barbSolids.push(tubeAlongX(ridgeLength, barbPeakDiameter / 2, fluidBoreDiameter / 2, ridgeCenterX, segments));
  }
  const fitting = union(fittingCore, shoulder, ...barbSolids).color('#94a3b8');
  const hoseStartX = barbStartX + faceClearance;
  const hoseCenterX = hoseStartX + hoseLength / 2;
  const installedHoseBore = cylinderAlongX(hoseLength + 0.8, installedHoseBoreDiameter / 2, hoseCenterX, segments);
  const hose = tubeAlongX(hoseLength, hoseOuterDiameter / 2, installedHoseBoreDiameter / 2, hoseCenterX, segments).color('#111827');
  const clampCenterX = barbStartX + Math.min(barbStackLength * 0.55, Math.max(barbLength, clampWidth));
  const clamp = tubeAlongX(
    clampWidth,
    hoseOuterDiameter / 2 + clampThickness,
    hoseOuterDiameter / 2 + Math.min(0.08, runningClearance * 0.45),
    clampCenterX,
    segments,
  ).color('#cbd5e1');
  const parts = [
    { name: 'bored pump or filter body with raised hose-port boss', shape: receiver },
    { name: 'hollow hose barb fitting with shoulder and retention ridges', shape: fitting },
    { name: 'installed flexible hose over barb tail', shape: hose },
    { name: 'clamp band over hose and barb ridges', shape: clamp },
  ];
  return {
    parts,
    receiver,
    fitting,
    hose,
    clamp,
    cutters: { portBore, installedHoseBore },
    dims: {
      hoseInnerDiameter,
      hoseOuterDiameter,
      installedHoseBoreDiameter,
      blockThickness,
      blockWidth,
      blockHeight,
      bossDiameter,
      bossHeight,
      fluidBoreDiameter,
      barbRootDiameter,
      barbPeakDiameter,
      barbCount,
      barbLength,
      barbStackLength,
      shoulderDiameter,
      shoulderThickness,
      hoseLength,
      clampWidth,
      clampThickness,
      runningClearance,
      faceClearance,
    },
  };
}

// ---------------------------------------------------------------------------
// PCB terminal block
// ---------------------------------------------------------------------------

export function pcbTerminalBlockAssembly(options: any = {}) {
  const terminalCount = options.terminalCount ?? 4;
  if (!Number.isInteger(terminalCount) || terminalCount < 1 || terminalCount > 24) {
    throw new Error('pcbTerminalBlockAssembly: terminalCount must be an integer from 1 to 24');
  }
  const terminalPitch = requirePositive(options.terminalPitch ?? 5.08, 'terminalPitch');
  const terminalBlockWidth = terminalPitch * terminalCount + 3;
  const boardWidth = requirePositive(options.boardWidth ?? Math.max(50, terminalBlockWidth + 28), 'boardWidth');
  const boardDepth = requirePositive(options.boardDepth ?? 38, 'boardDepth');
  const boardThickness = requirePositive(options.boardThickness ?? 1.6, 'boardThickness');
  const backplateThickness = requirePositive(options.backplateThickness ?? 3, 'backplateThickness');
  const backplateMargin = requirePositive(options.backplateMargin ?? 5, 'backplateMargin');
  const standoffHeight = requirePositive(options.standoffHeight ?? 6, 'standoffHeight');
  const screwSize: MetricSize = options.screwSize ?? 'M3';
  const segments = options.segments ?? 28;
  const sizeData = METRIC_HOLE_TABLE[screwSize];
  if (!sizeData) throw new Error(`pcbTerminalBlockAssembly: unsupported screwSize "${screwSize}"`);
  const screwDiameter = parseFloat(screwSize.replace('M', ''));
  const screwHeadDiameter = sizeData.head;
  const screwHeadHeight = Math.max(1.2, screwDiameter * 0.55);
  const standoffDiameter = requirePositive(options.standoffDiameter ?? Math.max(screwHeadDiameter * 1.45, sizeData.normal + 3), 'standoffDiameter');
  const [mountInsetX, mountInsetY] = resolveBoltInset(options.mountingInset, Math.max(standoffDiameter / 2 + 1.2, screwHeadDiameter * 0.75));
  if (mountInsetX * 2 >= boardWidth || mountInsetY * 2 >= boardDepth) {
    throw new Error('pcbTerminalBlockAssembly: mountingInset leaves no room for the PCB mounting pattern');
  }
  const terminalBlockDepth = requirePositive(options.terminalBlockDepth ?? 10, 'terminalBlockDepth');
  const terminalBlockHeight = requirePositive(options.terminalBlockHeight ?? 9, 'terminalBlockHeight');
  const terminalEdgeInset = requirePositive(options.terminalEdgeInset ?? 5, 'terminalEdgeInset');
  const pinDiameter = requirePositive(options.pinDiameter ?? 0.9, 'pinDiameter');
  const pinClearance = requirePositive(options.pinClearance ?? 0.25, 'pinClearance');
  const pinTailLength = requireNonNegative(options.pinTailLength ?? 0, 'pinTailLength');
  const wirePortDiameter = requirePositive(options.wirePortDiameter ?? 2.6, 'wirePortDiameter');
  const pinHoleDiameter = pinDiameter + pinClearance;
  const terminalCenterY = -boardDepth / 2 + terminalEdgeInset + terminalBlockDepth / 2;
  const pinY = terminalCenterY + terminalBlockDepth * 0.24;
  const firstPinX = -((terminalCount - 1) * terminalPitch) / 2;
  const pinPositions: Array<[number, number]> = Array.from({ length: terminalCount }, (_, index) => [firstPinX + index * terminalPitch, pinY]);
  const mountingPositions: Array<[number, number]> = [
    [-boardWidth / 2 + mountInsetX, -boardDepth / 2 + mountInsetY],
    [boardWidth / 2 - mountInsetX, -boardDepth / 2 + mountInsetY],
    [-boardWidth / 2 + mountInsetX, boardDepth / 2 - mountInsetY],
    [boardWidth / 2 - mountInsetX, boardDepth / 2 - mountInsetY],
  ];
  if (terminalBlockWidth >= boardWidth - mountInsetX * 2) {
    throw new Error('pcbTerminalBlockAssembly: terminal block is too wide for the PCB mounting pattern');
  }
  if (terminalEdgeInset + terminalBlockDepth >= boardDepth - mountInsetY * 2) {
    throw new Error('pcbTerminalBlockAssembly: terminal block depth collides with the rear mounting datum');
  }
  if (pinHoleDiameter >= terminalPitch * 0.55) {
    throw new Error('pcbTerminalBlockAssembly: pinDiameter and pinClearance leave too little PCB web between terminal holes');
  }
  if (wirePortDiameter >= Math.min(terminalPitch * 0.72, terminalBlockHeight * 0.65)) {
    throw new Error('pcbTerminalBlockAssembly: wirePortDiameter is too large for the terminal pitch or body height');
  }
  for (const [index, [x, y]] of [...mountingPositions, ...pinPositions].entries()) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`pcbTerminalBlockAssembly: generated datum position ${index} is not finite`);
    }
  }
  const backplateWidth = boardWidth + backplateMargin * 2;
  const backplateDepth = boardDepth + backplateMargin * 2;
  const boardBottomZ = backplateThickness + standoffHeight;
  const boardTopZ = boardBottomZ + boardThickness;
  const standoffOverlap = Math.min(0.08, standoffHeight * 0.03);
  const standoffThreadEnvelopeDiameter = Math.max(sizeData.loose, screwDiameter + 1);
  const standoffThreadEnvelope = cylinder(standoffHeight + 0.8, standoffThreadEnvelopeDiameter / 2, undefined, segments).translate(0, 0, backplateThickness - 0.4);
  const standoffThreadEnvelopes = union(...mountingPositions.map(([x, y]) => standoffThreadEnvelope.translate(x, y, 0)));
  const standoff = cylinder(standoffHeight + standoffOverlap, standoffDiameter / 2, undefined, segments).translate(0, 0, backplateThickness - standoffOverlap).subtract(standoffThreadEnvelope);
  const standoffs = union(...mountingPositions.map(([x, y]) => standoff.translate(x, y, 0)));
  const backplate = union(box(backplateWidth, backplateDepth, backplateThickness), standoffs).color('#475569');
  const boardMountingHoleDiameter = sizeData.normal;
  const boardMountHole = cylinder(boardThickness + 0.8, boardMountingHoleDiameter / 2, undefined, segments).translate(0, 0, boardBottomZ - 0.4);
  const pcbMountingHoles = union(...mountingPositions.map(([x, y]) => boardMountHole.translate(x, y, 0)));
  const pinHole = cylinder(boardThickness + 0.8, pinHoleDiameter / 2, undefined, segments).translate(0, 0, boardBottomZ - 0.4);
  const pcbPinHoles = union(...pinPositions.map(([x, y]) => pinHole.translate(x, y, 0)));
  const pcb = box(boardWidth, boardDepth, boardThickness).translate(0, 0, boardBottomZ).subtract(pcbMountingHoles).subtract(pcbPinHoles).color('#166534');
  const terminalBodyBlank = box(terminalBlockWidth, terminalBlockDepth, terminalBlockHeight).translate(0, terminalCenterY, boardTopZ);
  const wirePort = cylinderAlongY(terminalBlockDepth + 0.8, wirePortDiameter / 2, terminalCenterY, segments).translate(0, 0, boardTopZ + terminalBlockHeight * 0.42);
  const wirePorts = union(...pinPositions.map(([x]) => wirePort.translate(x, 0, 0)));
  const clampScrewPockets = union(
    ...pinPositions.map(([x]) =>
      cylinder(Math.max(0.6, terminalBlockHeight * 0.22), Math.min(terminalPitch * 0.22, wirePortDiameter * 0.42), undefined, segments).translate(
        x,
        terminalCenterY + terminalBlockDepth * 0.12,
        boardTopZ + terminalBlockHeight * 0.76,
      ),
    ),
  );
  const pinLength = boardThickness + pinTailLength + Math.min(0.6, terminalBlockHeight * 0.08);
  const pinStartZ = boardBottomZ - pinTailLength;
  const pins = union(...pinPositions.map(([x, y]) => cylinder(pinLength, pinDiameter / 2, undefined, segments).translate(x, y, pinStartZ)));
  const terminalBlock = union(terminalBodyBlank.subtract(wirePorts).subtract(clampScrewPockets), pins).color('#16a34a');
  const screwShaftLength = boardThickness + standoffHeight * 0.85;
  const mountingHardware = fastenerSet(screwSize, screwShaftLength, {
    washerUnderHead: false,
    washerUnderNut: false,
    fit: 'normal',
    segments,
  });
  const screws = mountingPositions.map(([x, y]) => mountingHardware.bolt.translate(x, y, boardTopZ).color('#cbd5e1'));
  const parts = [
    { name: 'electronics backplate with fused PCB standoffs', shape: backplate },
    { name: 'PCB with mounting holes and terminal pin clearances', shape: pcb },
    { name: 'seated purchased terminal block with through-board pins', shape: terminalBlock },
    ...screws.map((shape, index) => ({ name: `installed ${screwSize} PCB mounting screw ${index + 1}`, shape })),
  ];
  return {
    parts,
    backplate,
    pcb,
    terminalBlock,
    screws,
    mountingPositions,
    pinPositions,
    cutters: { pcbMountingHoles, pcbPinHoles, standoffThreadEnvelopes },
    dims: {
      terminalCount,
      terminalPitch,
      boardWidth,
      boardDepth,
      boardThickness,
      backplateWidth,
      backplateDepth,
      backplateThickness,
      standoffHeight,
      standoffDiameter,
      screwSize,
      screwDiameter,
      screwHeadDiameter,
      screwHeadHeight,
      screwShaftLength,
      boardMountingHoleDiameter,
      standoffThreadEnvelopeDiameter,
      terminalBlockWidth,
      terminalBlockDepth,
      terminalBlockHeight,
      terminalEdgeInset,
      pinDiameter,
      pinClearance,
      pinHoleDiameter,
      pinTailLength,
      wirePortDiameter,
    },
  };
}

// ---------------------------------------------------------------------------
// Thumb-screw clamp
// ---------------------------------------------------------------------------

export function thumbScrewClampAssembly(options: any = {}) {
  const screwSize: MetricSize = options.screwSize ?? 'M6';
  const segments = options.segments ?? 36;
  const sizeData = METRIC_HOLE_TABLE[screwSize];
  if (!sizeData) throw new Error(`thumbScrewClampAssembly: unsupported screwSize "${screwSize}"`);
  const screwDiameter = parseFloat(screwSize.replace('M', ''));
  const runningClearance = requirePositive(options.runningClearance ?? 0.35, 'runningClearance');
  const faceClearance = requireNonNegative(options.faceClearance ?? 0, 'faceClearance');
  const threadEnvelopeDiameter = Math.max(sizeData.normal, screwDiameter + runningClearance * 2);
  const pressurePadDiameter = requirePositive(options.pressurePadDiameter ?? Math.max(screwDiameter * 3.2, 18), 'pressurePadDiameter');
  const pressurePadThickness = requirePositive(options.pressurePadThickness ?? Math.max(screwDiameter * 0.72, 4), 'pressurePadThickness');
  const knobDiameter = requirePositive(options.knobDiameter ?? Math.max(screwDiameter * 4.2, 24), 'knobDiameter');
  const knobThickness = requirePositive(options.knobThickness ?? Math.max(screwDiameter * 0.9, 7), 'knobThickness');
  const workpieceThickness = requirePositive(options.workpieceThickness ?? 18, 'workpieceThickness');
  const workpieceDepth = requirePositive(options.workpieceDepth ?? Math.max(46, pressurePadDiameter * 1.5), 'workpieceDepth');
  const workpieceHeight = requirePositive(options.workpieceHeight ?? Math.max(pressurePadDiameter * 1.35, 24), 'workpieceHeight');
  const frameDepth = requirePositive(options.frameDepth ?? Math.max(workpieceDepth + 12, pressurePadDiameter + 16), 'frameDepth');
  const baseThickness = requirePositive(options.baseThickness ?? Math.max(screwDiameter, 6), 'baseThickness');
  const jawThickness = requirePositive(options.jawThickness ?? Math.max(screwDiameter * 1.35, 9), 'jawThickness');
  const supportThickness = requirePositive(options.supportThickness ?? Math.max(screwDiameter * 1.8, 12), 'supportThickness');
  const bossLength = requirePositive(options.bossLength ?? Math.max(screwDiameter * 1.1, 8), 'bossLength');
  const bossDiameter = requirePositive(options.bossDiameter ?? Math.max(threadEnvelopeDiameter + 5, screwDiameter * 2.5), 'bossDiameter');
  const exposedScrewLength = requirePositive(options.exposedScrewLength ?? Math.max(pressurePadDiameter * 0.45, screwDiameter * 2.2), 'exposedScrewLength');
  const screwCenterZ = baseThickness + Math.max(workpieceHeight * 0.52, pressurePadDiameter * 0.68);
  const frameHeight = requirePositive(
    options.frameHeight ?? screwCenterZ - baseThickness + pressurePadDiameter / 2 + Math.max(baseThickness, 7),
    'frameHeight',
  );
  if (workpieceDepth > frameDepth - 6) {
    throw new Error('thumbScrewClampAssembly: frameDepth must leave side material around the clamped workpiece');
  }
  if (pressurePadDiameter > frameDepth - 4) {
    throw new Error('thumbScrewClampAssembly: pressurePadDiameter is too large for the frame depth');
  }
  if (bossDiameter > frameDepth - 4) {
    throw new Error('thumbScrewClampAssembly: bossDiameter is too large for the frame depth');
  }
  if (screwCenterZ - pressurePadDiameter / 2 <= baseThickness + 0.5) {
    throw new Error('thumbScrewClampAssembly: pressure pad collides with the base bridge');
  }
  if (baseThickness + frameHeight - screwCenterZ <= pressurePadDiameter / 2 + 2) {
    throw new Error('thumbScrewClampAssembly: frameHeight leaves too little material above the screw axis');
  }
  if (threadEnvelopeDiameter + 4 > Math.min(frameDepth, frameHeight)) {
    throw new Error('thumbScrewClampAssembly: threaded boss bore leaves too little surrounding frame material');
  }
  const workpieceLeftFaceX = -workpieceThickness / 2;
  const workpieceRightFaceX = workpieceThickness / 2;
  const anvilOverlap = Math.min(0.35, pressurePadThickness * 0.18);
  const anvilPadCenterX = workpieceLeftFaceX - faceClearance - pressurePadThickness / 2;
  const pressurePadCenterX = workpieceRightFaceX + faceClearance + pressurePadThickness / 2;
  const fixedJawRightFaceX = anvilPadCenterX - pressurePadThickness / 2 + anvilOverlap;
  const fixedJawCenterX = fixedJawRightFaceX - jawThickness / 2;
  const pressurePadRightFaceX = pressurePadCenterX + pressurePadThickness / 2;
  const supportInnerFaceX = pressurePadRightFaceX + exposedScrewLength;
  const supportCenterX = supportInnerFaceX + supportThickness / 2;
  const supportOuterFaceX = supportInnerFaceX + supportThickness;
  const frameLeftFaceX = fixedJawCenterX - jawThickness / 2;
  const frameRightFaceX = supportOuterFaceX;
  const baseLength = frameRightFaceX - frameLeftFaceX;
  if (baseLength <= 0 || !Number.isFinite(baseLength)) {
    throw new Error('thumbScrewClampAssembly: generated clamp frame length is invalid');
  }
  const bossCenterX = supportInnerFaceX + (supportThickness + bossLength) / 2;
  const threadedBossBore = cylinderAlongX(supportThickness + bossLength + 1, threadEnvelopeDiameter / 2, bossCenterX, segments).translate(0, 0, screwCenterZ);
  const frameOverlap = Math.min(0.12, baseThickness * 0.04);
  const base = box(baseLength, frameDepth, baseThickness).translate((frameLeftFaceX + frameRightFaceX) / 2, 0, 0);
  const fixedJaw = box(jawThickness, frameDepth, frameHeight + frameOverlap).translate(fixedJawCenterX, 0, baseThickness - frameOverlap);
  const support = box(supportThickness, frameDepth, frameHeight + frameOverlap).translate(supportCenterX, 0, baseThickness - frameOverlap);
  const boss = cylinderAlongX(supportThickness + bossLength, bossDiameter / 2, bossCenterX, segments).translate(0, 0, screwCenterZ);
  const anvilPad = cylinderAlongX(pressurePadThickness, pressurePadDiameter / 2, anvilPadCenterX, segments).translate(0, 0, screwCenterZ);
  const frame = union(base, fixedJaw, support, boss, anvilPad).subtract(threadedBossBore).color('#475569');
  const workpieceBottomZ = screwCenterZ - workpieceHeight / 2;
  const workpiece = box(workpieceThickness, workpieceDepth, workpieceHeight).translate(0, 0, workpieceBottomZ).color('#a16207');
  const pressurePad = cylinderAlongX(pressurePadThickness, pressurePadDiameter / 2, pressurePadCenterX, segments).translate(0, 0, screwCenterZ);
  const knobCenterX = supportOuterFaceX + bossLength + runningClearance + knobThickness / 2;
  const knob = cylinderAlongX(knobThickness, knobDiameter / 2, knobCenterX, segments).translate(0, 0, screwCenterZ);
  const shaftLeftX = pressurePadRightFaceX - Math.min(pressurePadThickness * 0.45, screwDiameter * 0.45);
  const shaftRightX = knobCenterX + knobThickness / 2;
  const shaftLength = shaftRightX - shaftLeftX;
  if (shaftLength <= supportThickness + bossLength) {
    throw new Error('thumbScrewClampAssembly: generated screw length is too short for the threaded support');
  }
  const shaft = cylinderAlongX(shaftLength, screwDiameter / 2, (shaftLeftX + shaftRightX) / 2, segments).translate(0, 0, screwCenterZ);
  const clampScrew = union(shaft, pressurePad, knob).color('#cbd5e1');
  const workpieceEnvelope = box(workpieceThickness, workpieceDepth, workpieceHeight).translate(0, 0, workpieceBottomZ);
  return {
    parts: [
      { name: 'thumb-screw clamp frame with fixed anvil and threaded boss', shape: frame },
      { name: 'representative clamped workpiece between pads', shape: workpiece },
      { name: 'installed thumb screw with captive pressure pad and hand knob', shape: clampScrew },
    ],
    frame,
    workpiece,
    clampScrew,
    cutters: { threadedBossBore, workpieceEnvelope },
    dims: {
      screwSize,
      screwDiameter,
      threadEnvelopeDiameter,
      workpieceThickness,
      workpieceDepth,
      workpieceHeight,
      frameDepth,
      frameHeight,
      baseThickness,
      jawThickness,
      supportThickness,
      bossLength,
      bossDiameter,
      exposedScrewLength,
      pressurePadDiameter,
      pressurePadThickness,
      knobDiameter,
      knobThickness,
      screwCenterZ,
      fixedAnvilFaceX: workpieceLeftFaceX - faceClearance,
      pressurePadFaceX: workpieceRightFaceX + faceClearance,
      supportInnerFaceX,
      runningClearance,
      faceClearance,
    },
  };
}

// ---------------------------------------------------------------------------
// Datum enclosure
// ---------------------------------------------------------------------------

export function datumEnclosureAssembly(options: any) {
  const width = requirePositive(options.width, 'width');
  const depth = requirePositive(options.depth, 'depth');
  const height = requirePositive(options.height, 'height');
  const wallThickness = requirePositive(options.wallThickness ?? 2.4, 'wallThickness');
  const baseThickness = requirePositive(options.baseThickness ?? wallThickness, 'baseThickness');
  const coverThickness = requirePositive(options.coverThickness ?? 2.4, 'coverThickness');
  const ledgeWidth = requirePositive(options.ledgeWidth ?? Math.max(3.6, wallThickness * 1.35), 'ledgeWidth');
  const gasketThickness = requireNonNegative(options.gasketThickness ?? 0.8, 'gasketThickness');
  const faceClearance = requirePositive(options.faceClearance ?? 0.04, 'faceClearance');
  const screwSize: MetricSize = options.screwSize ?? 'M3';
  const coverFit = options.coverFit ?? 'normal';
  const segments = options.segments ?? 32;
  const sizeData = METRIC_HOLE_TABLE[screwSize];
  if (!sizeData) throw new Error(`datumEnclosureAssembly: unsupported screwSize "${screwSize}"`);
  const innerWidth = width - wallThickness * 2;
  const innerDepth = depth - wallThickness * 2;
  if (innerWidth <= ledgeWidth * 2 + 8 || innerDepth <= ledgeWidth * 2 + 8) {
    throw new Error('datumEnclosureAssembly: wallThickness and ledgeWidth leave too little internal opening');
  }
  if (height <= baseThickness + coverThickness + 4) {
    throw new Error('datumEnclosureAssembly: height must leave room for internal ribs and standoffs');
  }
  const standoffDiameter = requirePositive(options.standoffDiameter ?? Math.max(sizeData.head * 1.65, sizeData.close * 2.2), 'standoffDiameter');
  const minInset = wallThickness + Math.max(ledgeWidth, standoffDiameter / 2 + 1.2);
  const [insetX, insetY] = resolveBoltInset(options.screwInset, minInset);
  if (insetX * 2 >= width || insetY * 2 >= depth) {
    throw new Error('datumEnclosureAssembly: screwInset leaves no room for the standoff datum');
  }
  const screwPositions: Array<[number, number]> = options.screwPositions ?? [
    [-width / 2 + insetX, -depth / 2 + insetY],
    [width / 2 - insetX, -depth / 2 + insetY],
    [-width / 2 + insetX, depth / 2 - insetY],
    [width / 2 - insetX, depth / 2 - insetY],
  ];
  if (screwPositions.length === 0) throw new Error('datumEnclosureAssembly: screwPositions must contain at least one point');
  for (const [index, [x, y]] of screwPositions.entries()) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`datumEnclosureAssembly: screwPositions[${index}] must contain finite numbers`);
    }
    if (Math.abs(x) + standoffDiameter / 2 > innerWidth / 2 || Math.abs(y) + standoffDiameter / 2 > innerDepth / 2) {
      throw new Error(`datumEnclosureAssembly: screwPositions[${index}] does not fit inside the enclosure walls`);
    }
  }
  const ribHeight = requirePositive(options.ribHeight ?? Math.min(height * 0.24, Math.max(2.4, baseThickness * 1.4)), 'ribHeight');
  const ribThickness = requirePositive(options.ribThickness ?? Math.max(1.2, wallThickness * 0.75), 'ribThickness');
  const portWidth = requirePositive(options.portWidth ?? Math.min(innerWidth * 0.28, Math.max(12, width * 0.16)), 'portWidth');
  const portHeight = requirePositive(options.portHeight ?? Math.min(height * 0.42, Math.max(5, height * 0.28)), 'portHeight');
  if (portWidth >= innerWidth - ledgeWidth * 2) {
    throw new Error('datumEnclosureAssembly: portWidth must fit between internal ledges and standoffs');
  }
  if (portHeight >= height - baseThickness - 1) {
    throw new Error('datumEnclosureAssembly: portHeight must leave material above and below the service port');
  }
  const screwLength = requirePositive(options.screwLength ?? coverThickness + gasketThickness + Math.max(6, height * 0.45), 'screwLength');
  const coverHole = fastenerHole({
    size: screwSize,
    fit: coverFit,
    depth: coverThickness + 0.6,
    center: true,
    segments,
    counterbore: { depth: Math.min(coverThickness * 0.6, Math.max(0.6, coverThickness - 0.35)) },
  });
  const standoffTap = fastenerHole({ size: screwSize, fit: 'tap', depth: height + 0.8, center: true, segments });
  const standoffThreadEnvelope = fastenerHole({ size: screwSize, fit: 'close', depth: height + 0.8, center: true, segments });
  const coverClearance = placeCutterAtPositions(coverHole, screwPositions, coverThickness / 2);
  const standoffTappedPattern = placeCutterAtPositions(standoffTap, screwPositions, height / 2);
  const standoffThreadEnvelopePattern = placeCutterAtPositions(standoffThreadEnvelope, screwPositions, height / 2);
  const fuseOverlap = Math.min(0.06, Math.max(0.02, wallThickness * 0.02));
  const ledgeThickness = Math.min(Math.max(1.1, coverThickness * 0.45), height * 0.2);
  const sideX = width / 2 - wallThickness / 2;
  const sideY = depth / 2 - wallThickness / 2;
  const ledgeZ = height - ledgeThickness;
  const baseSolids = [
    box(width, depth, baseThickness),
    box(wallThickness, depth, height).translate(sideX, 0, 0),
    box(wallThickness, depth, height).translate(-sideX, 0, 0),
    box(width, wallThickness, height).translate(0, sideY, 0),
    box(width, wallThickness, height).translate(0, -sideY, 0),
    box(ledgeWidth, innerDepth, ledgeThickness).translate(-width / 2 + wallThickness + ledgeWidth / 2, 0, ledgeZ),
    box(ledgeWidth, innerDepth, ledgeThickness).translate(width / 2 - wallThickness - ledgeWidth / 2, 0, ledgeZ),
    box(innerWidth, ledgeWidth, ledgeThickness).translate(0, -depth / 2 + wallThickness + ledgeWidth / 2, ledgeZ),
    box(innerWidth, ledgeWidth, ledgeThickness).translate(0, depth / 2 - wallThickness - ledgeWidth / 2, ledgeZ),
    box(Math.max(1, innerWidth - standoffDiameter * 1.8), ribThickness, ribHeight + fuseOverlap).translate(0, 0, baseThickness - fuseOverlap),
    box(ribThickness, Math.max(1, innerDepth - standoffDiameter * 1.8), ribHeight + fuseOverlap).translate(0, 0, baseThickness - fuseOverlap),
    ...screwPositions.map(([x, y]) =>
      cylinder(height - baseThickness + fuseOverlap, standoffDiameter / 2, undefined, segments).translate(x, y, baseThickness - fuseOverlap),
    ),
  ];
  const servicePort = box(portWidth, wallThickness + 1, portHeight).translate(
    0,
    -depth / 2 + wallThickness / 2,
    baseThickness + Math.max(0.8, (height - baseThickness - portHeight) * 0.35),
  );
  const base = union(...baseSolids).subtract(standoffThreadEnvelopePattern).subtract(servicePort).color('#475569');
  const gasketFrameCutter = box(Math.max(1, width - ledgeWidth * 2), Math.max(1, depth - ledgeWidth * 2), gasketThickness + 0.6).translate(0, 0, -0.3);
  const gasket =
    gasketThickness > 0
      ? box(width, depth, gasketThickness)
          .subtract(gasketFrameCutter)
          .subtract(placeCutterAtPositions(coverHole, screwPositions, gasketThickness / 2))
          .translate(0, 0, height + faceClearance)
          .color('#111827')
      : null;
  const coverZ = height + faceClearance + (gasket ? gasketThickness + faceClearance : 0);
  const cover = box(width, depth, coverThickness).subtract(coverClearance).translate(0, 0, coverZ).color('#334155');
  const hardware = fastenerSet(screwSize, screwLength, { washerUnderHead: false, washerUnderNut: false, fit: coverFit, segments });
  const screwOriginZ = coverZ + coverThickness;
  const screws = screwPositions.map(([x, y]) => hardware.bolt.translate(x, y, screwOriginZ).color('#94a3b8'));
  const parts = [
    { name: 'datum enclosure base tray with walls ribs standoffs and service port', shape: base },
    ...(gasket ? [{ name: 'datum enclosure gasket seated on continuous ledge', shape: gasket }] : []),
    { name: 'datum enclosure cover plate with matched screw pattern', shape: cover },
    ...screws.map((shape, index) => ({ name: `installed ${screwSize} enclosure screw ${index + 1}`, shape })),
  ];
  return {
    parts,
    base,
    cover,
    gasket,
    screws,
    screwPositions,
    cutters: {
      coverClearance,
      standoffTapped: standoffTappedPattern,
      standoffThreadEnvelope: standoffThreadEnvelopePattern,
      servicePort,
    },
    dims: {
      width,
      depth,
      height,
      innerWidth,
      innerDepth,
      wallThickness,
      baseThickness,
      coverThickness,
      ledgeWidth,
      gasketThickness,
      faceClearance,
      screwSize,
      screwLength,
      standoffDiameter,
      ribHeight,
      ribThickness,
      portWidth,
      portHeight,
      clearanceDia: sizeData[coverFit as 'normal'],
      tapDia: sizeData.tap,
      threadEnvelopeDia: sizeData.close,
    },
  };
}

// ---------------------------------------------------------------------------
// Routed tube / cable retained by saddle clips
// ---------------------------------------------------------------------------

export interface RoutedTubeClipAssemblyOptions {
  tubeDiameter: number;
  tubeLength?: number;
  clipCount?: number;
  screwSize?: MetricSize;
  panelThickness?: number;
  runningClearance?: number;
  clipWallThickness?: number;
  clipWidth?: number;
  clipSpacing?: number;
  panelLength?: number;
  panelWidth?: number;
  segments?: number;
}

export interface RoutedTubeClipAssemblyResult {
  parts: Array<{ name: string; shape: Shape }>;
  panel: Shape;
  tube: Shape;
  clips: Shape[];
  screws: Shape[];
  clipCenters: number[];
  screwPositions: Array<[number, number]>;
  cutters: { clipTubeBores: Shape; clipScrewClearances: Shape; panelThreadEnvelopes: Shape };
  dims: Record<string, number | string>;
}

/**
 * Routed tube or cable retained by saddle clips with real bores, screw holes,
 * and installed screws.
 *
 * Coordinate convention: the routed tube runs along +X through the world
 * origin. The base panel starts at `z=0`; clips sit on top of the panel, and
 * the tube passes through their bores.
 */
export function routedTubeClipAssembly(options: RoutedTubeClipAssemblyOptions): RoutedTubeClipAssemblyResult {
  const tubeDiameter = requirePositive(options.tubeDiameter, 'tubeDiameter');
  const tubeLength = requirePositive(options.tubeLength ?? 120, 'tubeLength');
  const panelThickness = requirePositive(options.panelThickness ?? 3, 'panelThickness');
  const runningClearance = requirePositive(options.runningClearance ?? 0.35, 'runningClearance');
  const screwSize = options.screwSize ?? 'M3';
  const segments = options.segments ?? 32;
  const sizeData = METRIC_HOLE_TABLE[screwSize];
  if (!sizeData) throw new Error(`routedTubeClipAssembly: unsupported screwSize "${screwSize}"`);
  const clipCount = options.clipCount ?? 3;
  if (!Number.isInteger(clipCount) || clipCount < 1 || clipCount > 8) {
    throw new Error('routedTubeClipAssembly: clipCount must be an integer from 1 to 8');
  }
  const screwDiameter = parseFloat(screwSize.replace('M', ''));
  const screwHeadDiameter = sizeData.head;
  const tubeBoreDiameter = tubeDiameter + runningClearance * 2;
  const clipWallThickness = requirePositive(
    options.clipWallThickness ?? Math.max(screwHeadDiameter + 1.2, tubeDiameter * 0.45, 5),
    'clipWallThickness',
  );
  const clipWidth = requirePositive(options.clipWidth ?? Math.max(screwHeadDiameter + 3, tubeDiameter * 1.4, 10), 'clipWidth');
  const clipDepth = tubeBoreDiameter + clipWallThickness * 2;
  const bottomWall = Math.max(1.2, clipWallThickness * 0.35);
  const topWall = Math.max(2, clipWallThickness * 0.45);
  const clipHeight = bottomWall + tubeBoreDiameter + topWall;
  const tubeCenterZ = panelThickness + bottomWall + tubeBoreDiameter / 2;
  const panelLength = requirePositive(options.panelLength ?? tubeLength + 24, 'panelLength');
  const panelWidth = requirePositive(options.panelWidth ?? clipDepth + Math.max(14, screwHeadDiameter * 2), 'panelWidth');
  if (tubeLength <= clipWidth + 8) {
    throw new Error('routedTubeClipAssembly: tubeLength must leave visible tube beyond the clip body');
  }
  const defaultSpacing = clipCount === 1 ? 0 : Math.max(clipWidth + 8, (tubeLength - clipWidth * 2) / (clipCount - 1));
  const clipSpacing = options.clipSpacing === undefined ? defaultSpacing : requirePositive(options.clipSpacing, 'clipSpacing');
  const clipCenters = Array.from({ length: clipCount }, (_, index) => (index - (clipCount - 1) / 2) * clipSpacing);
  const maxClipExtent = Math.max(...clipCenters.map((x) => Math.abs(x) + clipWidth / 2));
  if (maxClipExtent > tubeLength / 2 - 2) {
    throw new Error('routedTubeClipAssembly: clipSpacing places a clip beyond the routed tube length');
  }
  if (maxClipExtent > panelLength / 2 - 2) {
    throw new Error('routedTubeClipAssembly: panelLength is too short for the clip pattern');
  }
  const boreRadius = tubeBoreDiameter / 2;
  const screwY = boreRadius + clipWallThickness / 2;
  if (screwY + screwHeadDiameter / 2 > clipDepth / 2 - 0.2) {
    throw new Error('routedTubeClipAssembly: clipWallThickness leaves too little land for screw heads');
  }
  if (clipDepth > panelWidth - Math.max(4, screwHeadDiameter * 0.5)) {
    throw new Error('routedTubeClipAssembly: panelWidth leaves too little material beside the clips');
  }
  const screwPositions: Array<[number, number]> = clipCenters.flatMap((x) => [
    [x, -screwY] as [number, number],
    [x, screwY] as [number, number],
  ]);
  const screwClearanceDiameter = Math.max(sizeData.loose, screwDiameter + 0.8);
  const panelThreadEnvelopeDiameter = screwClearanceDiameter;
  const clipTopZ = panelThickness + clipHeight;

  const clipTubeBores = union(
    ...clipCenters.map((x) => cylinderAlongX(clipWidth + 0.8, boreRadius, x, segments).translate(0, 0, tubeCenterZ)),
  );
  const clipScrewClearances = union(
    ...screwPositions.map(([x, y]) => cylinder(clipHeight + 0.8, screwClearanceDiameter / 2, undefined, segments).translate(x, y, panelThickness - 0.4)),
  );
  const panelThreadEnvelopes = union(
    ...screwPositions.map(([x, y]) => cylinder(panelThickness + 0.8, panelThreadEnvelopeDiameter / 2, undefined, segments).translate(x, y, -0.4)),
  );

  const panel = box(panelLength, panelWidth, panelThickness).subtract(panelThreadEnvelopes).color('#475569');
  const tube = cylinderAlongX(tubeLength, tubeDiameter / 2, 0, segments).translate(0, 0, tubeCenterZ).color('#0f172a');
  const clips = clipCenters.map((x) => {
    const body = box(clipWidth, clipDepth, clipHeight).translate(x, 0, panelThickness);
    const tubeBore = cylinderAlongX(clipWidth + 0.8, boreRadius, x, segments).translate(0, 0, tubeCenterZ);
    const screwHoles = union(
      cylinder(clipHeight + 0.8, screwClearanceDiameter / 2, undefined, segments).translate(x, -screwY, panelThickness - 0.4),
      cylinder(clipHeight + 0.8, screwClearanceDiameter / 2, undefined, segments).translate(x, screwY, panelThickness - 0.4),
    );
    return body.subtract(tubeBore).subtract(screwHoles).color('#94a3b8');
  });

  const screwLength = clipHeight + panelThickness * 0.65;
  const screwHeadHeight = Math.max(1.2, screwDiameter * 0.55);
  const screwBlank = union(
    cylinder(screwLength, screwDiameter / 2, undefined, segments).translate(0, 0, clipTopZ - screwLength),
    cylinder(screwHeadHeight, screwHeadDiameter / 2, undefined, segments).translate(0, 0, clipTopZ),
  ).color('#cbd5e1');
  const screws = screwPositions.map(([x, y]) => screwBlank.translate(x, y, 0));

  const parts = [
    { name: 'panel with tube-clip screw receiving holes', shape: panel },
    { name: 'routed flexible tube through retained clip bores', shape: tube },
    ...clips.map((shape, index) => ({ name: `saddle tube clip ${index + 1} with through-bore`, shape })),
    ...screws.map((shape, index) => ({ name: `installed ${screwSize} tube clip screw ${index + 1}`, shape })),
  ];

  return {
    parts,
    panel,
    tube,
    clips,
    screws,
    clipCenters,
    screwPositions,
    cutters: { clipTubeBores, clipScrewClearances, panelThreadEnvelopes },
    dims: {
      tubeDiameter,
      tubeLength,
      tubeBoreDiameter,
      panelLength,
      panelWidth,
      panelThickness,
      clipCount,
      clipWidth,
      clipDepth,
      clipHeight,
      clipWallThickness,
      tubeCenterZ,
      screwSize,
      screwDiameter,
      screwHeadDiameter,
      screwLength,
      screwClearanceDiameter,
      panelThreadEnvelopeDiameter,
      runningClearance,
    },
  };
}

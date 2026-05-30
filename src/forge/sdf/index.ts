/**
 * SDF module barrel export.
 *
 * The `sdf` namespace is the user-facing API. Internal types (SdfNode, evaluator)
 * are imported directly by the backend lowering code.
 */

export type {
  BasketWeaveOptions,
  BlendOptions,
  BrickOptions,
  CombineOptions,
  HoneycombOptions,
  KnurlOptions,
  NoiseOptions,
  Pattern2DOverUnderWeaveOptions,
  Pattern2DSineWaveOptions,
  Pattern2DStripesOptions,
  PerforatedOptions,
  ScalesOptions,
  SculptBoxOptions,
  SculptLookPreset,
  SculptPoint,
  SculptPointList,
  SculptPolishInput,
  SculptTubeOptions,
  SdfBoundsInput,
  SdfFunctionOptions,
  SdfToShapeOptions,
  SurfaceDisplaceOptions,
  TpmsBlockOptions,
  TpmsOptions,
  VoronoiOptions,
  WavesOptions,
  WeaveOptions,
} from './sdf';
export {
  // Surface patterns (displacement)
  basketWeave,
  bend,
  blend,
  box,
  // Surface patterns (intersection)
  brick,
  capsule,
  // Materialization
  circularArray,
  combine,
  cone,
  cylinder,
  diamond,
  // Custom
  fromFunction,
  // TPMS
  gyroid,
  // Patterns
  honeycomb,
  knurl,
  lidinoid,
  morph,
  // Noise
  noise,
  // Typed 2D surface patterns
  Pattern2D,
  Pattern2DBuilder,
  pattern2d,
  patternNd,
  perforated,
  repeat,
  scales,
  // Sculpt facade
  Sculpt,
  // Builder class
  SdfShape,
  schwarzP,
  smoothDifference,
  smoothIntersection,
  // Smooth combinators
  smoothUnion,
  // Primitives
  sphere,
  // Surface pattern type
  SurfacePattern,
  toShape,
  torus,
  tpmsBlock,
  // Domain ops
  twist,
  voronoi,
  waves,
  weave,
  withinBox,
} from './sdf';

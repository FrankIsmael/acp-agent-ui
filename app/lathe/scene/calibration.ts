/**
 * Where things are in `public/models/lathe.glb` (meters, Y up, operator side +Z, headstock at −X),
 * measured from each mesh's world bounding box. The parts are unnamed (`Body_N`), so the moving
 * groups are listed by name here.
 *
 * Machine axes in world space: program +Z (away from the chuck) is world +X, and program +X
 * (diameter, toward the operator) is world +Z. The tool cuts at spindle height.
 */

export const SPINDLE_Y = 1.101; // spindle center line, from the chuck body (Ø200, Body_98)
export const SPINDLE_Z = 0.057;
export const JAW_FACE_X = -0.28; // front of the jaws; the stick-out is measured from here
export const JAW_GRIP_RADIUS = 0.018; // radius the model's jaws are closed to

/** Tool tip position (world) when the carriage and cross-slide groups are at their modeled place. */
export const TIP_HOME = { x: -0.015, z: 0.16 };

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `Body_${from + i}`);

export const PARTS = {
  chuckBody: range(96, 98),
  jaws: range(99, 104),
  // Saddle, apron and their handwheels: they follow program Z.
  carriage: ['Body_64', 'Body_65', ...range(71, 83)],
  // Cross-slide, compound and tool post: they ride on the carriage and follow program X.
  crossSlide: [...range(38, 63), ...range(66, 70)],
};

/** World X of a program Z, for a bar with this stick-out and face stock. */
export const worldX = (z: number, stock: { stickout: number; faceStock: number }) =>
  JAW_FACE_X + (stock.stickout - stock.faceStock + z) / 1000;

/** World Z of a program X (diameter). */
export const worldZ = (x: number) => SPINDLE_Z + x / 2000;

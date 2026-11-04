export { COORD_SCALE, decodeStroke, decodeStrokes, encodeStroke, encodeStrokes } from "./codec";
export { outlineBounds, strokeOutline } from "./outline";
export { flattenInk, INK_DATA_KEY, readInk, removeInk, writeInk, type WriteInkOptions } from "./pdf";
export { normalizeStroke, simplifyPoints } from "./simplify";
export type { InkPoint, InkTool, Stroke } from "./types";

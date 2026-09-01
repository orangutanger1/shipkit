// Compositing store screenshots from a spec, a raw capture and caption copy.
//
// Two modes, one caption pipeline. See shots-spec.mjs for why both exist.
//
// device-frame
//   The iPhone mockup is never redrawn. Its layers are the committed Figma
//   exports, composited in Figma's z-order with the localized capture masked
//   into the screen cutout — so bezel, notch and speaker are the artwork the
//   design tool produced and only the pixels behind the glass change.
//
// caption-band
//   The finished composite already exists and only the caption band is
//   repainted. Legal exactly when that band is flat background: the renderer
//   measures the flatness itself and refuses below the spec's threshold rather
//   than quietly painting over artwork.
//
// Split by responsibility:
//   shots-geometry.mjs  — pure spec/pixel math (no sharp, no I/O)
//   shots-composite.mjs — sharp rendering of both modes
//   shots-verify.mjs    — calibration + safety vs the design reference
export {
	bandBounds,
	captionBudget,
	captionRect,
	frameFile,
	glassRect,
	measureBand,
	parseColour,
	sourceLineCounts,
} from './shots-geometry.mjs';
export { renderLocales } from './shots-composite.mjs';
export { verify } from './shots-verify.mjs';

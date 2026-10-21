/**
 * GLSL for Score. Geometry first: three horizontal signal lanes, a second-by-second time grid, onset markers and a
 * current-time boundary. Every x position is computed from a sample's PLAYHEAD time against the displayed clock `uNow`, so
 * history scrolls right to left on the GPU and only a newly appended sample uploads data. No textures, no render targets,
 * no post-processing.
 *
 * Colours are written raw (a ShaderMaterial does no colour-space conversion), so the lane hexes #FF9900, #00F0FF and
 * #9D00FF appear on screen as specified.
 *
 * The scene supplies these #defines (see scene.ts): NOW_X, UNITS_PER_S, WINDOW_S, LANE_H, GRID_Y0, GRID_Y1, GRID_Z, GRID_N.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Lanes. Attributes: aSide (-1 or 1 across the strip), aT (sample playhead time), aVal = (bass, mid, high, bassHit),
// aMeta = (alternating sign per sample, unused). uLane: 0 bass, 1 mid, 2 high.
//   bass  a filled, mirrored envelope: its thickness IS the bass level, plus a short extra swell on a bass hit (weight)
//   mid   a smooth trace whose height follows the level, with a slow undulation whose depth follows the level (trajectory)
//   high  a fine trace that alternates around the lane's centre line with an amplitude of the level (detail)
// The undulation and the alternation are encodings of the level, tied to sample time so they travel with the history;
// they are not extra signal.
// ---------------------------------------------------------------------------------------------------------------------
export const LANE_VERT = /* glsl */ `
attribute float aSide;
attribute float aT;
attribute vec4 aVal;
attribute vec2 aMeta;
uniform float uNow;
uniform float uLane;
uniform float uLaneY;
uniform float uLaneZ;
uniform float uXs;
varying float vSide;
varying float vFade;
varying float vV;

void main() {
  float age = uNow - aT;
  float x = (NOW_X - age * UNITS_PER_S) * uXs;
  float y = uLaneY;
  float v;
  float half_ = 0.0;
  if (uLane < 0.5) {
    v = aVal.x;
    float th = 0.03 + v * 0.80 + aVal.w * 0.18;
    y += aSide * th * LANE_H;
  } else if (uLane < 1.5) {
    v = aVal.y;
    float und = v * 0.10 * sin(aT * 7.0);
    y += ((v - 0.35) * 1.5 + und) * LANE_H + aSide * 0.035;
  } else {
    v = aVal.z;
    y += aMeta.x * v * 0.40 * LANE_H + aSide * 0.032;
  }
  vSide = aSide;
  vV = v;
  vFade = 1.0 - smoothstep(0.80, 1.0, age / WINDOW_S);
  if (age < -0.05 || age > WINDOW_S) vFade = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, uLaneZ, 1.0);
}
`;

export const LANE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColour;
uniform float uLane;
uniform float uIllum;
varying float vSide;
varying float vFade;
varying float vV;
void main() {
  float lvl = 0.80 + 0.20 * uIllum;
  float a;
  if (uLane < 0.5) {
    float edge = smoothstep(0.78, 1.0, abs(vSide));
    a = 0.22 + 0.30 * vV + 0.55 * edge;
  } else if (uLane < 1.5) {
    a = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
    a = 0.25 + 0.75 * a;
  } else {
    a = 1.0 - smoothstep(0.4, 1.0, abs(vSide));
    a = 0.20 + 0.65 * a;
  }
  gl_FragColor = vec4(uColour * lvl, clamp(a * vFade, 0.0, 1.0));
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Time grid: vertical lines at every whole second of playhead time, brighter every fourth second. They move with the
// timeline exactly as the samples do. aK = how many seconds back from the current whole second; aEnd = bottom (0) or top (1).
// ---------------------------------------------------------------------------------------------------------------------
export const GRID_VERT = /* glsl */ `
attribute float aK;
attribute float aEnd;
uniform float uNow;
uniform float uXs;
varying float vFade;
varying float vMajor;
void main() {
  float tk = floor(uNow) - aK;
  float age = uNow - tk;
  float x = (NOW_X - age * UNITS_PER_S) * uXs;
  vMajor = step(mod(tk, 4.0), 0.5);
  vFade = (1.0 - smoothstep(0.80, 1.0, age / WINDOW_S)) * step(0.0, tk);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(x, mix(GRID_Y0, GRID_Y1, aEnd), GRID_Z, 1.0);
}
`;

export const GRID_FRAG = /* glsl */ `
precision highp float;
uniform float uIllum;
varying float vFade;
varying float vMajor;
void main() {
  float a = mix(0.07, 0.20, vMajor) * (0.6 + 0.6 * uIllum) * vFade;
  gl_FragColor = vec4(0.62, 0.72, 0.85, a);
}
`;

// Baselines and rails: static lines. aCol carries each line's colour and alpha.
export const RULE_VERT = /* glsl */ `
attribute vec4 aCol;
varying vec4 vCol;
void main() {
  vCol = aCol;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const RULE_FRAG = /* glsl */ `
precision highp float;
uniform float uIllum;
varying vec4 vCol;
void main() {
  gl_FragColor = vec4(vCol.rgb, vCol.a * (0.7 + 0.5 * uIllum));
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Onset markers: a thin vertical rule across the lane stack and a small diamond at its head, at the playhead time the onset
// was detected. aT = that time (a very old value hides an unused slot), aS = onset strength, aEnd = bottom (0) or top (1).
// A short arrival lift is the only animation; reduced motion turns it off.
// ---------------------------------------------------------------------------------------------------------------------
export const MARK_VERT = /* glsl */ `
attribute float aT;
attribute float aS;
attribute float aEnd;
uniform float uNow;
uniform float uXs;
uniform float uScale;
uniform float uReduced;
varying float vA;
varying float vHead;
void main() {
  float age = uNow - aT;
  float x = (NOW_X - age * UNITS_PER_S) * uXs;
  float fade = (1.0 - smoothstep(0.80, 1.0, age / WINDOW_S)) * step(-0.05, age) * step(age, WINDOW_S);
  float arrive = (1.0 - uReduced) * (1.0 - smoothstep(0.0, 0.18, age));
  vA = fade * (0.22 + 0.22 * aS + 0.30 * arrive);
  vHead = aEnd;
  gl_PointSize = aEnd > 0.5 ? 8.0 * uScale : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(x, mix(GRID_Y0, GRID_Y1, aEnd), GRID_Z + 0.05, 1.0);
}
`;

export const MARK_LINE_FRAG = /* glsl */ `
precision highp float;
varying float vA;
void main() {
  gl_FragColor = vec4(0.96, 0.95, 0.90, vA * 0.7);
}
`;

export const MARK_POINT_FRAG = /* glsl */ `
precision highp float;
varying float vA;
void main() {
  vec2 p = abs(gl_PointCoord - 0.5);
  if (p.x + p.y > 0.5) discard;
  gl_FragColor = vec4(0.98, 0.96, 0.90, vA);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Current-time boundary: a thin bright rule where new history enters. Decorative plates behind the lanes (optional).
// ---------------------------------------------------------------------------------------------------------------------
export const NOW_VERT = /* glsl */ `
varying float vY;
void main() {
  vY = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const NOW_FRAG = /* glsl */ `
precision highp float;
uniform float uActive;
uniform float uIllum;
varying float vY;
void main() {
  float a = (0.28 + 0.34 * uActive) * (0.75 + 0.35 * uIllum);
  gl_FragColor = vec4(0.90, 0.96, 1.0, a);
}
`;

export const PLATE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const PLATE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColour;
uniform float uIllum;
varying vec2 vUv;
void main() {
  float band = 1.0 - smoothstep(0.0, 1.0, abs(vUv.y - 0.5) * 2.0);
  float side = smoothstep(0.0, 0.12, vUv.x);
  gl_FragColor = vec4(uColour, band * side * (0.010 + 0.016 * uIllum));
}
`;

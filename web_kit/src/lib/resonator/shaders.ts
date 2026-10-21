/**
 * GLSL for Resonator. Artistic: fluid ribbon rings, gold light tracks with node beads, spectrum-style bars, a plasma
 * heart, a floor with a mirrored copy of the light, and a suspended particle field. Every effect is driven by uniforms
 * only: no textures and no render targets (the glass orb's transmission is the one exception and lives in scene.ts).
 *
 * The scene supplies these #defines (see scene.ts): RING_N, R_IN, R_OUT, HALF_W, TRACK_HALF, TRACK_Y, P_R0, P_R1, P_Y0, P_H.
 *
 * "Bloom" here is in-scene additive glow (tracks, bars, halo): the shared GlHost draws straight to the canvas with no
 * post-processing pass, and a full-screen bloom is not affordable on Intel UHD without changing that host.
 */

const NOISE = /* glsl */ `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Ribbons. position = (angle, side -1..1, ring index). One draw call for every ring.
// Whole-number angular modes (3, 5, 9, 14) keep each ring seamless at angle 0 / 2 pi. Mids lift the inner rings and
// modulate the radius; highs drive the outer ripple. Phases are accumulated on the CPU, so a level change never jumps them.
// ---------------------------------------------------------------------------------------------------------------------
export const RIBBON_VERT = /* glsl */ `
uniform float uRise;
uniform float uRadial;
uniform float uRipple;
uniform float uRippleFreq;
uniform float uPhaseMid;
uniform float uPhaseHigh;
varying float vT;
varying float vSide;
varying float vH;
varying vec3 vN;
varying vec3 vV;

const float MID_AMP = 0.62;
const float HI_AMP = 0.34;
const float IDLE_AMP = 0.05;
const float RAD_AMP = 0.085;

float hgt(float th, float t) {
  float wIn = 1.0 - smoothstep(0.0, 0.75, t);
  float wOut = smoothstep(0.3, 1.0, t);
  float mid = sin(th * 3.0 + uPhaseMid + t * 5.0) * 0.55 + sin(th * 5.0 - uPhaseMid * 0.7 + t * 9.0) * 0.35;
  float hi = sin(th * 9.0 - uPhaseHigh + t * uRippleFreq) * 0.6 + sin(th * 14.0 + uPhaseHigh * 1.3 - t * uRippleFreq * 0.6) * 0.4;
  float idle = sin(th * 2.0 + uPhaseMid * 0.5 + t * 3.0);
  return MID_AMP * uRise * (0.25 + wIn) * mid + HI_AMP * uRipple * wOut * hi + IDLE_AMP * idle;
}

vec3 ribbonAt(float th, float r, float t) {
  float rr = r + uRadial * RAD_AMP * sin(th * 4.0 + uPhaseMid * 1.3 + t * 5.0);
  return vec3(cos(th) * rr, hgt(th, t), sin(th) * rr);
}

void main() {
  float th = position.x;
  float side = position.y;
  float t = position.z / (RING_N - 1.0);
  float r0 = mix(R_IN, R_OUT, pow(t, 1.1));
  float r = r0 + side * HALF_W * mix(0.8, 1.25, t);
  vec3 p = ribbonAt(th, r, t);
  // The surface normal from the displaced neighbours, so the sheen follows the waves.
  vec3 dTh = ribbonAt(th + 0.012, r, t) - ribbonAt(th - 0.012, r, t);
  vec3 dR = ribbonAt(th, r + 0.02, t) - ribbonAt(th, r - 0.02, t);
  vec3 n = normalize(cross(dTh, dR));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vT = t;
  vSide = side;
  vH = p.y;
  vN = normalize(normalMatrix * n);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const RIBBON_FRAG = /* glsl */ `
precision highp float;
uniform float uExposure;
uniform float uGlow;
uniform float uMirror;
varying float vT;
varying float vSide;
varying float vH;
varying vec3 vN;
varying vec3 vV;

vec3 ribbonRamp(float t, float warm) {
  vec3 amber = vec3(1.0, 0.60, 0.20);
  vec3 cyan = vec3(0.22, 0.58, 1.0);
  vec3 violet = vec3(0.52, 0.40, 0.98);
  vec3 c = mix(amber, cyan, smoothstep(0.0, 0.5, t));
  c = mix(c, violet, smoothstep(0.55, 1.0, t));
  return mix(c, amber, warm * 0.35 * (1.0 - smoothstep(0.0, 0.5, t)));
}

void main() {
  float edge = smoothstep(0.55, 1.0, abs(vSide));
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  float crest = clamp(vH * 1.4 + 0.5, 0.0, 1.0);
  float fade = 1.0 - 0.55 * smoothstep(0.7, 1.0, vT);
  float body = 0.10 + 0.32 * fres + 0.38 * crest;
  float a = (body + edge * (0.50 + 0.65 * crest)) * fade;
  vec3 col = ribbonRamp(vT, uGlow) * a * (0.30 + 0.95 * uExposure);
  gl_FragColor = vec4(col * uMirror, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Light tracks. position = (angle, side -1..1, radius). A thin gold line with a soft glow, a slow travelling highlight,
// and a flash on a detected onset.
// ---------------------------------------------------------------------------------------------------------------------
export const TRACK_VERT = /* glsl */ `
uniform float uBeadPhase;
varying float vSide;
varying float vTheta;
varying float vR;
void main() {
  float th = position.x;
  float r = position.z + position.y * TRACK_HALF;
  vSide = position.y;
  vTheta = th;
  vR = position.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(cos(th) * r, TRACK_Y, sin(th) * r, 1.0);
}
`;

export const TRACK_FRAG = /* glsl */ `
precision highp float;
uniform float uExposure;
uniform float uFlash;
uniform float uBeadPhase;
uniform float uMirror;
varying float vSide;
varying float vTheta;
varying float vR;
void main() {
  float d = abs(vSide);
  float line = smoothstep(0.10, 0.0, d);
  float glow = exp(-d * d * 9.0);
  float head = pow(0.5 + 0.5 * cos(vTheta - uBeadPhase * 0.8 - vR * 1.7), 6.0);
  vec3 amber = vec3(1.0, 0.62, 0.18);
  vec3 gold = vec3(1.0, 0.82, 0.42);
  vec3 c = mix(amber, gold, line) * (line * 1.1 + glow * 0.28);
  float lvl = 0.30 + 0.45 * uExposure + 0.4 * head + 0.8 * uFlash;
  gl_FragColor = vec4(c * lvl * uMirror, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Node beads (InstancedMesh). aOrbit = (radius, start angle, signed speed multiplier, size). Highs set the orbit and
// pulse speed (accumulated on the CPU); an onset flash swells and brightens them.
// ---------------------------------------------------------------------------------------------------------------------
export const BEAD_VERT = /* glsl */ `
attribute vec4 aOrbit;
uniform float uBeadPhase;
uniform float uBeadPulse;
uniform float uBeadAmt;
uniform float uFlash;
varying vec3 vN;
varying vec3 vV;
void main() {
  float ang = aOrbit.y + uBeadPhase * aOrbit.z;
  float pulse = 0.5 + 0.5 * sin(uBeadPulse * abs(aOrbit.z) + aOrbit.y * 5.0);
  float s = aOrbit.w * (1.0 + 0.35 * pulse * uBeadAmt + 0.5 * uFlash);
  vec3 centre = vec3(cos(ang) * aOrbit.x, TRACK_Y + 0.07, sin(ang) * aOrbit.x);
  vec4 mv = modelViewMatrix * vec4(centre + position * s, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const BEAD_FRAG = /* glsl */ `
precision highp float;
uniform float uExposure;
uniform float uFlash;
uniform float uMirror;
varying vec3 vN;
varying vec3 vV;
void main() {
  float rim = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.0);
  vec3 c = mix(vec3(0.95, 0.50, 0.12), vec3(1.0, 0.74, 0.34), rim);
  c *= 0.38 + 0.42 * uExposure + 0.75 * uFlash;
  gl_FragColor = vec4(c * uMirror, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Spectrum-style bars (InstancedMesh). aBar = (angle, radius, seed, kind). kind 0 is amber and follows the mids, kind 1 is
// cyan and follows the highs. The contract has three bands, not a spectrum: each bar's height is its band's level times a
// fixed, travelling per-bar pattern, so the bars look like a spectrum without claiming to be one.
// ---------------------------------------------------------------------------------------------------------------------
export const BAR_VERT = /* glsl */ `
attribute vec4 aBar;
uniform float uBarMid;
uniform float uBarHigh;
uniform float uBarPhase;
uniform float uFlash;
varying float vY;
varying float vKind;
void main() {
  float th = aBar.x;
  float seed = aBar.z;
  float kind = aBar.w;
  float band = kind < 0.5 ? uBarMid : uBarHigh;
  float emph = kind < 0.5 ? 0.35 + 0.65 * pow(abs(cos(th)), 1.5) : 0.35 + 0.65 * pow(abs(sin(th)), 1.5);
  float wave = 0.5 + 0.5 * sin(th * 7.0 + seed * 6.2831853 + uBarPhase * (kind < 0.5 ? 1.0 : 1.7));
  float h = 0.04 + band * emph * (0.25 + 0.75 * wave * (0.5 + 0.5 * seed)) * 1.05;
  vec3 local = position;
  local.y *= h;
  vY = position.y;
  vKind = kind;
  vec3 world = vec3(cos(th) * aBar.y, TRACK_Y, sin(th) * aBar.y) + local;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`;

export const BAR_FRAG = /* glsl */ `
precision highp float;
uniform float uExposure;
uniform float uFlash;
uniform float uMirror;
varying float vY;
varying float vKind;
void main() {
  vec3 base = vKind < 0.5 ? vec3(0.95, 0.46, 0.10) : vec3(0.16, 0.62, 0.95);
  vec3 top = vKind < 0.5 ? vec3(1.0, 0.72, 0.32) : vec3(0.50, 0.84, 1.0);
  vec3 c = mix(base, top, vY) * (0.30 + 0.45 * uExposure + 0.45 * uFlash);
  gl_FragColor = vec4(c * uMirror * (0.40 + 0.60 * vY), 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Heart: the plasma core and the energy filament lattice. Opaque, so the glass orb's transmission refracts them.
// ---------------------------------------------------------------------------------------------------------------------
export const BODY_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vObj;
void main() {
  vObj = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const PLASMA_FRAG = /* glsl */ `
precision highp float;
uniform float uGlow;
uniform float uFlow;
varying vec3 vN;
varying vec3 vV;
varying vec3 vObj;
${NOISE}
void main() {
  float fres = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.0);
  float n = vnoise(vObj.xy * 3.0 + uFlow * 0.6) * 0.6 + vnoise(vObj.yz * 6.0 - uFlow * 0.9) * 0.4;
  float hot = 1.0 - fres;
  vec3 deep = vec3(0.75, 0.18, 0.05);
  vec3 amber = vec3(1.0, 0.55, 0.12);
  vec3 white = vec3(1.0, 0.92, 0.75);
  vec3 c = mix(deep, amber, smoothstep(0.1, 0.7, n * hot + 0.25 * hot));
  c = mix(c, white, pow(hot, 4.0) * (0.35 + 0.4 * n));
  c *= 0.30 + 0.80 * uGlow;
  c += vec3(1.0, 0.5, 0.15) * fres * 0.5 * uGlow;
  gl_FragColor = vec4(c, 1.0);
}
`;

export const FILAMENT_VERT = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const FILAMENT_FRAG = /* glsl */ `
precision highp float;
uniform float uGlow;
uniform float uMix;
void main() {
  vec3 c = mix(vec3(1.0, 0.66, 0.24), vec3(0.62, 0.52, 1.0), uMix);
  gl_FragColor = vec4(c * (0.7 + 0.9 * uGlow), 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Floor: a dark, glossy disc. It is drawn after a mirrored copy of the scene's light (see scene.ts) and covers it with a
// translucent dark surface, so the copy reads as a reflection. A pool of warm and cool light sits under the heart.
// ---------------------------------------------------------------------------------------------------------------------
export const FLOOR_VERT = /* glsl */ `
varying vec2 vXZ;
void main() {
  vXZ = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const FLOOR_FRAG = /* glsl */ `
precision highp float;
uniform float uGlow;
uniform float uExposure;
varying vec2 vXZ;
void main() {
  float r = length(vXZ);
  vec3 base = vec3(0.0078, 0.0118, 0.039);
  float inner = exp(-r * r * 0.30);
  float pool = exp(-r * r * 0.040);
  vec3 col = base + vec3(1.0, 0.55, 0.18) * inner * uGlow * 0.30 + vec3(0.20, 0.40, 1.0) * pool * (0.05 + 0.14 * uExposure);
  float a = mix(0.80, 1.0, smoothstep(10.0, 24.0, r));
  gl_FragColor = vec4(col, a);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Halo: a camera-facing glow over the heart, the stand-in for bloom. The louder the music, the lower its threshold and the
// more of it shows. Plane geometry is 2 x 2 and scaled by the mesh.
// ---------------------------------------------------------------------------------------------------------------------
export const HALO_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const HALO_FRAG = /* glsl */ `
precision highp float;
uniform float uGlow;
uniform float uBloom;
uniform float uAtmos;
varying vec2 vP;
void main() {
  float d = length(vP);
  float edge = smoothstep(1.0, 0.7, d);
  float threshold = 0.75 - 0.5 * uBloom;
  float gate = smoothstep(threshold - 0.25, threshold + 0.25, uGlow);
  float core = exp(-d * d * 18.0);
  float mid = exp(-d * d * 4.0);
  float wide = exp(-d * d * 1.2);
  vec3 col = vec3(1.0, 0.62, 0.22) * core * (0.12 + 0.55 * gate) * (0.4 + 0.7 * uBloom);
  col += vec3(1.0, 0.55, 0.20) * mid * 0.07 * gate;
  col += vec3(0.25, 0.45, 1.0) * wide * 0.09 * (0.3 + uAtmos);
  gl_FragColor = vec4(col * edge, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Particles: a suspended field that drifts upward and wraps. aSeed = (angle, radius, height, random). A few are large,
// soft bokeh discs. An onset burst pushes the field outward and brightens it, then it settles.
// ---------------------------------------------------------------------------------------------------------------------
export const PARTICLE_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uFlow;
uniform float uBurst;
uniform float uScale;
uniform float uAtmos;
uniform float uTwinkle;
varying float vA;
varying vec3 vCol;
varying float vBokeh;
void main() {
  float ang = aSeed.x * 6.2831853 + uFlow * 0.02 * (0.5 + aSeed.w);
  float rad = P_R0 + aSeed.y * (P_R1 - P_R0);
  float h01 = fract(aSeed.z + uFlow * 0.012 * (0.3 + aSeed.w));
  float y = P_Y0 + h01 * P_H;
  float push = uBurst * (0.6 + 1.2 * aSeed.w);
  vec3 p = vec3(cos(ang) * (rad + push), y + uBurst * 0.4 * aSeed.y, sin(ang) * (rad + push));
  p.x += sin(uFlow * 0.7 + aSeed.z * 20.0) * 0.12;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float bokeh = step(0.965, aSeed.w);
  float size = mix(1.2 + 2.2 * aSeed.w, 16.0 + 18.0 * aSeed.y, bokeh);
  gl_PointSize = size * uScale * (14.0 / max(-mv.z, 1.0)) * (1.0 + 0.8 * uBurst);
  gl_Position = projectionMatrix * mv;
  float fade = smoothstep(0.0, 0.1, h01) * smoothstep(1.0, 0.85, h01);
  float tw = 0.65 + 0.35 * sin(uFlow * (1.5 + 3.0 * aSeed.w) * (1.0 + uTwinkle) + aSeed.z * 40.0);
  vA = fade * tw * mix(0.8, 0.22, bokeh) * (0.35 + 0.9 * uAtmos) + uBurst * 0.5 * fade;
  vCol = fract(aSeed.x * 7.31) < 0.4 ? vec3(1.0, 0.66, 0.25) : vec3(0.45, 0.70, 1.0);
  vBokeh = bokeh;
}
`;

export const PARTICLE_FRAG = /* glsl */ `
precision highp float;
varying float vA;
varying vec3 vCol;
varying float vBokeh;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float soft = exp(-d * d * 4.0);
  float disc = smoothstep(1.0, 0.85, d) * (0.5 + 0.5 * smoothstep(0.5, 0.9, d));
  float a = mix(soft, disc, vBokeh);
  gl_FragColor = vec4(vCol * a * vA, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Glass rim: an additive fresnel shell just outside the orb. The transmission pass shows the heart through the glass, but a
// dark scene gives the glass nothing to reflect, so this supplies the cool edge light and the warm underside of the reference.
// ---------------------------------------------------------------------------------------------------------------------
export const RIM_FRAG = /* glsl */ `
precision highp float;
uniform float uGlow;
uniform float uExposure;
varying vec3 vN;
varying vec3 vV;
varying vec3 vObj;
void main() {
  float f = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 3.0);
  vec3 c = mix(vec3(0.45, 0.70, 1.0), vec3(1.0, 0.60, 0.25), smoothstep(0.2, -0.8, vObj.y));
  gl_FragColor = vec4(c * f * (0.30 + 0.35 * uExposure + 0.35 * uGlow), 1.0);
}
`;

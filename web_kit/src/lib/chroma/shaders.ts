/**
 * GLSL for Chroma Field. Two point-sprite layers share one vertex shader (`uLayer`: 0 ink, 1 dust). Every particle is a home
 * position (static attribute) displaced on the GPU by a divergence-free flow whose phase the animator accumulates, scaled by the
 * bass (expansion, brief compression on a bass hit), pushed by recent shockwave bursts, and coloured from a deep cosmic palette by
 * its register, its place in the flow and the high band's dispersion. Nothing is uploaded per frame except uniforms. No textures,
 * no render targets, no post-processing, no mesh, no lines. Colours are written raw (a ShaderMaterial does no colour-space
 * conversion). Additive blending: overlapping sprites sum, so density reads as brightness.
 *
 * The potential, the curl and the burst shell mirror `potential`, `flowAt` and `burstDisplacement` in field.ts.
 * Defines supplied by scene.ts: BURST_SLOTS, BURST_LIFE, BURST_SPEED, BURST_W, BURST_AMP, CURL_EPS, FLOW_REST, FLOW_MID, FLOW_GAIN,
 * INK_PX, DUST_PX, REST_VIS.
 */

export const CHROMA_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uFlow;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uDisp;
uniform float uHit;
uniform float uHuePhase;
uniform float uShimmer;
uniform float uShimmerOn;
uniform float uExposure;
uniform float uScale;
uniform float uLayer;
uniform float uBurstOn;
uniform float uBurstA[BURST_SLOTS];
uniform vec4 uBurstO[BURST_SLOTS];
varying vec3 vCol;
varying float vA;

const vec3 INDIGO = vec3(0.26, 0.22, 1.0);
const vec3 TEAL = vec3(0.0, 0.8, 0.85);
const vec3 MAGENTA = vec3(0.86, 0.12, 0.74);
const vec3 PINK = vec3(1.0, 0.32, 0.6);

vec3 pot(vec3 q) {
  return vec3(
    sin(q.y * 1.31 + uFlow.z * 0.7) * cos(q.z * 0.93 + uFlow.x * 0.5) + 0.5 * sin(q.y * 2.7 - q.z * 2.1 + uFlow.y),
    sin(q.z * 1.17 + uFlow.x * 0.6) * cos(q.x * 1.03 + uFlow.y * 0.4) + 0.5 * sin(q.z * 2.3 - q.x * 2.9 + uFlow.z),
    sin(q.x * 1.23 + uFlow.y * 0.8) * cos(q.y * 0.87 + uFlow.z * 0.3) + 0.5 * sin(q.x * 2.5 - q.y * 2.2 + uFlow.x)
  );
}

vec3 curl(vec3 q) {
  vec3 ex = vec3(CURL_EPS, 0.0, 0.0), ey = vec3(0.0, CURL_EPS, 0.0), ez = vec3(0.0, 0.0, CURL_EPS);
  vec3 dx = (pot(q + ex) - pot(q - ex)) / (2.0 * CURL_EPS);
  vec3 dy = (pot(q + ey) - pot(q - ey)) / (2.0 * CURL_EPS);
  vec3 dz = (pot(q + ez) - pot(q - ez)) / (2.0 * CURL_EPS);
  return vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);
}

vec3 pal(float t) {
  t = fract(t) * 4.0;
  if (t < 1.0) return mix(INDIGO, TEAL, t);
  if (t < 2.0) return mix(TEAL, MAGENTA, t - 1.0);
  if (t < 3.0) return mix(MAGENTA, PINK, t - 2.0);
  return mix(PINK, INDIGO, t - 3.0);
}

void main() {
  float reg = aSeed.z;
  vec3 h = position;
  float amp = FLOW_REST + FLOW_MID * uMid;
  vec3 q = h * (uLayer < 0.5 ? 0.8 : 1.0);
  vec3 p = h + curl(q) * amp * FLOW_GAIN;

  // Bass: the whole volume swells with the bass and compresses briefly on a bass hit.
  p *= 1.0 + 0.22 * uBass - 0.28 * uHit;

  // Onsets: each recent burst is a thin shell expanding from its own origin, pushing particles outward and lighting them.
  float lit = 0.0;
  for (int i = 0; i < BURST_SLOTS; i++) {
    float ta = uBurstA[i];
    if (ta >= 0.0) {
      vec3 d = p - uBurstO[i].xyz;
      float r = length(d);
      float dr = r - ta * BURST_SPEED;
      float env = exp(-(dr * dr) / (BURST_W * BURST_W));
      float end = 1.0 - smoothstep(0.0, 1.0, clamp((ta / BURST_LIFE - 0.6) / 0.4, 0.0, 1.0));
      float push = uBurstO[i].w * BURST_AMP * env * exp(-ta / (BURST_LIFE * 0.5)) * end * uBurstOn;
      p += (d / max(r, 0.001)) * push;
      lit += env * end * uBurstO[i].w * uBurstOn;
    }
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.5);

  // Each register is its own population: its visible fraction and size follow its own band.
  float level = reg < 0.5 ? uBass : (reg < 1.5 ? uMid : uHigh);
  float vis = REST_VIS + (1.0 - REST_VIS) * level;
  float show = smoothstep(aSeed.x - 0.12, aSeed.x, vis);
  // Twinkle has zero mean (it glints, it does not dim): brightness swings around 1 by up to 80% of the high band.
  float tw = 1.0 + uShimmerOn * uHigh * 0.8 * sin(uShimmer * (3.0 + aSeed.y * 5.0) + aSeed.x * 40.0);

  // The high register is the sparks: slightly larger and brighter than the rest of the dust.
  float spark = reg > 1.5 ? 1.0 : 0.0;
  float px = aSeed.w * (uLayer < 0.5 ? INK_PX : DUST_PX) * (reg < 0.5 ? 1.0 + 0.5 * uBass : 1.0) * (1.0 + 0.3 * spark);
  gl_PointSize = clamp(px * uScale * 11.0 / depth, 1.0, 220.0);

  // Colour: each register owns a band of the palette and the position in the flow picks where in it (so neighbouring masses differ,
  // as the ink does), drifting with the loudness. The high band disperses the hue: fully for the high register, half for the others.
  float sp = 0.5 + 0.5 * sin(dot(h, vec3(0.28, 0.35, 0.22)) + uHuePhase * 6.2832 + aSeed.y * 0.6);
  float t = reg < 0.5 ? 0.58 + 0.42 * sp : (reg < 1.5 ? 0.02 + 0.30 * sp : 0.45 + 0.32 * sp);
  t += uDisp * (aSeed.y - 0.5) * (reg > 1.5 ? 1.4 : 0.9);
  vCol = mix(pal(t), vec3(1.0), clamp(0.35 * lit, 0.0, 0.6));
  float cue = 1.0 - 0.45 * smoothstep(8.0, 17.0, depth);
  vA = show * tw * uExposure * (uLayer < 0.5 ? 0.07 : 0.5) * (1.0 + 0.7 * spark) * cue * (1.0 + 1.4 * lit);
}
`;

export const CHROMA_FRAG = /* glsl */ `
precision highp float;
uniform float uLayer;
varying vec3 vCol;
varying float vA;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float g = exp(-r2 * (uLayer < 0.5 ? 3.2 : 4.5));
  gl_FragColor = vec4(vCol, vA * g);
}
`;

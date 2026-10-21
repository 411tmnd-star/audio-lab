import * as THREE from "three";

import { burstAge, type ChromaAnim } from "./animator";
import { BOUNDS, BURST_LIFE_S, BURST_SLOTS, BURST_SPEED, BURST_WIDTH, BURST_AMP, COUNTS, CURL_EPS, FLOW_MID, FLOW_REST, buildCloud, cameraAt, type Quality } from "./field";
import type { ChromaParams } from "./params";
import { CHROMA_FRAG, CHROMA_VERT } from "./shaders";

/**
 * The Chroma Field scene: a volume of drifting particle density seen through a fixed window while the camera dollies slowly
 * through it. Two point-sprite layers, no mesh, no line, no lights, no post-processing: the medium carries the identity.
 *
 * Built once in the constructor (two static geometries of home positions and per-particle seeds, two ShaderMaterials sharing one
 * set of uniform objects). `update` writes uniforms and the camera pose; a frame allocates nothing. `dispose` releases every
 * geometry and material; `releaseGpu` does the same for a lost context while keeping the scene graph.
 * Sizes, counts and rates are PROPOSED values for visual review.
 */

/** Module-level counts, so lifecycle checks can confirm every scene created was disposed. */
export const sceneStats = { created: 0, disposed: 0 };

export const FLOW_GAIN = 0.3;
/** Fraction of each register's particles visible in silence. */
export const REST_VIS = 0.18;
/** Sprite sizes in pixels at the reference depth (11) and a 720 px high canvas. */
export const INK_PX = 62;
export const DUST_PX = 2.6;
const FOV = 42;
const BASE_DISTANCE_SCALE = 1;

const f = (n: number) => n.toFixed(5);

export interface ChromaOptions {
  /** `lite` draws about 40% of the particles, for slower GPUs. Chosen by the caller; there is no automatic switch. */
  quality?: Quality;
}

type U = { value: number | THREE.Vector3 | Float32Array | THREE.Vector4[] };

export class ChromaScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 80);
  readonly quality: Quality;
  readonly ink: THREE.Points;
  readonly dust: THREE.Points;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly u: Record<string, U> = {};
  private readonly burstA = new Float32Array(BURST_SLOTS);
  private readonly burstO = Array.from({ length: BURST_SLOTS }, () => new THREE.Vector4());
  private readonly pos: [number, number, number] = [0, 0, 0];
  private readonly look: [number, number, number] = [0, 0, 0];
  private distanceScale = BASE_DISTANCE_SCALE;
  private lastClock = 0;
  private lastReduced = false;
  private disposed = false;

  constructor(opts: ChromaOptions = {}) {
    this.quality = opts.quality ?? "full";
    const n = COUNTS[this.quality];
    const num = (v: number): U => ({ value: v });
    for (const k of ["uBass", "uMid", "uHigh", "uDisp", "uHit", "uHuePhase", "uShimmer", "uShimmerOn", "uScale", "uBurstOn"]) this.u[k] = num(0);
    this.u.uExposure = num(0.55);
    this.u.uShimmerOn = num(1);
    this.u.uBurstOn = num(1);
    this.u.uScale = num(1);
    this.u.uFlow = { value: new THREE.Vector3() };
    this.u.uBurstA = { value: this.burstA.fill(-1) };
    this.u.uBurstO = { value: this.burstO };

    const defines = {
      BURST_SLOTS, BURST_LIFE: f(BURST_LIFE_S), BURST_SPEED: f(BURST_SPEED), BURST_W: f(BURST_WIDTH), BURST_AMP: f(BURST_AMP), CURL_EPS: f(CURL_EPS),
      FLOW_REST: f(FLOW_REST), FLOW_MID: f(FLOW_MID), FLOW_GAIN: f(FLOW_GAIN), INK_PX: f(INK_PX), DUST_PX: f(DUST_PX), REST_VIS: f(REST_VIS),
    };
    const layer = (cloud: ReturnType<typeof buildCloud>, id: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(cloud.home, 3));
      g.setAttribute("aSeed", new THREE.BufferAttribute(cloud.seed, 4));
      this.geometries.push(g);
      const m = new THREE.ShaderMaterial({
        vertexShader: CHROMA_VERT, fragmentShader: CHROMA_FRAG, defines,
        uniforms: { ...this.u, uLayer: { value: id } } as unknown as Record<string, THREE.IUniform>,
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      });
      this.materials.push(m);
      const pts = new THREE.Points(g, m);
      pts.frustumCulled = false; // the shader moves every particle; the home bounds are not the drawn bounds
      pts.renderOrder = id;
      this.scene.add(pts);
      return pts;
    };
    this.ink = layer(buildCloud(n.ink, 0x1c0a11, true), 0);
    this.dust = layer(buildCloud(n.dust, 0x5eed42, false), 1);
    this.applyCamera(0, false);
    sceneStats.created++;
  }

  get resourceCounts() {
    return { geometries: this.geometries.length, materials: this.materials.length };
  }

  get uniforms(): Readonly<Record<string, U>> {
    return this.u;
  }

  get particleCount(): number {
    return this.ink.geometry.getAttribute("position").count + this.dust.geometry.getAttribute("position").count;
  }

  /** Call when the canvas size or pixel ratio changes. Sprites scale with the canvas height; a narrow canvas moves the camera back to keep the width. */
  setViewport(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    if (cssWidth < 1 || cssHeight < 1) return;
    const aspect = cssWidth / cssHeight;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const tanHalf = Math.tan((FOV * Math.PI) / 360);
    this.distanceScale = Math.max(BASE_DISTANCE_SCALE, (BOUNDS.x * 0.85) / (tanHalf * aspect * 12.5));
    (this.u.uScale as { value: number }).value = pixelRatio * (cssHeight / 720) * Math.min(1, aspect / 1.2 + 0.2);
    this.applyCamera(this.lastClock, this.lastReduced);
  }

  /** Camera pose from the visual clock: a pure function, so the same clock always gives the same view. Reduced motion holds it still. */
  private applyCamera(clock: number, reduced: boolean): void {
    this.lastClock = clock;
    this.lastReduced = reduced;
    cameraAt(reduced ? 0 : clock, this.pos, this.look);
    this.camera.position.set(this.pos[0], this.pos[1], this.pos[2] * this.distanceScale);
    this.camera.lookAt(this.look[0], this.look[1], this.look[2]);
    this.camera.updateMatrixWorld();
  }

  /** Writes the animation state into uniforms and the camera. No allocation. */
  update(a: ChromaAnim, p: ChromaParams): void {
    if (this.disposed) return;
    const u = this.u as Record<string, { value: number }>;
    (this.u.uFlow.value as THREE.Vector3).set(a.flow[0], a.flow[1], a.flow[2]);
    u.uBass.value = a.bass;
    u.uMid.value = a.mid;
    u.uHigh.value = a.high;
    u.uDisp.value = a.high;
    u.uHit.value = a.hit;
    u.uHuePhase.value = a.huePhase;
    u.uShimmer.value = a.shimmer;
    u.uShimmerOn.value = p.reduced ? 0 : 1;
    u.uBurstOn.value = p.reduced ? 0 : 1;
    u.uExposure.value = a.exposure;
    for (let k = 0; k < BURST_SLOTS; k++) {
      this.burstA[k] = burstAge(a, k);
      this.burstO[k].set(a.burstO[k * 3], a.burstO[k * 3 + 1], a.burstO[k * 3 + 2], a.burstS[k]);
    }
    this.applyCamera(a.clock, p.reduced);
  }

  /** Call when the WebGL context is lost: release the renderer's records, keep the scene graph; the next draw re-uploads. */
  releaseGpu(): void {
    if (this.disposed) return;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }

  /** Releases every geometry and material. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.scene.clear();
    sceneStats.disposed++;
  }
}

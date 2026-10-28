import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { AOSettings, BuiltRoom } from './types';
import { bakeEnvironment } from './lighting';

const DEFAULT_AO: Required<AOSettings> = { radius: 0.35, distanceExponent: 1.5, thickness: 1, scale: 1.1, samples: 16, intensity: 0.85, halfRes: false };

// Every built-in material ends in opaque_fragment: make its output NaN/Inf-safe. Near-zero
// (clearcoat) roughness under the strong spots can overflow the half-float target, and one
// NaN pixel would be spread over the whole frame by GTAO's denoise and the bloom mip chain.
if (!THREE.ShaderChunk.opaque_fragment.includes('safe output')) {
  THREE.ShaderChunk.opaque_fragment += `
// safe output
gl_FragColor.rgb = mix( clamp( gl_FragColor.rgb, 0.0, 512.0 ), vec3( 0.0 ), vec3( isnan( gl_FragColor.rgb ) ) );
`;
}

/**
 * The scene render + GTAO in one pass. The scene renders once into a 4× MSAA half-float target
 * with a depth texture; GTAO runs on that depth (normals reconstructed from it) instead of
 * re-rendering the whole scene into its own normal/depth G-buffer every frame, which halves the
 * per-frame draw calls and vertex work. Transparent objects (glass, mesh chair backs, clear bins)
 * are drawn after the AO blend, over the opaque depth, so they never pick up AO ghost outlines of
 * what's behind them.
 */
class SceneAOPass extends Pass {
  target: THREE.WebGLRenderTarget;
  /** non-MSAA target sharing the opaque depth: AO'd color + the transparent objects */
  post: THREE.WebGLRenderTarget;
  aoEnabled = true;
  private copy: FullScreenQuad;
  private copyMat: THREE.ShaderMaterial;
  private transparent: THREE.Object3D[] = [];
  private opaque: THREE.Object3D[] = [];
  draw?: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void;
  private drawScene(renderer: THREE.WebGLRenderer) {
    if (this.draw) this.draw(renderer, this.camera);
    else renderer.render(this.scene, this.camera);
  }
  constructor(private scene: THREE.Scene, private camera: THREE.Camera, public ao: GTAOPass, w: number, h: number) {
    super();
    const depth = new THREE.DepthTexture(w, h);
    this.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4, depthTexture: depth });
    this.post = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: depth });
    ao.setGBuffer(depth);
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }',
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.copy = new FullScreenQuad(this.copyMat);
  }
  setSize(w: number, h: number) {
    this.target.setSize(w, h);
    this.post.setSize(w, h);
    this.ao.setSize(w, h);
  }
  /** Refresh visible lists each rendered frame so cutaway/source changes take effect immediately. */
  private sort() {
    this.transparent.length = 0;
    this.opaque.length = 0;
    this.scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine) return;
      const mat = m.material;
      const t = Array.isArray(mat) ? mat.some((x) => x.transparent) : mat?.transparent;
      (t ? this.transparent : this.opaque).push(o);
    });
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget) {
    this.sort();
    const hide = (list: THREE.Object3D[]) => list.forEach((o) => (o.visible = false));
    const show = (list: THREE.Object3D[]) => list.forEach((o) => (o.visible = true));
    // 1. opaque + alpha-tested
    hide(this.transparent);
    renderer.setRenderTarget(this.target);
    renderer.clear();
    this.drawScene(renderer);
    show(this.transparent);
    // 2. AO on the opaque depth → post (scene × AO); without AO just copy
    if (this.aoEnabled) this.ao.render(renderer, this.post, this.target, 0, false);
    else {
      this.copyMat.uniforms.tDiffuse.value = this.target.texture;
      renderer.setRenderTarget(this.post);
      this.copy.render(renderer);
    }
    // 3. transparent objects over it, depth-tested against the opaque depth
    if (this.transparent.length) {
      hide(this.opaque);
      const bg = this.scene.background;
      this.scene.background = null;
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(this.post);
      this.drawScene(renderer);
      renderer.autoClear = auto;
      this.scene.background = bg;
      show(this.opaque);
    }
    // 4. hand it to the rest of the chain
    this.copyMat.uniforms.tDiffuse.value = this.post.texture;
    renderer.setRenderTarget(writeBuffer);
    this.copy.render(renderer);
  }
  dispose() {
    this.target.dispose();
    this.post.dispose();
    this.ao.dispose();
    this.copy.dispose();
    this.copyMat.dispose();
  }
}

export function createPipeline(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pr);

  const ao = new GTAOPass(scene, camera, size.x, size.y);
  let aoScale = 1;
  // optionally run the AO buffers at half resolution (the blend upsamples them)
  const aoSetSize = ao.setSize.bind(ao);
  ao.setSize = (w: number, h: number) => aoSetSize(Math.max(1, Math.round(w * aoScale)), Math.max(1, Math.round(h * aoScale)));
  const scenePass = new SceneAOPass(scene, camera, ao, Math.round(size.x * pr), Math.round(size.y * pr));
  const setAO = (s: AOSettings = {}) => {
    const o = { ...DEFAULT_AO, ...s };
    ao.updateGtaoMaterial({ radius: o.radius, distanceExponent: o.distanceExponent, thickness: o.thickness, scale: o.scale, samples: o.samples });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    ao.blendIntensity = o.intensity;
    scenePass.aoEnabled = o.intensity > 0;
    const scale = o.halfRes ? 0.5 : 1;
    if (scale !== aoScale) {
      aoScale = scale;
      const s2 = renderer.getDrawingBufferSize(new THREE.Vector2());
      ao.setSize(s2.x, s2.y);
    }
  };
  setAO();
  if (new URLSearchParams(globalThis.location?.search ?? '').has('legacyao')) {
    // A/B only: the old chain (GTAOPass re-renders the scene for its own normal/depth buffer)
    const legacy = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    composer.reset(legacy);
    composer.addPass(new RenderPass(scene, camera));
    const ao2 = new GTAOPass(scene, camera, size.x, size.y);
    composer.addPass(ao2);
  } else composer.addPass(scenePass);
  // glow for neon, LED strips, softbox faces; off unless a room asks for it (HDR target: only
  // pixels brighter than the threshold bloom)
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.5, 0.6, 1.2);
  // the mip chain runs at half the frame's resolution (a quarter of the pixels): at full size it
  // cost ~23 ms/frame in the HD office on an M1 Max, and a blurred glow looks the same either way
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w: number, h: number) => bloomSetSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
  bloom.setSize(size.x * pr, size.y * pr);
  bloom.enabled = false;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let enabled = true;
  return {
    composer,
    render() {
      if (enabled) composer.render();
      else if (scenePass.draw) scenePass.draw(renderer, camera);
      else renderer.render(scene, camera);
    },
    setSceneRenderer(draw?: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void) { scenePass.draw = draw; },
    setSize(w: number, h: number) {
      composer.setSize(w, h);
    },
    setPixelRatio(ratio: number) {
      composer.setPixelRatio(ratio);
    },
    /** null = off; otherwise UnrealBloom strength / radius / threshold (scene-linear luminance) */
    setBloom(b: { strength: number; radius: number; threshold: number } | null | undefined) {
      bloom.enabled = !!b;
      if (b) Object.assign(bloom, b);
    },
    /** GTAO tuning (missing fields → defaults) */
    setAO,
    set ao(on: boolean) {
      enabled = on;
    },
    get ao() {
      return enabled;
    },
  };
}

export type Pipeline = ReturnType<typeof createPipeline>;

/**
 * Apply a room's render settings (exposure, tone mapping, shadow filtering, AO, bloom) and
 * bake its environment. Call after the room's group + lights are in the scene.
 */
function configureRoomRendering(renderer: THREE.WebGLRenderer, scene: THREE.Scene, room: BuiltRoom, pipeline?: Pipeline, opts: { bloom?: boolean } = {}) {
  const r = room.render ?? {};
  renderer.toneMapping = r.toneMapping ?? THREE.AgXToneMapping;
  renderer.toneMappingExposure = room.exposure ?? 1.1;
  const shadowType = r.shadowType ?? THREE.PCFShadowMap;
  if (renderer.shadowMap.type !== shadowType) {
    renderer.shadowMap.type = shadowType;
    // programs are keyed on the shadow type; force a recompile of everything already built
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true));
    });
  }
  pipeline?.setBloom(opts.bloom === false ? null : room.bloom);
  pipeline?.setAO(r.ao);
}

/** Compile the physical materials before cube capture so driver compilation can yield. */
export async function precompileRoomRendering(renderer: THREE.WebGLRenderer, scene: THREE.Scene, room: BuiltRoom, camera: THREE.Camera) {
  configureRoomRendering(renderer, scene, room);
  const previous = renderer.getRenderTarget();
  const target = new THREE.WebGLCubeRenderTarget(16, { type: THREE.HalfFloatType });
  try {
    renderer.setRenderTarget(target);
    await renderer.compileAsync(scene, camera);
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
  }
}

export function applyRoomRendering(renderer: THREE.WebGLRenderer, scene: THREE.Scene, room: BuiltRoom, pipeline?: Pipeline, opts: { bloom?: boolean } = {}) {
  configureRoomRendering(renderer, scene, room, pipeline, opts);
  const r = room.render ?? {};
  const e = room.environment;
  // Strongly colored lights (RGB LEDs, the blue softbox) only light their surroundings; baked into
  // the one global environment map they'd tint the whole room, so they're off during the capture.
  const off: [THREE.Light, number][] = [];
  if (r.envNeutral) {
    const hsl = { h: 0, s: 0, l: 0 };
    room.lights.traverse((o) => {
      const l = o as THREE.Light;
      // (intensity, not visibility: the light count is part of every shader program's key)
      if (l.isLight && !(l as THREE.HemisphereLight).isHemisphereLight && l.color.getHSL(hsl).s > 0.5) {
        off.push([l, l.intensity]);
        l.intensity = 0;
      }
    });
  }
  bakeEnvironment(renderer, scene, e.mirror, new THREE.Vector3(...e.center), e.mirrorAt && new THREE.Vector3(...e.mirrorAt), e.intensity, r.envSize, r.envBounces);
  off.forEach(([l, i]) => (l.intensity = i));
}

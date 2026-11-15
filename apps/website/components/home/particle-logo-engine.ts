/**
 * Dependency-free WebGL particle renderer for the landing-page logo.
 *
 * The logo bitmap is sampled into a point cloud. Each point keeps a "home"
 * position on an inflated 3D surface (thicker where the stroke is wider), and a
 * damped spring pulls it back after pointer repulsion or a click burst. The
 * whole cloud tilts toward the pointer. Physics runs on the CPU (cheap at this
 * particle count); projection, sizing, and shading run in the shaders.
 */

export type ParticleTheme = "light" | "dark";

export interface ParticleLogoEngineOptions {
  canvas: HTMLCanvasElement;
  image: HTMLImageElement;
  particleCount: number;
  reducedMotion: boolean;
  theme: ParticleTheme;
}

interface ParticleField {
  color: Float32Array;
  count: number;
  delay: Float32Array;
  home: Float32Array;
  phase: Float32Array;
  size: Float32Array;
  stiffness: Float32Array;
}

interface GlResources {
  buffers: {
    color: WebGLBuffer;
    phase: WebGLBuffer;
    position: WebGLBuffer;
    size: WebGLBuffer;
  };
  program: WebGLProgram;
  uniforms: {
    cameraDistance: WebGLUniformLocation | null;
    dark: WebGLUniformLocation | null;
    modelView: WebGLUniformLocation | null;
    pointScale: WebGLUniformLocation | null;
    projection: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
    twinkle: WebGLUniformLocation | null;
  };
}

const LOGO_WIDTH = 3;
const SAMPLE_WIDTH = 220;
const ALPHA_THRESHOLD = 140;
const HALF_THICKNESS = 0.2;
const FIELD_OF_VIEW = (30 * Math.PI) / 180;
const POINTER_RADIUS = 0.55;
const POINTER_FORCE = 42;
const DAMPING = 6.4;
const BURST_FORCE = 7.5;
const ASSEMBLY_SECONDS = 1.1;
const MAX_FRAME_SECONDS = 1 / 30;

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aColor;
attribute float aSize;
attribute float aPhase;

uniform mat4 uProjection;
uniform mat4 uModelView;
uniform float uTime;
uniform float uPointScale;
uniform float uCameraDistance;
uniform float uTwinkle;
uniform float uDark;

varying vec3 vColor;
varying float vAlpha;
varying float vEdge;
varying float vCore;

void main() {
  vec4 viewPosition = uModelView * vec4(aPosition, 1.0);
  gl_Position = uProjection * viewPosition;
  float depth = -viewPosition.z;
  gl_PointSize = max(1.0, aSize * uPointScale / depth);

  // Distant particles fade toward the page background for depth.
  float back = smoothstep(uCameraDistance - 0.22, uCameraDistance + 0.3, depth);
  float shimmer = 0.5 + 0.5 * sin(uTime * 2.3 + aPhase * 6.2831);
  float twinkle = 1.0 - uTwinkle * mix(0.08, 0.26, uDark) * shimmer;
  vec3 fog = vec3(1.0 - uDark);
  vColor = mix(aColor, fog, back * mix(0.42, 0.55, uDark)) * twinkle;
  vAlpha = mix(0.95, 0.62, uDark) * mix(1.0, 0.75, back);
  // Theme-dependent shape is passed as varyings: WebGL 1 requires uniforms
  // shared between stages to match precision, which mediump fragments do not.
  vEdge = mix(0.7, 0.25, uDark);
  vCore = uDark * 0.35;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;

varying vec3 vColor;
varying float vAlpha;
varying float vEdge;
varying float vCore;

void main() {
  float distanceFromCenter = length(gl_PointCoord - 0.5) * 2.0;
  float disc = 1.0 - smoothstep(vEdge, 1.0, distanceFromCenter);
  float alpha = disc * vAlpha;
  if (alpha < 0.01) {
    discard;
  }
  float core = vCore * (1.0 - smoothstep(0.0, 0.5, distanceFromCenter));
  gl_FragColor = vec4((vColor + core) * alpha, alpha);
}
`;

export class ParticleLogoEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly field: ParticleField;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly reducedMotion: boolean;
  private readonly logoHeight: number;
  private readonly gl: WebGLRenderingContext;
  private resources: GlResources | undefined;
  private theme: ParticleTheme;

  private frame = 0;
  private running = false;
  private visible = true;
  private lastTime = 0;
  private startTime = 0;
  private sleeping = false;
  private quietFrames = 0;

  private width = 1;
  private height = 1;
  private cameraDistance = 8;
  private readonly projection = new Float32Array(16);
  private readonly modelView = new Float32Array(16);

  private yaw = 0;
  private pitch = 0;
  private pointerX = 0;
  private pointerY = 0;
  private pointerTargetX = 0;
  private pointerTargetY = 0;
  private pointerInside = false;
  private pointerStrength = 0;
  private hasPointer = false;

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGLRenderingContext,
    field: ParticleField,
    options: ParticleLogoEngineOptions,
  ) {
    this.canvas = canvas;
    this.gl = gl;
    this.field = field;
    this.reducedMotion = options.reducedMotion;
    this.theme = options.theme;
    this.position = new Float32Array(field.count * 3);
    this.velocity = new Float32Array(field.count * 3);
    this.logoHeight = measureHeight(field);
    this.seedPositions();
    this.resources = createResources(gl, field, this.position);
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
  }

  /** Returns undefined when WebGL is unavailable so callers keep a fallback. */
  static create(
    options: ParticleLogoEngineOptions,
  ): ParticleLogoEngine | undefined {
    const gl = options.canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      stencil: false,
    });
    if (!gl) {
      return undefined;
    }
    const field = sampleLogo(options.image, options.particleCount);
    if (field.count === 0) {
      return undefined;
    }
    try {
      return new ParticleLogoEngine(options.canvas, gl, field, options);
    } catch {
      return undefined;
    }
  }

  setTheme(theme: ParticleTheme): void {
    this.theme = theme;
    this.requestFrame();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.requestFrame();
    }
  }

  setSize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    const ratio = Math.min(Math.max(pixelRatio, 1), 2);
    this.width = Math.max(1, Math.round(cssWidth * ratio));
    this.height = Math.max(1, Math.round(cssHeight * ratio));
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    const aspect = this.width / this.height;
    const tangent = Math.tan(FIELD_OF_VIEW / 2);
    const fitHeight = this.logoHeight / 0.62 / (2 * tangent);
    const fitWidth = LOGO_WIDTH / 0.7 / (2 * tangent * aspect);
    this.cameraDistance = Math.max(fitHeight, fitWidth);
    writePerspective(this.projection, FIELD_OF_VIEW, aspect, 0.1, 50);
    this.requestFrame();
  }

  /** Pointer in normalized device coordinates (-1..1, y up). */
  setPointer(x: number, y: number, inside: boolean): void {
    this.pointerTargetX = clamp(x, -1.6, 1.6);
    this.pointerTargetY = clamp(y, -1.6, 1.6);
    if (!this.hasPointer) {
      this.pointerX = this.pointerTargetX;
      this.pointerY = this.pointerTargetY;
      this.hasPointer = true;
    }
    this.pointerInside = inside;
    if (inside) {
      this.wake();
    }
    this.requestFrame();
  }

  releasePointer(): void {
    this.pointerInside = false;
    this.hasPointer = false;
    this.requestFrame();
  }

  /** Scatters the particles away from a point; springs then re-assemble them. */
  burst(x = 0, y = 0): void {
    if (this.reducedMotion) {
      return;
    }
    const [originX, originY] = this.projectPointer(x, y);
    const { count } = this.field;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const dx = this.position[offset] - originX;
      const dy = this.position[offset + 1] - originY;
      const dz = this.position[offset + 2];
      const distance = Math.hypot(dx, dy, dz) + 0.0001;
      const impulse = (BURST_FORCE / (0.45 + distance)) * (0.6 + Math.random());
      this.velocity[offset] += (dx / distance) * impulse;
      this.velocity[offset + 1] += (dy / distance) * impulse;
      this.velocity[offset + 2] +=
        (dz / distance) * impulse + (Math.random() - 0.3) * BURST_FORCE * 0.9;
    }
    this.wake();
    this.requestFrame();
  }

  start(): void {
    this.running = true;
    this.startTime = performance.now();
    this.lastTime = this.startTime;
    this.requestFrame();
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    if (this.resources) {
      deleteResources(this.gl, this.resources);
      this.resources = undefined;
    }
  }

  private seedPositions(): void {
    const { count, home } = this.field;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      if (this.reducedMotion) {
        this.position[offset] = home[offset];
        this.position[offset + 1] = home[offset + 1];
        this.position[offset + 2] = home[offset + 2];
        continue;
      }
      // Start as a loose nebula that sweeps in from the brush side.
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.6 + Math.random() * 2.6;
      this.position[offset] = Math.cos(angle) * radius - 1.2;
      this.position[offset + 1] = Math.sin(angle) * radius * 0.7 - 0.6;
      this.position[offset + 2] = (Math.random() - 0.5) * 3;
    }
  }

  private wake(): void {
    this.sleeping = false;
    this.quietFrames = 0;
  }

  private requestFrame(): void {
    if (!this.running || !this.visible || this.frame || !this.resources) {
      return;
    }
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.frame = 0;
    const resources = this.resources;
    if (!resources) {
      return;
    }
    const delta = Math.min((now - this.lastTime) / 1000, MAX_FRAME_SECONDS);
    this.lastTime = now;
    const elapsed = (now - this.startTime) / 1000;

    this.updateView(delta, elapsed);
    const moving = this.sleeping ? false : this.stepPhysics(delta, elapsed);
    this.render(resources, elapsed, moving);

    const animating =
      !this.reducedMotion ||
      moving ||
      this.pointerStrength > 0.001 ||
      Math.abs(this.yaw - this.targetYaw(elapsed)) > 0.0005 ||
      Math.abs(this.pitch - this.targetPitch(elapsed)) > 0.0005;
    if (animating) {
      this.requestFrame();
    }
  };

  private targetYaw(elapsed: number): number {
    const idle = this.reducedMotion ? 0 : Math.sin(elapsed * 0.35) * 0.22;
    return this.hasPointer ? this.pointerX * 0.42 + idle * 0.35 : idle;
  }

  private targetPitch(elapsed: number): number {
    const idle = this.reducedMotion ? 0 : Math.sin(elapsed * 0.27) * 0.06;
    return this.hasPointer ? -this.pointerY * 0.28 + idle * 0.35 : idle;
  }

  private updateView(delta: number, elapsed: number): void {
    const follow = 1 - Math.exp(-delta * 10);
    this.pointerX += (this.pointerTargetX - this.pointerX) * follow;
    this.pointerY += (this.pointerTargetY - this.pointerY) * follow;

    const turn = 1 - Math.exp(-delta * 3.2);
    this.yaw += (this.targetYaw(elapsed) - this.yaw) * turn;
    this.pitch += (this.targetPitch(elapsed) - this.pitch) * turn;

    const strengthTarget = this.pointerInside ? 1 : 0;
    this.pointerStrength +=
      (strengthTarget - this.pointerStrength) * (1 - Math.exp(-delta * 6));
    if (this.pointerStrength > 0.01) {
      this.wake();
    }

    writeModelView(this.modelView, this.yaw, this.pitch, this.cameraDistance);
  }

  /** Advances the springs; returns whether any particle is still moving. */
  private stepPhysics(delta: number, elapsed: number): boolean {
    const { count, delay, home, stiffness } = this.field;
    const position = this.position;
    const velocity = this.velocity;
    const assembling = !this.reducedMotion && elapsed < ASSEMBLY_SECONDS + 1.4;
    const [pointerX, pointerY] = this.projectPointer(
      this.pointerX,
      this.pointerY,
    );
    const pointerForce = POINTER_FORCE * this.pointerStrength;
    const radiusSquared = POINTER_RADIUS * POINTER_RADIUS;
    let maxMotion = 0;

    for (let index = 0; index < count; index += 1) {
      if (assembling && elapsed < delay[index]) {
        maxMotion = 1;
        continue;
      }
      const offset = index * 3;
      const x = position[offset];
      const y = position[offset + 1];
      const z = position[offset + 2];
      const k = stiffness[index];
      let ax = (home[offset] - x) * k - velocity[offset] * DAMPING;
      let ay = (home[offset + 1] - y) * k - velocity[offset + 1] * DAMPING;
      let az = (home[offset + 2] - z) * k - velocity[offset + 2] * DAMPING;

      if (pointerForce > 0.01) {
        const dx = x - pointerX;
        const dy = y - pointerY;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < radiusSquared) {
          const distance = Math.sqrt(distanceSquared) + 0.0001;
          const falloff = 1 - distance / POINTER_RADIUS;
          const force = falloff * falloff * pointerForce;
          ax += (dx / distance) * force;
          ay += (dy / distance) * force;
          az += force * 0.45;
        }
      }

      const vx = velocity[offset] + ax * delta;
      const vy = velocity[offset + 1] + ay * delta;
      const vz = velocity[offset + 2] + az * delta;
      velocity[offset] = vx;
      velocity[offset + 1] = vy;
      velocity[offset + 2] = vz;
      position[offset] = x + vx * delta;
      position[offset + 1] = y + vy * delta;
      position[offset + 2] = z + vz * delta;

      const motion =
        Math.abs(vx) +
        Math.abs(vy) +
        Math.abs(vz) +
        Math.abs(home[offset] - x) +
        Math.abs(home[offset + 1] - y);
      if (motion > maxMotion) {
        maxMotion = motion;
      }
    }

    const moving = maxMotion > 0.0015;
    if (!moving && this.pointerStrength < 0.01) {
      this.quietFrames += 1;
      if (this.quietFrames > 30) {
        this.sleeping = true;
      }
    } else {
      this.quietFrames = 0;
    }
    return moving || !this.sleeping;
  }

  /** Intersects the pointer ray with the logo plane (z = 0) in model space. */
  private projectPointer(x: number, y: number): [number, number] {
    const tangent = Math.tan(FIELD_OF_VIEW / 2);
    const aspect = this.width / this.height;
    const rayX = x * tangent * aspect;
    const rayY = y * tangent;
    const rayZ = -1;
    const ca = Math.cos(this.yaw);
    const sa = Math.sin(this.yaw);
    const cb = Math.cos(this.pitch);
    const sb = Math.sin(this.pitch);
    // Columns of R = Rx(pitch) * Ry(yaw); R^T maps view space to model space.
    const originX = -cb * sa * this.cameraDistance;
    const originY = sb * this.cameraDistance;
    const originZ = cb * ca * this.cameraDistance;
    const directionX = ca * rayX + sb * sa * rayY - cb * sa * rayZ;
    const directionY = cb * rayY + sb * rayZ;
    const directionZ = sa * rayX - sb * ca * rayY + cb * ca * rayZ;
    if (Math.abs(directionZ) < 1e-5) {
      return [originX, originY];
    }
    const distance = -originZ / directionZ;
    return [originX + directionX * distance, originY + directionY * distance];
  }

  private render(
    resources: GlResources,
    elapsed: number,
    uploadPositions: boolean,
  ): void {
    const gl = this.gl;
    const dark = this.theme === "dark";

    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    if (dark) {
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook.
    gl.useProgram(resources.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffers.position);
    if (uploadPositions) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.position);
    }

    const { uniforms } = resources;
    gl.uniformMatrix4fv(uniforms.projection, false, this.projection);
    gl.uniformMatrix4fv(uniforms.modelView, false, this.modelView);
    gl.uniform1f(uniforms.time, elapsed);
    gl.uniform1f(
      uniforms.pointScale,
      this.height / (2 * Math.tan(FIELD_OF_VIEW / 2)),
    );
    gl.uniform1f(uniforms.cameraDistance, this.cameraDistance);
    gl.uniform1f(uniforms.twinkle, this.reducedMotion ? 0 : 1);
    gl.uniform1f(uniforms.dark, dark ? 1 : 0);
    gl.drawArrays(gl.POINTS, 0, this.field.count);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resources = undefined;
  };

  private readonly handleContextRestored = (): void => {
    try {
      this.resources = createResources(this.gl, this.field, this.position);
      this.wake();
      this.requestFrame();
    } catch {
      this.resources = undefined;
    }
  };
}

/** Samples opaque logo pixels into an inflated 3D point cloud. */
function sampleLogo(image: HTMLImageElement, count: number): ParticleField {
  const width = SAMPLE_WIDTH;
  const height = Math.max(
    1,
    Math.round((width * image.naturalHeight) / image.naturalWidth),
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return emptyField();
  }
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;

  const inside = new Uint8Array(width * height);
  const candidates: number[] = [];
  for (let index = 0; index < inside.length; index += 1) {
    if (pixels[index * 4 + 3] > ALPHA_THRESHOLD) {
      inside[index] = 1;
      candidates.push(index);
    }
  }
  if (candidates.length === 0) {
    return emptyField();
  }

  const distance = distanceToEdge(inside, width, height);
  let maxDistance = 1;
  for (const index of candidates) {
    maxDistance = Math.max(maxDistance, distance[index]);
  }

  const unit = LOGO_WIDTH / width;
  const field: ParticleField = {
    color: new Float32Array(count * 3),
    count,
    delay: new Float32Array(count),
    home: new Float32Array(count * 3),
    phase: new Float32Array(count),
    size: new Float32Array(count),
    stiffness: new Float32Array(count),
  };

  for (let particle = 0; particle < count; particle += 1) {
    const index = candidates[Math.floor(Math.random() * candidates.length)];
    const pixelX = index % width;
    const pixelY = Math.floor(index / width);
    const x = (pixelX + Math.random() - width / 2) * unit;
    const y = -(pixelY + Math.random() - height / 2) * unit;

    // Inflate the flat logo: thicker toward the middle of each stroke.
    const thickness =
      Math.sqrt(Math.min(1, distance[index] / maxDistance)) * HALF_THICKNESS;
    const layer = Math.random();
    const z =
      layer < 0.62
        ? thickness
        : layer < 0.86
          ? -thickness
          : (Math.random() * 2 - 1) * thickness;

    const offset = particle * 3;
    field.home[offset] = x;
    field.home[offset + 1] = y;
    field.home[offset + 2] = z;
    field.color[offset] = pixels[index * 4] / 255;
    field.color[offset + 1] = pixels[index * 4 + 1] / 255;
    field.color[offset + 2] = pixels[index * 4 + 2] / 255;
    field.size[particle] = 0.027 * (0.55 + Math.random() * 0.9);
    field.phase[particle] = Math.random();
    field.stiffness[particle] = 16 + Math.random() * 22;
    // Assemble left to right, like the brush stroke in the mark.
    field.delay[particle] =
      (pixelX / width) * ASSEMBLY_SECONDS + Math.random() * 0.35;
  }
  return field;
}

/** Two-pass chamfer distance (in pixels) from each inside pixel to the edge. */
function distanceToEdge(
  inside: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const diagonal = Math.SQRT2;
  const distance = new Float32Array(width * height);
  for (let index = 0; index < distance.length; index += 1) {
    distance[index] = inside[index] ? Number.POSITIVE_INFINITY : 0;
  }
  const read = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : distance[y * width + x];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!inside[index]) {
        continue;
      }
      distance[index] = Math.min(
        distance[index],
        read(x - 1, y) + 1,
        read(x, y - 1) + 1,
        read(x - 1, y - 1) + diagonal,
        read(x + 1, y - 1) + diagonal,
      );
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (!inside[index]) {
        continue;
      }
      distance[index] = Math.min(
        distance[index],
        read(x + 1, y) + 1,
        read(x, y + 1) + 1,
        read(x + 1, y + 1) + diagonal,
        read(x - 1, y + 1) + diagonal,
      );
    }
  }
  return distance;
}

function measureHeight(field: ParticleField): number {
  let maxY = 0;
  for (let index = 1; index < field.home.length; index += 3) {
    maxY = Math.max(maxY, Math.abs(field.home[index]));
  }
  return maxY * 2;
}

function emptyField(): ParticleField {
  return {
    color: new Float32Array(0),
    count: 0,
    delay: new Float32Array(0),
    home: new Float32Array(0),
    phase: new Float32Array(0),
    size: new Float32Array(0),
    stiffness: new Float32Array(0),
  };
}

function createResources(
  gl: WebGLRenderingContext,
  field: ParticleField,
  position: Float32Array,
): GlResources {
  const program = gl.createProgram();
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!program) {
    throw new Error("Unable to create WebGL program");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Unable to link particle program: ${log ?? "unknown"}`);
  }

  const buffers = {
    color: createBuffer(gl, field.color, gl.STATIC_DRAW),
    phase: createBuffer(gl, field.phase, gl.STATIC_DRAW),
    position: createBuffer(gl, position, gl.DYNAMIC_DRAW),
    size: createBuffer(gl, field.size, gl.STATIC_DRAW),
  };
  // A single program draws this canvas, so attribute pointers are set once.
  bindAttribute(gl, program, buffers.position, "aPosition", 3);
  bindAttribute(gl, program, buffers.color, "aColor", 3);
  bindAttribute(gl, program, buffers.size, "aSize", 1);
  bindAttribute(gl, program, buffers.phase, "aPhase", 1);

  return {
    buffers,
    program,
    uniforms: {
      cameraDistance: gl.getUniformLocation(program, "uCameraDistance"),
      dark: gl.getUniformLocation(program, "uDark"),
      modelView: gl.getUniformLocation(program, "uModelView"),
      pointScale: gl.getUniformLocation(program, "uPointScale"),
      projection: gl.getUniformLocation(program, "uProjection"),
      time: gl.getUniformLocation(program, "uTime"),
      twinkle: gl.getUniformLocation(program, "uTwinkle"),
    },
  };
}

function deleteResources(gl: WebGLRenderingContext, resources: GlResources) {
  for (const buffer of Object.values(resources.buffers)) {
    gl.deleteBuffer(buffer);
  }
  gl.deleteProgram(resources.program);
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Unable to create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Unable to compile shader: ${log ?? "unknown"}`);
  }
  return shader;
}

function createBuffer(
  gl: WebGLRenderingContext,
  data: Float32Array,
  usage: number,
): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) {
    throw new Error("Unable to create buffer");
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  return buffer;
}

function bindAttribute(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  buffer: WebGLBuffer,
  name: string,
  size: number,
) {
  const location = gl.getAttribLocation(program, name);
  if (location < 0) {
    return;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

/** Column-major perspective projection matrix. */
function writePerspective(
  out: Float32Array,
  fieldOfView: number,
  aspect: number,
  near: number,
  far: number,
) {
  const focal = 1 / Math.tan(fieldOfView / 2);
  out.fill(0);
  out[0] = focal / aspect;
  out[5] = focal;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
}

/** Column-major T(0, 0, -distance) * Rx(pitch) * Ry(yaw). */
function writeModelView(
  out: Float32Array,
  yaw: number,
  pitch: number,
  distance: number,
) {
  const ca = Math.cos(yaw);
  const sa = Math.sin(yaw);
  const cb = Math.cos(pitch);
  const sb = Math.sin(pitch);
  out[0] = ca;
  out[1] = sb * sa;
  out[2] = -cb * sa;
  out[3] = 0;
  out[4] = 0;
  out[5] = cb;
  out[6] = sb;
  out[7] = 0;
  out[8] = sa;
  out[9] = -sb * ca;
  out[10] = cb * ca;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = -distance;
  out[15] = 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

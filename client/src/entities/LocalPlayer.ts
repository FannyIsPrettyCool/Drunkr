import * as THREE from "three";
import {
  MOVE,
  DASH,
  clamp,
  stepMovement,
  type MoveState,
  type CollisionWorld,
} from "@drunkr/shared";
import type { Input } from "../input/Input.js";

const SENSITIVITY = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

/**
 * The locally-controlled player. Runs its own movement simulation (client
 * prediction) and drives the camera.
 */
export class LocalPlayer {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  grounded = false;
  dead = false;
  crouching = false;
  sliding = false;
  private slideTime = 0;
  private jumpsUsed = 0;

  // Movement modifiers set by the equipped weapon.
  speedMul = 1;
  maxJumps = 1;
  canSlide = true;
  /** Look-sensitivity multiplier (settings + scoped), updated by Game. */
  sensMul = 1;

  /** Dash ability cooldown (s remaining). */
  dashCooldown = 0;

  /** Procedural recoil applied to the camera (radians), decays each frame. */
  recoil = new THREE.Vector2();
  private bobTime = 0;
  private eye = MOVE.eyeHeight;
  private wasJump = false;
  private wasCrouch = false;
  private lastWishX = 0;
  private lastWishZ = -1;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private world: CollisionWorld,
  ) {}

  setWorld(world: CollisionWorld) {
    this.world = world;
  }

  spawn(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.dead = false;
    this.sliding = false;
    this.jumpsUsed = 0;
    if (Math.hypot(x, z) > 1) {
      this.yaw = Math.atan2(x, z);
      this.pitch = 0;
    }
  }

  look(dx: number, dy: number) {
    const s = SENSITIVITY * this.sensMul;
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  addRecoil(pitchKick: number, yawKick: number) {
    this.recoil.x += pitchKick;
    this.recoil.y += yawKick;
  }

  /** Apply an external velocity impulse (e.g. shotgun self-knockback). */
  applyImpulse(x: number, y: number, z: number) {
    this.vel.x += x;
    this.vel.y += y;
    this.vel.z += z;
    if (y > 0.5) this.grounded = false;
  }

  /** Teleport forward (look direction), clamped against geometry. */
  blink(dist: number) {
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const sub = 6;
    const step = dist / sub;
    // Sub-stepped so thin walls still stop the blink.
    for (let i = 0; i < sub; i++) {
      const vel = { x: fx * step, y: 0, z: fz * step };
      this.world.move(this.pos, vel, MOVE.radius, MOVE.height, 1);
    }
  }

  /** Dash burst in the current move/look direction. Returns true if it fired. */
  tryDash(): boolean {
    if (this.dead || this.dashCooldown > 0) return false;
    const dx = this.lastWishX, dz = this.lastWishZ;
    this.vel.x += dx * DASH.speed;
    this.vel.z += dz * DASH.speed;
    if (!this.grounded) this.vel.y = Math.max(this.vel.y, 1.5);
    this.dashCooldown = DASH.cooldownMs / 1000;
    return true;
  }

  update(input: Input, dt: number): { slideStarted: boolean; landed: boolean; jumped: boolean } {
    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);

    if (this.dead) {
      this.updateCamera(0, dt);
      return { slideStarted: false, landed: false, jumped: false };
    }

    this.crouching = input.crouching;

    const wish = input.moveAxis();
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = wish.x * cos + wish.z * sin;
    let wz = -wish.x * sin + wish.z * cos;
    const wlen = Math.hypot(wx, wz);
    if (wlen > 0) {
      wx /= wlen;
      wz /= wlen;
      this.lastWishX = wx;
      this.lastWishZ = wz;
    } else {
      // Default dash direction is where you're looking.
      this.lastWishX = -sin;
      this.lastWishZ = -cos;
    }
    const wishSpeed = wlen > 0 ? MOVE.speed : 0;

    const jumpEdge = input.jumping && !this.wasJump;
    this.wasJump = input.jumping;
    const crouchEdge = this.crouching && !this.wasCrouch;
    this.wasCrouch = this.crouching;

    const wasGrounded = this.grounded;
    const wasSliding = this.sliding;
    const wasJumps = this.jumpsUsed;

    const state: MoveState = {
      pos: this.pos, vel: this.vel, grounded: this.grounded,
      sliding: this.sliding, slideTime: this.slideTime, jumpsUsed: this.jumpsUsed,
    };
    stepMovement(
      state,
      {
        wishX: wx, wishZ: wz, wishSpeed,
        jump: input.jumping, jumpEdge,
        crouch: this.crouching, crouchEdge,
        speedMul: this.speedMul, maxJumps: this.maxJumps, canSlide: this.canSlide,
      },
      this.world,
      dt,
    );
    this.grounded = state.grounded;
    this.sliding = state.sliding;
    this.slideTime = state.slideTime;
    this.jumpsUsed = state.jumpsUsed;

    // Void falls are handled by Game (server-side death), not an in-place respawn.

    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.bobTime += dt * speed;
    this.updateCamera(speed, dt);

    return {
      slideStarted: this.sliding && !wasSliding,
      landed: this.grounded && !wasGrounded,
      jumped: this.jumpsUsed > wasJumps,
    };
  }

  private updateCamera(speed: number, dt: number) {
    this.recoil.multiplyScalar(0.86);

    const targetEye = this.crouching || this.sliding ? MOVE.crouchEyeHeight : MOVE.eyeHeight;
    this.eye += (targetEye - this.eye) * Math.min(1, 14 * dt);

    const bob = this.grounded && !this.sliding
      ? Math.sin(this.bobTime * 1.8) * 0.025 * Math.min(1, speed / MOVE.speed)
      : 0;
    // A slight camera roll while sliding for feel.
    const slideRoll = this.sliding ? 0.06 : 0;

    this.camera.position.set(this.pos.x, this.pos.y + this.eye + bob, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch + this.recoil.x);
    this.camera.rotateZ(this.recoil.y * 0.4 + slideRoll);
  }
}

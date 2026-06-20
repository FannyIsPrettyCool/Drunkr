import { MOVE, SLIDE } from "./constants.js";
import type { CollisionWorld } from "./collision.js";
import type { Vec3 } from "./math.js";

export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  grounded: boolean;
  /** Currently sliding (crouch-slide). */
  sliding: boolean;
  /** Remaining slide time (s). */
  slideTime: number;
  /** Jumps used since last grounded (for double-jump). */
  jumpsUsed: number;
}

export interface MoveInput {
  /** Normalized world-space wish direction (XZ). */
  wishX: number;
  wishZ: number;
  /** Target speed along the wish direction (0 = no input). */
  wishSpeed: number;
  /** Jump held (auto-bhop on the ground). */
  jump: boolean;
  /** Jump pressed this frame (used for the mid-air double jump). */
  jumpEdge: boolean;
  /** Crouch held. */
  crouch: boolean;
  /** Crouch pressed this frame (initiates a slide). */
  crouchEdge: boolean;
  /** Movement speed multiplier (e.g. katana makes you faster). */
  speedMul: number;
  /** Total jumps allowed (1 normally, 2 with double-jump). */
  maxJumps: number;
  /** Whether this actor can slide. */
  canSlide: boolean;
}

export function freshMoveState(pos: Vec3): MoveState {
  return { pos, vel: { x: 0, y: 0, z: 0 }, grounded: false, sliding: false, slideTime: 0, jumpsUsed: 0 };
}

/**
 * One Quake/Source-style movement tick with slide + double-jump extensions.
 * Shared by the client's LocalPlayer and the server's bots.
 */
export function stepMovement(
  state: MoveState,
  input: MoveInput,
  world: CollisionWorld,
  dt: number,
): { grounded: boolean; hitWall: boolean; padLaunched: boolean } {
  const speed2 = () => Math.hypot(state.vel.x, state.vel.z);
  const wasGrounded = state.grounded;

  if (state.grounded) state.jumpsUsed = 0;

  // Begin a slide, keeping (or boosting to) the current horizontal momentum.
  const startSlide = () => {
    state.sliding = true;
    state.slideTime = SLIDE.duration;
    const cur = speed2();
    const target = Math.max(cur, SLIDE.boost);
    const s = target / (cur || 1);
    state.vel.x *= s;
    state.vel.z *= s;
  };

  // --- Slide state ---
  const hs = speed2();
  // Crouch tapped while running on the ground → slide.
  if (input.canSlide && state.grounded && input.crouchEdge && !state.sliding && hs > SLIDE.minSpeed) {
    startSlide();
  }
  if (state.sliding) {
    state.slideTime -= dt;
    if (!input.crouch || !state.grounded || hs < SLIDE.endSpeed || state.slideTime <= 0) {
      state.sliding = false;
    }
  }

  // --- Jump (ground bhop + mid-air double jump) ---
  let jumped = false;
  if (state.grounded && input.jump) {
    state.vel.y = MOVE.jumpVelocity;
    state.grounded = false;
    state.jumpsUsed = 1;
    state.sliding = false; // jump out of a slide, keeping horizontal momentum
    jumped = true;
  } else if (!state.grounded && input.jumpEdge && state.jumpsUsed < input.maxJumps) {
    state.vel.y = MOVE.jumpVelocity;
    state.jumpsUsed++;
  }

  let wishSpeed = input.wishSpeed * input.speedMul;
  // Crouch-walking (not sliding) is slower than standing.
  if (input.crouch && !state.sliding) wishSpeed *= MOVE.crouchSpeedMul;

  if (state.grounded) {
    if (state.sliding) {
      applyFriction(state.vel, dt, SLIDE.friction);
    } else {
      // Always apply ground friction so crouch-walking decelerates to its
      // (lower) target speed instead of coasting at run speed.
      applyFriction(state.vel, dt, MOVE.friction);
      accelerate(state.vel, input.wishX, input.wishZ, wishSpeed, MOVE.groundAccel, dt);
    }
  } else {
    airAccelerate(state.vel, input.wishX, input.wishZ, wishSpeed, MOVE.airAccel, dt);
  }

  state.vel.y -= MOVE.gravity * dt;

  const res = world.move(state.pos, state.vel, MOVE.radius, MOVE.height, dt);
  state.grounded = res.grounded && !jumped;

  // Ramps: snap to the slope surface when walking on one (lets you climb).
  if (!jumped) {
    const ry = world.rampGround(state.pos);
    // Only snap when the ramp is at/above our feet (climbing or following the
    // slope) or while airborne. Never drag a grounded player DOWN onto a ramp
    // surface below their current footing — a ramp whose low end dips below the
    // floor would otherwise sink them into the floor slab and the next tick's
    // horizontal resolution would fling them to the arena edge.
    if (
      ry !== null && state.vel.y <= 1 &&
      state.pos.y >= ry - 0.7 && state.pos.y <= ry + 0.5 &&
      (!state.grounded || ry >= state.pos.y)
    ) {
      state.pos.y = ry;
      if (state.vel.y < 0) state.vel.y = 0;
      state.grounded = true;
    }
  }

  // Landing while holding crouch with speed → slide on touchdown (bhop→slide),
  // preserving the momentum you carried in instead of bleeding it to friction.
  if (
    input.canSlide && !state.sliding && state.grounded && !wasGrounded &&
    input.crouch && speed2() > SLIDE.minSpeed
  ) {
    startSlide();
  }

  // Jump pads: stepping on one launches you (overrides velocity).
  let padLaunched = false;
  if (state.grounded) {
    const launch = world.padLaunch(state.pos);
    if (launch) {
      state.vel.x = launch.x;
      state.vel.y = launch.y;
      state.vel.z = launch.z;
      state.grounded = false;
      state.sliding = false;
      padLaunched = true;
    }
  }

  return { grounded: state.grounded, hitWall: res.hitWall, padLaunched };
}

export function applyFriction(vel: Vec3, dt: number, friction = MOVE.friction): void {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < 0.05) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const control = Math.max(speed, MOVE.stopSpeed);
  const drop = control * friction * dt;
  const scale = Math.max(0, speed - drop) / speed;
  vel.x *= scale;
  vel.z *= scale;
}

export function accelerate(
  vel: Vec3, wx: number, wz: number, wishSpeed: number, accel: number, dt: number,
): void {
  const current = vel.x * wx + vel.z * wz;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const accelSpeed = Math.min(accel * wishSpeed * dt, add);
  vel.x += wx * accelSpeed;
  vel.z += wz * accelSpeed;
}

export function airAccelerate(
  vel: Vec3, wx: number, wz: number, wishSpeed: number, accel: number, dt: number,
): void {
  const cap = Math.min(wishSpeed, MOVE.airCap);
  const current = vel.x * wx + vel.z * wz;
  const add = cap - current;
  if (add <= 0) return;
  const accelSpeed = Math.min(accel * wishSpeed * dt, add);
  vel.x += wx * accelSpeed;
  vel.z += wz * accelSpeed;
}

import { MOVE } from "./constants.js";
import type { CollisionWorld } from "./collision.js";
import type { Vec3 } from "./math.js";

export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  grounded: boolean;
}

export interface MoveInput {
  /** Normalized world-space wish direction (XZ). */
  wishX: number;
  wishZ: number;
  /** Target speed along the wish direction (0 = no input). */
  wishSpeed: number;
  jump: boolean;
  crouch: boolean;
}

/**
 * One Quake/Source-style movement tick: friction + accelerate on the ground,
 * a capped air-strafe accelerate in the air, gravity, then collision. Shared
 * by the client's LocalPlayer and the server's bots so they move identically.
 */
export function stepMovement(
  state: MoveState,
  input: MoveInput,
  world: CollisionWorld,
  dt: number,
): { grounded: boolean; hitWall: boolean } {
  // Bunny-hop: jumping the instant we land keeps momentum (skip friction).
  let jumped = false;
  if (state.grounded && input.jump) {
    state.vel.y = MOVE.jumpVelocity;
    state.grounded = false;
    jumped = true;
  }

  if (state.grounded) {
    if (!input.crouch) applyFriction(state.vel, dt);
    accelerate(state.vel, input.wishX, input.wishZ, input.wishSpeed, MOVE.groundAccel, dt);
  } else {
    airAccelerate(state.vel, input.wishX, input.wishZ, input.wishSpeed, MOVE.airAccel, dt);
  }

  state.vel.y -= MOVE.gravity * dt;

  const res = world.move(state.pos, state.vel, MOVE.radius, MOVE.height, dt);
  state.grounded = res.grounded && !jumped;
  return { grounded: state.grounded, hitWall: res.hitWall };
}

export function applyFriction(vel: Vec3, dt: number): void {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < 0.05) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const control = Math.max(speed, MOVE.stopSpeed);
  const drop = control * MOVE.friction * dt;
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

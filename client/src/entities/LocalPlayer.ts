import * as THREE from "three";
import { MOVE, clamp, stepMovement, type CollisionWorld } from "@drunkr/shared";
import type { Input } from "../input/Input.js";

const SENSITIVITY = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

/**
 * The locally-controlled player. Runs its own movement simulation (client
 * prediction) and drives the camera. Position is the feet; the camera sits at
 * eye height with a little procedural bob/recoil offset.
 */
export class LocalPlayer {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  grounded = false;
  dead = false;
  crouching = false;

  /** Procedural recoil applied to the camera (radians), decays each frame. */
  recoil = new THREE.Vector2();
  private bobTime = 0;
  /** Smoothed eye height (lerps toward standing/crouching). */
  private eye = MOVE.eyeHeight;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private world: CollisionWorld,
  ) {}

  spawn(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.dead = false;
    // Face the arena centre so players don't stare at a wall on spawn.
    // Camera forward after rotateY(yaw) is (-sin yaw, -cos yaw); facing the
    // origin from (x,z) means yaw = atan2(x, z).
    if (Math.hypot(x, z) > 1) {
      this.yaw = Math.atan2(x, z);
      this.pitch = 0;
    }
  }

  look(dx: number, dy: number) {
    this.yaw -= dx * SENSITIVITY;
    this.pitch -= dy * SENSITIVITY;
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  addRecoil(pitchKick: number, yawKick: number) {
    this.recoil.x += pitchKick;
    this.recoil.y += yawKick;
  }

  update(input: Input, dt: number) {
    if (this.dead) {
      this.updateCamera(0, dt);
      return;
    }

    this.crouching = input.crouching;

    // Wish direction in world space. The camera (rotateY(yaw)) looks down
    // (-sin yaw, -cos yaw); W (wish.z = -1) must move that way and D
    // (wish.x = +1) along the camera's right (cos yaw, -sin yaw).
    const wish = input.moveAxis();
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = wish.x * cos + wish.z * sin;
    let wz = -wish.x * sin + wish.z * cos;
    const wlen = Math.hypot(wx, wz);
    if (wlen > 0) {
      wx /= wlen;
      wz /= wlen;
    }
    const wishSpeed = wlen > 0 ? MOVE.speed : 0;

    // Shared movement model (friction, accel, air-strafe, bhop, gravity, collide).
    const state = { pos: this.pos, vel: this.vel, grounded: this.grounded };
    stepMovement(
      state,
      { wishX: wx, wishZ: wz, wishSpeed, jump: input.jumping, crouch: this.crouching },
      this.world,
      dt,
    );
    this.grounded = state.grounded;

    // Fell out of the world — clamp back up.
    if (this.pos.y < -10) this.spawn(this.pos.x, 5, this.pos.z);

    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.bobTime += dt * speed;
    this.updateCamera(speed, dt);
  }

  private updateCamera(speed: number, dt: number) {
    // Decay recoil back to centre.
    this.recoil.multiplyScalar(0.86);

    // Smoothly settle eye height toward standing/crouching.
    const targetEye = this.crouching ? MOVE.crouchEyeHeight : MOVE.eyeHeight;
    this.eye += (targetEye - this.eye) * Math.min(1, 14 * dt);

    const bob = this.grounded
      ? Math.sin(this.bobTime * 1.8) * 0.025 * Math.min(1, speed / MOVE.speed)
      : 0;

    this.camera.position.set(this.pos.x, this.pos.y + this.eye + bob, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch + this.recoil.x);
    this.camera.rotateZ(this.recoil.y * 0.4);
  }
}

import * as THREE from "three";
import { CollisionWorld, textureForBox, type GameMap, type Ramp, type BoxShape, type Vec3 } from "@drunkr/shared";
import { getTexture, applyBoxUV } from "../render/Textures.js";

/**
 * Visual geometry for a map primitive. Collision is always the enclosing AABB
 * (see {@link BoxShape}), so these only change how a box looks, not how it blocks.
 */
export function shapeGeometry(shape: BoxShape | undefined, size: Vec3): THREE.BufferGeometry {
  const { x: sx, y: sy, z: sz } = size;
  if (shape === "cylinder") return new THREE.CylinderGeometry(0.5, 0.5, 1, 24).scale(sx, sy, sz);
  if (shape === "sphere") return new THREE.SphereGeometry(0.5, 24, 16).scale(sx, sy, sz);
  if (shape === "wedge") {
    const s = new THREE.Shape();
    s.moveTo(-sx / 2, -sy / 2);
    s.lineTo(sx / 2, -sy / 2);
    s.lineTo(-sx / 2, sy / 2);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: sz, bevelEnabled: false });
    g.translate(0, 0, -sz / 2);
    return g;
  }
  return new THREE.BoxGeometry(sx, sy, sz);
}

/**
 * Builds the visual geometry for a map and exposes:
 *  - `group`: meshes to add to the scene
 *  - `colliders`: solid meshes for weapon raycasts (walls block bullets)
 *  - `collision`: the AABB world used by the player controller
 */
export class Arena {
  readonly group = new THREE.Group();
  readonly colliders: THREE.Mesh[] = [];
  readonly collision: CollisionWorld;

  constructor(map: GameMap) {
    this.collision = new CollisionWorld(map);

    for (const box of map.boxes) {
      const isBox = !box.shape || box.shape === "box";
      const geo = shapeGeometry(box.shape, box.size);
      const tex = textureForBox(box);
      let mat: THREE.MeshStandardMaterial;
      if (tex) {
        if (isBox) applyBoxUV(geo, box.size, tex);
        const map3 = getTexture(tex);
        mat = new THREE.MeshStandardMaterial({
          map: map3,
          emissiveMap: map3,
          emissive: 0xffffff,
          emissiveIntensity: 0.18,
          roughness: 0.9,
          metalness: 0.05,
        });
      } else {
        mat = new THREE.MeshStandardMaterial({
          color: box.color,
          roughness: 0.85,
          metalness: 0.1,
          emissive: box.emissive ?? 0x000000,
          emissiveIntensity: box.emissive ? 0.35 : 0,
        });
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(box.pos.x, box.pos.y, box.pos.z);
      if (box.rot) mesh.rotation.set(box.rot.x, box.rot.y, box.rot.z);
      this.group.add(mesh);
      this.colliders.push(mesh);

      // Neon wireframe edge accent for the cyberpunk look.
      if (box.emissive) {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: box.emissive }),
        );
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        this.group.add(edges);
      }
    }

    for (const pad of map.pads ?? []) {
      // A bright textured slab leaning toward its launch direction.
      const geo = new THREE.BoxGeometry(pad.size.x, pad.size.y, pad.size.z);
      applyBoxUV(geo, pad.size, "pads");
      const padTex = getTexture("pads");
      const mat = new THREE.MeshStandardMaterial({
        map: padTex, emissiveMap: padTex, emissive: pad.color, emissiveIntensity: 0.8,
        metalness: 0.3, roughness: 0.5,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(pad.pos.x, pad.pos.y, pad.pos.z);
      const ang = Math.atan2(pad.launch.x, pad.launch.z);
      mesh.rotation.y = ang;
      mesh.rotation.x = -0.25; // tilt like a ramp
      this.group.add(mesh);
      // Up-chevron marker.
      const chevron = new THREE.Mesh(
        new THREE.ConeGeometry(0.5, 1, 4),
        new THREE.MeshBasicMaterial({ color: pad.color }),
      );
      chevron.position.set(pad.pos.x, pad.pos.y + 1, pad.pos.z);
      this.group.add(chevron);
    }

    for (const r of map.ramps ?? []) this.addRamp(r);

    this.addGrid(map.bounds);
  }

  /** A textured tilted slab whose top face is the walkable slope surface. */
  private addRamp(r: Ramp) {
    const alongX = r.dir === 0 || r.dir === 1;
    const L = alongX ? r.size.x : r.size.z;
    const angle = Math.atan2(r.size.y, L);
    const hyp = Math.hypot(L, r.size.y);
    const thick = 0.5;
    const dims = alongX
      ? new THREE.Vector3(hyp, thick, r.size.z)
      : new THREE.Vector3(r.size.x, thick, hyp);

    const geo = new THREE.BoxGeometry(dims.x, dims.y, dims.z);
    const key = textureForBox({ pos: r.pos, size: r.size, color: r.color, emissive: r.emissive, texture: r.texture }) ?? "walls_dark";
    applyBoxUV(geo, dims, key);
    const tex = getTexture(key);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: r.emissive ?? 0x666666, emissiveIntensity: 0.2, roughness: 0.9, metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(r.pos.x, r.pos.y + r.size.y / 2 - thick * 0.4, r.pos.z);
    if (r.dir === 0) mesh.rotation.z = angle;
    else if (r.dir === 1) mesh.rotation.z = -angle;
    else if (r.dir === 2) mesh.rotation.x = -angle;
    else mesh.rotation.x = angle;
    this.group.add(mesh);
    this.colliders.push(mesh);
  }

  /** A subtle neon floor grid for spatial reference. */
  private addGrid(bounds: number) {
    const grid = new THREE.GridHelper(bounds * 2, bounds, 0x18e0ff, 0x131a33);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.25;
    grid.position.y = 0.02;
    this.group.add(grid);
  }
}

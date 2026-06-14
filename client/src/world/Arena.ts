import * as THREE from "three";
import { CollisionWorld, type GameMap } from "@drunkr/shared";

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
      const geo = new THREE.BoxGeometry(box.size.x, box.size.y, box.size.z);
      const mat = new THREE.MeshStandardMaterial({
        color: box.color,
        roughness: 0.85,
        metalness: 0.1,
        emissive: box.emissive ?? 0x000000,
        emissiveIntensity: box.emissive ? 0.35 : 0,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(box.pos.x, box.pos.y, box.pos.z);
      this.group.add(mesh);
      this.colliders.push(mesh);

      // Neon wireframe edge accent for the cyberpunk look.
      if (box.emissive) {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: box.emissive }),
        );
        edges.position.copy(mesh.position);
        this.group.add(edges);
      }
    }

    for (const pad of map.pads ?? []) {
      // A bright tilted slab leaning toward its launch direction.
      const geo = new THREE.BoxGeometry(pad.size.x, pad.size.y, pad.size.z);
      const mat = new THREE.MeshStandardMaterial({
        color: pad.color, emissive: pad.color, emissiveIntensity: 0.9, metalness: 0.3, roughness: 0.4,
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

    this.addGrid(map.bounds);
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

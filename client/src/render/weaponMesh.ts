import * as THREE from "three";
import type { WeaponSkin } from "./cosmetics.js";

/**
 * Build a third-person weapon model (also used by the cosmetics preview) for a
 * weapon id, coloured by a skin palette. Returns the group plus a muzzle marker
 * so callers can start tracers at the barrel tip. Meshes are not hitboxes.
 */
export function buildWeaponMesh(id: string, sk: WeaponSkin): { group: THREE.Group; muzzle: THREE.Object3D } {
  const g = new THREE.Group();
  // Each material maps to a Locker "part" so the colour-picker labels are honest:
  //   body = frame, metal = furniture (mag/grip), steel = barrels/sights,
  //   accent = neon trim, glow = glowing core, emissive = the frame's glow tint.
  const mat = new THREE.MeshStandardMaterial({
    color: sk.body, emissive: sk.emissive, emissiveIntensity: 0.4, metalness: 0.6, roughness: 0.4,
  });
  const metal = new THREE.MeshStandardMaterial({ color: sk.metal, metalness: 0.8, roughness: 0.45 });
  const accent = new THREE.MeshStandardMaterial({ color: sk.accent, emissive: sk.accent, emissiveIntensity: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: sk.steel, metalness: 0.85, roughness: 0.3 });
  const glow = new THREE.MeshStandardMaterial({ color: sk.glow, emissive: sk.glow, emissiveIntensity: 1.6 });
  const box = (w: number, h: number, d: number, m: THREE.Material, z: number, x = 0, y = 0) => {
    const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    me.position.set(x, y, z);
    g.add(me);
    return me;
  };
  let muzzleZ = -0.95;
  switch (id) {
    case "sniper": {
      box(0.065, 0.09, 0.46, mat, -0.4);              // receiver (body)
      box(0.03, 0.03, 0.5, steel, -0.95);             // long barrel (steel)
      box(0.045, 0.045, 0.1, metal, -1.26);           // muzzle (metal)
      box(0.05, 0.05, 0.32, metal, -0.46, 0, 0.12);   // scope tube (metal)
      box(0.054, 0.054, 0.04, glow, -0.62, 0, 0.12);  // front lens (glow)
      box(0.052, 0.052, 0.03, accent, -0.3, 0, 0.12); // rear lens (accent)
      box(0.045, 0.13, 0.07, metal, 0.02, 0, -0.12).rotation.x = 0.5; // grip (metal)
      box(0.05, 0.07, 0.58, mat, 0.12);               // stock (body)
      muzzleZ = -1.32;
      break;
    }
    case "shotgun": {
      box(0.1, 0.1, 0.28, mat, -0.2);                 // receiver (body)
      box(0.036, 0.036, 0.62, steel, -0.62, 0, 0.045);  // upper barrel (steel)
      box(0.036, 0.036, 0.62, steel, -0.62, 0, -0.045); // lower barrel (steel)
      box(0.09, 0.016, 0.42, accent, -0.62);          // neon rib (accent)
      box(0.024, 0.024, 0.06, glow, -0.95, 0, 0.045); // muzzle core (glow)
      box(0.024, 0.024, 0.06, glow, -0.95, 0, -0.045);
      box(0.05, 0.13, 0.08, metal, 0.04, 0, -0.12).rotation.x = 0.4; // grip (metal)
      box(0.07, 0.1, 0.48, mat, 0.16);                // stock (body)
      muzzleZ = -0.95;
      break;
    }
    case "katana": {
      const blade = new THREE.MeshStandardMaterial({
        color: sk.steel, emissive: sk.emissive, emissiveIntensity: 0.5, metalness: 0.9, roughness: 0.2,
      });
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.09, 1.15), blade);
      b.position.set(0, 0.02, -0.62); g.add(b);
      const cut = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.028, 1.15), glow); // edge (glow)
      cut.position.set(0, -0.03, -0.62); g.add(cut);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.075, 0.16), blade);
      tip.position.set(0, 0.09, -1.24); tip.rotation.x = 0.3; g.add(tip);
      box(0.16, 0.13, 0.03, accent, -0.04);  // guard (accent)
      box(0.05, 0.05, 0.22, metal, 0.07);    // handle (metal)
      box(0.066, 0.066, 0.04, mat, 0.2);     // pommel (body)
      muzzleZ = -1.2;
      break;
    }
    default: { // ak
      box(0.07, 0.1, 0.42, mat, -0.3);                // receiver (body)
      box(0.05, 0.05, 0.26, mat, -0.62);              // handguard (body)
      box(0.03, 0.03, 0.18, steel, -0.86);            // barrel tip (steel)
      box(0.055, 0.15, 0.1, metal, -0.15, 0, -0.13).rotation.x = 0.45; // banana mag (metal)
      box(0.05, 0.14, 0.07, metal, 0.02, 0, -0.12).rotation.x = 0.45;  // grip (metal)
      box(0.05, 0.08, 0.46, mat, 0.13);               // stock (body)
      box(0.072, 0.014, 0.26, accent, -0.3, 0, 0.06); // neon accent (accent)
      box(0.03, 0.03, 0.05, glow, -0.5, 0, 0.075);    // chamber glow (glow)
      muzzleZ = -1.25;
      break;
    }
  }
  g.traverse((o) => { o.raycast = () => {}; });
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, muzzleZ);
  g.add(muzzle);
  return { group: g, muzzle };
}

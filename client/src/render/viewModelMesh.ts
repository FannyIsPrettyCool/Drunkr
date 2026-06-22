import * as THREE from "three";
import { partMaterial, type ResolvedPart } from "./cosmetics.js";

/**
 * Build the detailed first-person gun model for a weapon id, coloured + finished
 * by its resolved parts. Shared by the in-game viewmodel (`Weapon`), the Locker
 * preview and the third-person remotes so they all render identically. Returns
 * the group plus the muzzle Z offset (barrel tip). Meshes aren't hitboxes.
 *
 * Every mesh is tagged with a part key (Receiver, Barrel, Blade, …) so the Locker
 * pickers map one-to-one to what you see — colour and material both.
 */
export function buildViewModel(id: string, parts: ResolvedPart[]): { group: THREE.Group; muzzleZ: number } {
  const g = new THREE.Group();
  const byKey = new Map<string, THREE.Material>();
  for (const p of parts) byKey.set(p.key, partMaterial(p));
  const fallback = byKey.values().next().value as THREE.Material;
  const mat = (key: string): THREE.Material => byKey.get(key) ?? fallback;

  const add = (w: number, h: number, d: number, key: string, x = 0, y = 0, z = 0) => {
    const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(key));
    me.position.set(x, y, z);
    g.add(me);
    return me;
  };
  // A cylinder aligned down the barrel (-z) by default.
  const cyl = (r: number, len: number, key: string, x = 0, y = 0, z = 0) => {
    const me = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), mat(key));
    me.rotation.x = Math.PI / 2;
    me.position.set(x, y, z);
    g.add(me);
    return me;
  };

  let muzzleZ = -0.9;
  switch (id) {
    case "sniper": {
      // Long-range marksman rifle: long fluted barrel, big scope, skeleton stock.
      add(0.075, 0.11, 0.5, "frame", 0, 0, -0.4);        // receiver
      add(0.07, 0.035, 0.46, "barrel", 0, 0.075, -0.4);  // top rail
      cyl(0.022, 0.98, "barrel", 0, 0.0, -1.0);          // long barrel
      add(0.06, 0.06, 0.13, "barrel", 0, 0, -1.52);      // muzzle brake
      add(0.072, 0.02, 0.1, "accent", 0, 0.05, -1.52);   // brake accent
      cyl(0.045, 0.46, "scope", 0, 0.135, -0.5);         // scope tube
      cyl(0.05, 0.04, "lens", 0, 0.135, -0.735);         // front lens
      cyl(0.047, 0.03, "lens", 0, 0.135, -0.27);         // rear lens
      add(0.03, 0.085, 0.04, "scope", 0, 0.07, -0.62);   // front mount
      add(0.03, 0.085, 0.04, "scope", 0, 0.07, -0.38);   // rear mount
      add(0.03, 0.03, 0.11, "barrel", 0.06, 0.0, -0.18); // bolt handle
      add(0.05, 0.12, 0.09, "grips", 0, -0.13, -0.2);    // magazine
      add(0.085, 0.06, 0.12, "grips", 0, -0.1, -0.12);   // trigger guard
      add(0.05, 0.15, 0.07, "grips", 0, -0.12, 0.0).rotation.x = 0.5; // grip
      add(0.05, 0.07, 0.28, "frame", 0, -0.02, 0.0);     // stock
      add(0.05, 0.13, 0.05, "grips", 0, -0.05, 0.13);    // butt pad
      muzzleZ = -1.6;
      break;
    }
    case "shotgun": {
      // Futuristic break-action double-barrel: over/under barrels, neon rib.
      add(0.13, 0.13, 0.34, "frame", 0, 0, -0.22);        // receiver block
      add(0.13, 0.04, 0.32, "barrel", 0, 0.085, -0.22);   // top plate
      cyl(0.042, 0.74, "barrel", 0, 0.048, -0.66);        // upper barrel
      cyl(0.042, 0.74, "barrel", 0, -0.048, -0.66);       // lower barrel
      add(0.022, 0.13, 0.62, "barrel", 0, 0.0, -0.62);    // rib between barrels
      add(0.11, 0.018, 0.5, "accent", 0, 0.0, -0.64);     // neon rib strip
      add(0.075, 0.075, 0.06, "barrel", 0, 0.048, -1.02); // upper muzzle
      add(0.075, 0.075, 0.06, "barrel", 0, -0.048, -1.02); // lower muzzle
      cyl(0.024, 0.04, "core", 0, 0.048, -1.04);          // glowing core
      cyl(0.024, 0.04, "core", 0, -0.048, -1.04);
      add(0.12, 0.06, 0.07, "accent", 0, -0.05, -0.03);   // break hinge
      add(0.12, 0.07, 0.22, "furniture", 0, -0.06, -0.5); // forend
      add(0.055, 0.16, 0.08, "furniture", 0, -0.12, 0.06).rotation.x = 0.4; // grip
      add(0.07, 0.11, 0.26, "furniture", 0, -0.01, 0.0);  // angular stock
      add(0.07, 0.14, 0.05, "accent", 0, -0.03, 0.12);    // butt accent
      muzzleZ = -1.08;
      break;
    }
    case "katana": {
      // Neon katana: flat blade, glowing cutting edge, guard, wrapped handle.
      add(0.05, 0.05, 0.30, "handle", 0, -0.02, 0.06);    // handle wrap
      add(0.066, 0.066, 0.04, "guard", 0, -0.02, 0.21);   // pommel
      add(0.064, 0.064, 0.02, "guard", 0, -0.02, 0.12);   // wrap ridges
      add(0.064, 0.064, 0.02, "guard", 0, -0.02, 0.02);
      add(0.17, 0.14, 0.03, "guard", 0, -0.01, -0.12);    // guard
      add(0.022, 0.10, 1.25, "blade", 0, 0.02, -0.78).rotation.x = 0.04; // blade
      add(0.028, 0.03, 1.25, "edge", 0, -0.035, -0.78).rotation.x = 0.04; // glowing edge
      add(0.022, 0.085, 0.18, "blade", 0, 0.10, -1.46).rotation.x = 0.3; // tip
      muzzleZ = -1.5;
      break;
    }
    default: {
      // AK-pattern rifle: frame receiver, wood furniture, gunmetal barrel, mag.
      add(0.085, 0.12, 0.44, "frame", 0, 0, -0.30);       // receiver
      add(0.08, 0.035, 0.40, "frame", 0, 0.08, -0.30);    // dust cover
      add(0.05, 0.045, 0.05, "barrel", 0, 0.085, -0.14);  // rear sight block
      add(0.085, 0.085, 0.24, "furniture", 0, -0.01, -0.60); // lower handguard
      add(0.055, 0.05, 0.22, "furniture", 0, 0.065, -0.58);  // upper handguard
      cyl(0.013, 0.30, "barrel", 0, 0.085, -0.62);        // gas tube
      cyl(0.02, 0.52, "barrel", 0, 0.015, -0.95);         // barrel
      add(0.03, 0.075, 0.04, "barrel", 0, 0.085, -1.06);  // front sight post
      add(0.05, 0.05, 0.10, "barrel", 0, 0.015, -1.22);   // slant muzzle brake
      add(0.03, 0.03, 0.06, "core", 0, 0.0, -0.46);       // ejection-port core
      add(0.06, 0.11, 0.12, "mag", 0, -0.12, -0.15).rotation.x = 0.2;  // banana mag
      add(0.058, 0.12, 0.11, "mag", 0, -0.24, -0.19).rotation.x = 0.5;
      add(0.052, 0.10, 0.10, "mag", 0, -0.35, -0.25).rotation.x = 0.85;
      add(0.055, 0.16, 0.075, "mag", 0, -0.13, 0.04).rotation.x = 0.45; // pistol grip
      add(0.05, 0.085, 0.24, "furniture", 0, -0.01, 0.02); // stock
      add(0.05, 0.13, 0.05, "furniture", 0, -0.03, 0.13);  // butt pad
      add(0.088, 0.016, 0.30, "accent", 0, 0.03, -0.30);   // neon accent
      muzzleZ = -1.25;
      break;
    }
  }
  g.traverse((o) => { o.raycast = () => {}; });
  return { group: g, muzzleZ };
}

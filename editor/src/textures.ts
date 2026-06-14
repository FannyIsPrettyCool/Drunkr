import * as THREE from "three";
import { textureRepeat, type Vec3 } from "@drunkr/shared";

const cache = new Map<string, THREE.Texture>();
const loader = new THREE.TextureLoader();

export function getTexture(key: string): THREE.Texture {
  let t = cache.get(key);
  if (!t) {
    t = loader.load(`/textures/${key}.png`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    cache.set(key, t);
  }
  return t;
}

export function applyBoxUV(geo: THREE.BufferGeometry, size: Vec3, key: string) {
  const [rx, ry] = textureRepeat(size, key);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rx, uv.getY(i) * ry);
  uv.needsUpdate = true;
}

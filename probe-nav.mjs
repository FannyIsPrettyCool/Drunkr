import { MAPS, CollisionWorld, NavGrid, MOVE, stepMovement, freshMoveState } from "./shared/dist/index.js";
const DT=1/60,v=(x,y,z)=>({x,y,z});
const NI=(o={})=>({wishX:0,wishZ:0,wishSpeed:0,jump:false,jumpEdge:false,crouch:false,crouchEdge:false,speedMul:1,maxJumps:1,canSlide:true,...o});
const floor={pos:v(0,-0.5,0),size:v(200,1,200),color:0};

console.log("=== NAV hazard-awareness ===");
{
  // floor everywhere; a plasma pool at surface (10,0); a hazard BELOW a solid bridge at (-10,0)
  const map={name:"t",bounds:30,spawns:[v(0,0,0)],boxes:[floor,
    {pos:v(-10,0.5,0),size:v(8,1,8),color:0}], // raised "bridge" slab top y1 over the buried hazard
    hazards:[{pos:v(10,0.4,0),size:v(6,1,6),color:0,dps:20},     // surface pool -> should block
             {pos:v(-10,-1.5,0),size:v(8,2,8),color:0,dps:20}]}; // buried under the slab -> safe
  const w=new CollisionWorld(map); const nav=new NavGrid(w, map.bounds, map.hazards);
  console.log("  surface plasma cell (10,0) walkable?", nav.clearAt(10,0), "(want false)");
  console.log("  bridge-over-hazard cell (-10,0) walkable?", nav.clearAt(-10,0), "(want true)");
  console.log("  open floor cell (0,0) walkable?", nav.clearAt(0,0), "(want true)");
  // path from left to right must detour around the surface pool at x=10
  const p = nav.findPath(v(10,0,-12), v(10,0,12)); // straight line passes through pool at (10,0)
  const through = p && p.some(pt=>Math.abs(pt.x-10)<3 && Math.abs(pt.z)<3);
  console.log("  path from (10,-12)->(10,12):", p?`${p.length} pts, passes through pool=${through}`:"none", "(want detour, not through)");
}

console.log("=== RAMP walk-up + under (after revert) ===");
{
  const ramp={pos:v(8,0,0),size:v(8,3,8),dir:0,color:0}; // baseY0, rises to y3 at x12
  const map={name:"t",bounds:30,spawns:[v(0,0,0)],boxes:[floor],ramps:[ramp]};
  const up=freshMoveState(v(2,0.3,0)); const w=new CollisionWorld(map);
  for(let f=0;f<160;f++){const dx=12-up.pos.x;w.setTime(f*16.6);stepMovement(up,NI({wishX:dx>0?1:0,wishZ:0,wishSpeed:MOVE.speed}),w,DT);}
  console.log("  walk UP ground ramp: reached y=", up.pos.y.toFixed(2), "(want ~3)");
  const un=freshMoveState(v(2,0.3,3.6)); const w2=new CollisionWorld(map); // start beside, walk under high end
  // approach the high end (x>12 side) at floor level walking -x
  const u2=freshMoveState(v(20,0.3,3.6));
  for(let f=0;f<180;f++){w2.setTime(f*16.6);stepMovement(u2,NI({wishX:-1,wishZ:0,wishSpeed:MOVE.speed}),w2,DT);}
  console.log("  walk UNDER ground ramp high end: end x=", u2.pos.x.toFixed(1), "(want < 4 = passed under)");
}

console.log("=== REGRESSION: existing maps (spawns + ramps) ===");
function settle(w,p){const st=freshMoveState({x:p.x,y:p.y+0.3,z:p.z});for(let f=0;f<200;f++){w.setTime(f*16.6);stepMovement(st,NI(),w,DT);}return st;}
function walkRamp(w,r){const hx=r.size.x/2,hz=r.size.z/2;let lo,hi;
  if(r.dir===0){lo={x:r.pos.x-hx+0.6,y:r.pos.y,z:r.pos.z};hi={x:r.pos.x+hx+2,z:r.pos.z};}
  else if(r.dir===1){lo={x:r.pos.x+hx-0.6,y:r.pos.y,z:r.pos.z};hi={x:r.pos.x-hx-2,z:r.pos.z};}
  else if(r.dir===2){lo={x:r.pos.x,y:r.pos.y,z:r.pos.z-hz+0.6};hi={x:r.pos.x,z:r.pos.z+hz+2};}
  else {lo={x:r.pos.x,y:r.pos.y,z:r.pos.z+hz-0.6};hi={x:r.pos.x,z:r.pos.z-hz-2};}
  const st=freshMoveState({x:lo.x,y:lo.y+0.3,z:lo.z});
  for(let f=0;f<260;f++){const dx=hi.x-st.pos.x,dz=hi.z-st.pos.z,d=Math.hypot(dx,dz)||1;w.setTime(f*16.6);stepMovement(st,NI({wishX:dx/d,wishZ:dz/d,wishSpeed:MOVE.speed}),w,DT);}
  return st.pos.y>=r.pos.y+r.size.y-1.2;}
for(const id of Object.keys(MAPS)){
  const m=MAPS[id],w=new CollisionWorld(m);let bad=[];
  m.spawns.forEach((s,i)=>{const st=settle(w,s);if(!st.grounded||Math.abs(st.pos.y-s.y)>3.5)bad.push(`spawn${i}`);});
  if(!(m.ramps||[]).every(r=>walkRamp(w,r)))bad.push("ramp");
  console.log(`  ${id}: ${bad.length?bad.join(","):"ok ✓"}`);
}

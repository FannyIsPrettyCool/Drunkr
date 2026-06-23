import { CollisionWorld, NavGrid, MOVE, stepMovement, freshMoveState } from "./shared/dist/index.js";
const DT=1/60,v=(x,y,z)=>({x,y,z});
const NI=(o={})=>({wishX:0,wishZ:0,wishSpeed:0,jump:false,jumpEdge:false,crouch:false,crouchEdge:false,speedMul:1,maxJumps:1,canSlide:true,...o});
// Mangrove-style: wing floors, trench bed (no floor over channel), flush bridge at z=0, acid in trench.
const map={name:"t",bounds:40,spawns:[v(0,0,0)],boxes:[
  {pos:v(-23.5,-0.5,0),size:v(33,1,80),color:0}, // west wing floor top0 (x[-40,-7])
  {pos:v(23.5,-0.5,0),size:v(33,1,80),color:0},  // east wing floor top0 (x[7,40])
  {pos:v(0,-4.5,0),size:v(14,1,80),color:0},     // trench bed top-4 (x[-7,7])
  {pos:v(0,-0.5,0),size:v(18,1,6),color:0}],     // flush bridge top0 (x[-9,9] z[-3,3])
  hazards:[{pos:v(0,-2.3,0),size:v(13.5,3.4,78),color:0,dps:32}]}; // acid in trench
const w=new CollisionWorld(map); const nav=new NavGrid(w,map.bounds,map.hazards);
console.log("NAV (Mangrove-style acid channel):");
console.log("  open channel (0,20) walkable?", nav.clearAt(0,20), "(want false)");
console.log("  flush bridge (0,0) walkable?", nav.clearAt(0,0), "(want true)");
console.log("  west wing (-20,0) walkable?", nav.clearAt(-20,0), "(want true)");
const p=nav.findPath(v(-20,0,0),v(20,0,0)); // cross the channel -> must use the bridge (z~0)
const usesBridge = p && p.every(pt=>!(Math.abs(pt.x)<7 && Math.abs(pt.z)>4)); // never over open channel
console.log("  cross W->E path:", p?`${p.length} pts, avoids open channel=${usesBridge}`:"none");

console.log("RAMP walk-up (track max y during climb):");
const ramp={pos:v(8,0,0),size:v(8,3,8),dir:0,color:0};
const rmap={name:"t",bounds:30,spawns:[v(0,0,0)],boxes:[{pos:v(0,-0.5,0),size:v(60,1,60),color:0}],ramps:[ramp]};
const rw=new CollisionWorld(rmap); const st=freshMoveState(v(3,0.3,0)); let maxY=0;
for(let f=0;f<120;f++){const dx=11.5-st.pos.x;w.setTime(f*16.6);rw.setTime(f*16.6);stepMovement(st,NI({wishX:dx>0.2?1:0,wishZ:0,wishSpeed:MOVE.speed}),rw,DT);maxY=Math.max(maxY,st.pos.y);}
console.log("  max y while climbing dir0 ramp (top=3):", maxY.toFixed(2), maxY>2.5?"✓":"✗");

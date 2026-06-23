import { MAPS, CollisionWorld, MOVE, stepMovement, freshMoveState } from "./shared/dist/index.js";
const DT=1/60;
const NI=(o={})=>({wishX:0,wishZ:0,wishSpeed:0,jump:false,jumpEdge:false,crouch:false,crouchEdge:false,speedMul:1,maxJumps:1,canSlide:true,...o});
function settle(w,p){const st=freshMoveState({x:p.x,y:p.y+0.3,z:p.z});for(let f=0;f<200;f++){w.setTime(f*16.6);stepMovement(st,NI(),w,DT);}return st;}
function walkRamp(w,r){const hx=r.size.x/2,hz=r.size.z/2;let lo,hi;
  if(r.dir===0){lo={x:r.pos.x-hx+0.6,y:r.pos.y,z:r.pos.z};hi={x:r.pos.x+hx+2,z:r.pos.z};}
  else if(r.dir===1){lo={x:r.pos.x+hx-0.6,y:r.pos.y,z:r.pos.z};hi={x:r.pos.x-hx-2,z:r.pos.z};}
  else if(r.dir===2){lo={x:r.pos.x,y:r.pos.y,z:r.pos.z-hz+0.6};hi={x:r.pos.x,z:r.pos.z+hz+2};}
  else {lo={x:r.pos.x,y:r.pos.y,z:r.pos.z+hz-0.6};hi={x:r.pos.x,z:r.pos.z-hz-2};}
  const st=freshMoveState({x:lo.x,y:lo.y+0.3,z:lo.z});let maxY=lo.y;
  for(let f=0;f<260;f++){const dx=hi.x-st.pos.x,dz=hi.z-st.pos.z,d=Math.hypot(dx,dz)||1;w.setTime(f*16.6);stepMovement(st,NI({wishX:dx/d,wishZ:dz/d,wishSpeed:MOVE.speed}),w,DT);maxY=Math.max(maxY,st.pos.y);}
  return maxY>=r.pos.y+r.size.y-1.2;}
for(const id of Object.keys(MAPS)){
  const m=MAPS[id],w=new CollisionWorld(m);let bad=[];
  m.spawns.forEach((s,i)=>{const st=settle(w,s);if(!st.grounded||Math.abs(st.pos.y-s.y)>3.5)bad.push(`spawn${i}=${st.pos.y.toFixed(1)}`);});
  if(!(m.ramps||[]).every(r=>walkRamp(w,r)))bad.push("ramp");
  console.log(`${id}: ${bad.length?bad.join(","):"ok"}`);
}

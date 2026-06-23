import { MAPS, CollisionWorld, MOVE, stepMovement, freshMoveState, platformPosAt } from "./shared/dist/index.js";
const R=MOVE.radius,H=MOVE.height,DT=1/60;
const NI={wishX:0,wishZ:0,wishSpeed:0,jump:false,jumpEdge:false,crouch:false,crouchEdge:false,speedMul:1,maxJumps:1,canSlide:true};
function ride(mapId,i){
  const map=MAPS[mapId], world=new CollisionWorld(map), p=map.platforms[i];
  const c0=platformPosAt(p,0);
  const st=freshMoveState({x:c0.x,y:c0.y+p.size.y/2+0.02,z:c0.z});
  let t=0;
  for(let f=0;f<300;f++){ t+=DT*1000; world.setTime(t); stepMovement(st,NI,world,DT); }
  const c=platformPosAt(p,t);
  const onTop=Math.abs(st.pos.x-c.x)<p.size.x/2+R+0.1 && Math.abs(st.pos.z-c.z)<p.size.z/2+R+0.1 && Math.abs(st.pos.y-(c.y+p.size.y/2))<0.4;
  console.log(`${mapId}#${i} travel=(${p.travel.x},${p.travel.y},${p.travel.z}) period=${p.period} -> rider follows platform? ${onTop}  (rider@${st.pos.x.toFixed(1)},${st.pos.y.toFixed(1)},${st.pos.z.toFixed(1)} plat@${c.x.toFixed(1)},${(c.y+p.size.y/2).toFixed(1)},${c.z.toFixed(1)})`);
}
console.log("Mangrove platforms:"); MAPS.mangrove.platforms.forEach((_,i)=>ride("mangrove",i));
console.log("Aurora platforms:");   MAPS.aurora.platforms.forEach((_,i)=>ride("aurora",i));

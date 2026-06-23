import { CollisionWorld, MOVE, stepMovement, freshMoveState, platformPosAt } from "./shared/dist/index.js";
const R=MOVE.radius,H=MOVE.height,DT=1/60,v=(x,y,z)=>({x,y,z});
const floor={pos:v(0,-0.5,0),size:v(200,1,200),color:0};
const NI=(o={})=>({wishX:0,wishZ:0,wishSpeed:0,jump:false,jumpEdge:false,crouch:false,crouchEdge:false,speedMul:1,maxJumps:1,canSlide:true,...o});

// 1. Ride a FLAT horizontal platform (stand on top, no input) -> should track +x.
{
  const map={name:"t",bounds:100,spawns:[v(0,0,0)],boxes:[floor],
    platforms:[{pos:v(0,1,0),size:v(8,2,8),color:0,travel:v(20,0,0),period:8}]}; // top y2
  const w=new CollisionWorld(map); const st=freshMoveState(v(0,2.01,0));
  let t=0; for(let f=0;f<120;f++){t+=DT*1000;w.setTime(t);stepMovement(st,NI(),w,DT);}
  const c=platformPosAt(map.platforms[0],t);
  console.log(`1 ride flat platform: player x=${st.pos.x.toFixed(1)} platform x=${c.x.toFixed(1)} y=${st.pos.y.toFixed(2)} -> ${Math.abs(st.pos.x-c.x)<1?"RIDES ✓":"slides off ✗"}`);
}
// 2. Moving WALL sweeps into a standing player -> push along travel (+z), not sideways (x).
{
  const map={name:"t",bounds:100,spawns:[v(0,0,0)],boxes:[floor],
    platforms:[{pos:v(0,2.5,-12),size:v(8,5,0.8),color:0,travel:v(0,0,24),period:6}]}; // wall 8 wide(x), thin z
  const w=new CollisionWorld(map); const st=freshMoveState(v(0,0,0));
  let t=0,maxX=0; for(let f=0;f<150;f++){t+=DT*1000;w.setTime(t);stepMovement(st,NI(),w,DT);maxX=Math.max(maxX,Math.abs(st.pos.x));}
  console.log(`2 wall sweeps player: end (x=${st.pos.x.toFixed(1)}, z=${st.pos.z.toFixed(1)}) maxSidewaysX=${maxX.toFixed(2)} -> ${maxX<1.5?"pushed along ✓":"shoved SIDEWAYS ✗"}`);
}
// 3. Spawn under a wide ceiling (capsule head in it), no input -> should stay near spawn, not edge.
{
  const map={name:"t",bounds:60,spawns:[v(0,0,0)],boxes:[floor,
    {pos:v(0,2.2,0),size:v(80,1,80),color:0}]}; // wide ceiling, bottom y1.7 (capsule head 1.8 pokes in)
  const w=new CollisionWorld(map); const st=freshMoveState(v(0,0,0));
  for(let f=0;f<60;f++){w.setTime(f*16.6);stepMovement(st,NI(),w,DT);}
  console.log(`3 spawn under ceiling: end (x=${st.pos.x.toFixed(1)}, y=${st.pos.y.toFixed(1)}, z=${st.pos.z.toFixed(1)}) -> ${Math.hypot(st.pos.x,st.pos.z)<2?"stays put ✓":"TELEPORTED away ✗"}`);
}
// 4. Walk UNDER an elevated ramp (should pass through the space below it).
{
  const map={name:"t",bounds:100,spawns:[v(0,0,0)],boxes:[floor],
    ramps:[{pos:v(0,3,0),size:v(8,4,8),dir:0,color:0}]}; // footprint x[-4,4], low x-4 (y3) high x4 (y7) -- elevated
  const w=new CollisionWorld(map); const st=freshMoveState(v(20,0,0));
  for(let f=0;f<200;f++){const dx=-1;w.setTime(f*16.6);stepMovement(st,NI({wishX:dx,wishZ:0,wishSpeed:MOVE.speed}),w,DT);}
  console.log(`4 walk under elevated ramp: end x=${st.pos.x.toFixed(1)} -> ${st.pos.x< -4?"passed under ✓":"BLOCKED ✗"}`);
}

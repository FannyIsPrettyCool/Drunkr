import { WebSocket } from "ws";

const URL = "ws://localhost:2567";

function rpc(send, collectMs = 600) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const out = [];
    ws.on("open", () => send(ws));
    ws.on("message", (r) => out.push(JSON.parse(r.toString())));
    setTimeout(() => { ws.close(); resolve(out); }, collectMs);
  });
}

// 1) Room list (expect the persistent Quick Play room).
const list = await rpc((ws) => ws.send(JSON.stringify({ t: "rooms" })));
const roomlist = list.find((m) => m.t === "roomlist");
console.log("ROOMS:", JSON.stringify(roomlist?.rooms ?? "none"));

// 2) Create a Blacksite / hard room and confirm the welcome.
const created = await rpc((ws) =>
  ws.send(JSON.stringify({
    t: "create", name: "MAKER",
    config: { name: "Maze Night", mapId: "blacksite", bots: true, botCount: 3, difficulty: "hard" },
  })), 800);
const welcome = created.find((m) => m.t === "welcome");
console.log("CREATE welcome:", JSON.stringify({ mapId: welcome?.mapId, room: welcome?.roomName, players: welcome?.players?.length }));

// 3) Difficulty test: sit still in the open on neon_yard, count hits taken in 7s.
function sittingDuck(difficulty) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    let myId = -1, damage = 0, deaths = 0;
    const POS = { x: 28, y: 0, z: 18 }; // open corner
    ws.on("open", () =>
      ws.send(JSON.stringify({
        t: "create", name: "DUCK",
        config: { name: `duck-${difficulty}`, mapId: "neon_yard", bots: true, botCount: 4, difficulty },
      })));
    ws.on("message", (r) => {
      const m = JSON.parse(r.toString());
      if (m.t === "welcome") {
        myId = m.id;
        setInterval(() => ws.send(JSON.stringify({ t: "state", pos: POS, yaw: 0, pitch: 0 })), 100);
      }
      if (m.t === "damage") damage++;
      if (m.t === "kill" && m.victim === myId) deaths++;
      if (m.t === "respawned" && m.id === myId) {
        ws.send(JSON.stringify({ t: "state", pos: POS, yaw: 0, pitch: 0 }));
      }
    });
    setTimeout(() => { ws.close(); resolve({ difficulty, hitsTaken: damage, deaths }); }, 7000);
  });
}

const easy = await sittingDuck("easy");
const hard = await sittingDuck("hard");
console.log("DIFFICULTY (7s, sitting still, 4 bots):", JSON.stringify([easy, hard]));
process.exit(0);

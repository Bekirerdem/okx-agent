import { queue, flush, anchorStatus, anchorAddress } from "../src/anchor";
console.log("adres", anchorAddress(), "|", anchorStatus());
queue(JSON.stringify({ ts: new Date().toISOString(), kind: "info", role: "Kâtip", msg: "X Layer denetim izi testi" }));
const r = await flush();
console.log(r ?? ("başarısız: " + anchorStatus()));

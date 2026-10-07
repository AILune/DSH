import { spawn } from "node:child_process";
const cases = [
  ["node 自举", process.execPath, ["-e", "console.log('hello-from-node')"]],
  ["lark-cli --version", "C:\\Users\\85448\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe", ["--version"]],
];
for (const [label, bin, argv] of cases) {
  await new Promise((res) => {
    try {
      const c = spawn(bin, argv, { windowsHide: true });
      let out = "";
      c.stdout.on("data", (d) => (out += d.toString()));
      c.on("error", (e) => { console.log(`  ❌ ${label}: ${e.code} ${e.message.slice(0,80)}`); res(); });
      c.on("close", (code) => { console.log(`  ✅ ${label}: exit=${code} out=${out.trim().slice(0,60)}`); res(); });
    } catch (e) { console.log(`  ❌ ${label}: throw ${e.message.slice(0,80)}`); res(); }
  });
}

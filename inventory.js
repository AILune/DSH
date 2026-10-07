const fs = require("fs");
const base = "D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai";

function pkgInfo(name) {
  const p = `${base}/${name}/package.json`;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return { name, err: e.message };
  }
  const keys = Object.keys(j).filter((k) =>
    /cordis|dsh|peerDep|exports|main/i.test(k)
  );
  return {
    name,
    version: j.version,
    keys,
    cordis: j.cordis,
    dsh: j.dsh,
    peer: j.peerDependencies && Object.keys(j.peerDependencies),
  };
}

const targets = [
  "dsh-llm",
  "dsh-llm-pi-ai",
  "dsh-llm-deepseek-api-key",
  "dsh-tool-fs",
  "dsh-tool-bash",
  "dsh-tool-pwsh",
  "dsh-skill",
  "dsh-agent-loop",
  "dsh-client-ui-chat",
  "dsh-fs-local",
  "dsh-fs-sandbox",
  "dsh-bash-local",
  "dsh-bash-sandbox",
];

for (const t of targets) {
  const i = pkgInfo(t);
  console.log(`\n--- ${t} ---`);
  console.log("  version:", i.version);
  console.log("  package.json 顶层键:", i.keys.join(", ") || "(none matched)");
  if (i.cordis) console.log("  cordis 字段:", JSON.stringify(i.cordis));
  if (i.dsh) console.log("  dsh 字段:", JSON.stringify(i.dsh));
  if (i.peer && i.peer.length) console.log("  peerDeps:", i.peer.join(", "));
}

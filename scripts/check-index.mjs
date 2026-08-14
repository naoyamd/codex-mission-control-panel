import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
new Function(script);
if (!script.includes("100-window.usedPercent") || !script.includes("Codex 週上限 残り")) throw new Error("Weekly limit must render remaining capacity");
if (!script.includes("<span class=\"spec-label\">CTX</span>残り")) throw new Error("Task cards must render context remaining capacity");
console.log("HTML_CHECK_OK");

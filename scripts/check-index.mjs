import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
new Function(script);
if (!script.includes("100-window.usedPercent") || !script.includes("Codex 週上限 残り")) throw new Error("Weekly limit must render remaining capacity");
if (!script.includes("<span class=\"spec-label\">CTX</span>残り")) throw new Error("Task cards must render context remaining capacity");
if (!html.includes("@media (min-width:720px)") || !html.includes("#tasks { columns:280px;") || !html.includes(".status-pane { order:-1;")) throw new Error("Wide layout must prioritize the task overview from 720 px");
if (!script.includes("compactCards.has(selectedId)") || !html.includes("article.compact > .children article") || !html.includes('id="toggleCards"')) throw new Error("Task cards must support individual and bulk minimal summaries");
console.log("HTML_CHECK_OK");

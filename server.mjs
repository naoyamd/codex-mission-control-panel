#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = "1.2.1";
const here = dirname(fileURLToPath(import.meta.url));
const sourceKinds = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
];
const subscribers = new Set();
const pending = new Map();
const sessionCache = new Map();
let codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
let appServer;
let stdoutBuffer = "";
let requestId = 0;
let reconnectTimer;
let refreshing = false;
let state = {
  connection: "connecting",
  updatedAt: Date.now(),
  threads: [],
  threadsReady: false,
  usage: { status: "loading", plan: null, limits: [], activity: null, updatedAt: null, message: "" },
  message: "Codexへ接続しています",
};

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new TypeError(`Invalid MISSION_CONTROL_PORT: ${value}`);
  return parsed;
}

const port = parsePort(process.env.MISSION_CONTROL_PORT || 43177);

function statusType(status) {
  return typeof status === "string" ? status : status?.type || "unknown";
}

function subagentKind(thread) {
  if (thread.agentNickname) return thread.agentNickname;
  if (thread.agentRole) return thread.agentRole;
  const value = thread.source?.subAgent;
  if (typeof value === "string") return value;
  if (value?.other) return value.other;
  return thread.threadSource?.toLowerCase().includes("subagent") ? "subagent" : null;
}

function normalizedThread(thread) {
  const agent = subagentKind(thread);
  const updated = Number(thread.recencyAt || thread.updatedAt || thread.createdAt || 0);
  return {
    id: thread.id,
    parentId: thread.parentThreadId || null,
    title: thread.name || thread.agentNickname || thread.agentRole || (agent ? `サブエージェント ${agent}` : `タスク ${thread.id.slice(0, 8)}`),
    project: thread.cwd ? basename(thread.cwd) : "Codex",
    status: statusType(thread.status),
    activeFlags: thread.status?.activeFlags || [],
    updatedAt: updated < 10_000_000_000 ? updated * 1000 : updated,
    isPinned: Boolean(thread.isPinned),
    isSubagent: Boolean(agent || thread.parentThreadId),
    agentKind: agent,
    context: null,
    model: null,
    effort: null,
  };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedContext(info) {
  const last = info?.lastTokenUsage || info?.last_token_usage;
  const usedTokens = finite(last?.totalTokens ?? last?.total_tokens);
  const contextWindow = finite(info?.modelContextWindow ?? info?.model_context_window);
  return usedTokens != null && contextWindow ? { usedTokens, contextWindow } : null;
}

function normalizedSettings(event) {
  const payload = event?.payload || {};
  const settings = payload.threadSettings || payload.thread_settings || payload;
  return {
    model: settings.model || null,
    effort: settings.effort || settings.reasoningEffort || settings.reasoning_effort || payload.effort || null,
  };
}

function safeSessionPath(value) {
  if (typeof value !== "string" || !value.endsWith(".jsonl")) return null;
  const sessions = resolve(codexHome, "sessions");
  const candidate = resolve(value);
  const inside = relative(sessions, candidate);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? candidate : null;
}

function normalizedWindow(kind, window) {
  if (!window) return null;
  const usedPercent = finite(window.usedPercent ?? window.used_percent);
  const windowDurationMins = finite(window.windowDurationMins ?? window.window_minutes);
  const resetsAt = finite(window.resetsAt ?? window.resets_at);
  return usedPercent == null ? null : { kind, usedPercent, windowDurationMins, resetsAt: resetsAt ? resetsAt * 1000 : null };
}

function normalizedLimits(result = {}) {
  const byId = result.rateLimitsByLimitId;
  const buckets = byId && typeof byId === "object" ? Object.values(byId) : [result.rateLimits].filter(Boolean);
  return buckets.map((bucket) => ({
    id: bucket.limitId || bucket.limit_id || "codex",
    name: bucket.limitName || bucket.limit_name || null,
    plan: bucket.planType || bucket.plan_type || null,
    reached: bucket.rateLimitReachedType || bucket.rate_limit_reached_type || null,
    windows: [normalizedWindow("primary", bucket.primary), normalizedWindow("secondary", bucket.secondary)].filter(Boolean),
  })).filter((bucket) => bucket.windows.length);
}

function normalizedActivity(result = {}) {
  const summary = result.summary || {};
  const buckets = Array.isArray(result.dailyUsageBuckets) ? [...result.dailyUsageBuckets] : [];
  buckets.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const latest = buckets.at(-1);
  return {
    lifetimeTokens: finite(summary.lifetimeTokens),
    peakDailyTokens: finite(summary.peakDailyTokens),
    currentStreakDays: finite(summary.currentStreakDays),
    latest: latest ? { date: latest.startDate, tokens: finite(latest.tokens) } : null,
  };
}

function send(method, params = {}) {
  if (!appServer?.stdin.writable) return Promise.reject(new Error("app-server unavailable"));
  const id = ++requestId;
  appServer.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 8000);
    pending.set(id, { resolve, reject, timer });
  });
}

function writeNotification(message) {
  appServer?.stdin.write(`${JSON.stringify(message)}\n`);
}

function onMessage(message) {
  if (message.id != null && pending.has(message.id)) {
    const item = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error.message || "Codex error")) : item.resolve(message.result);
    return;
  }
  if (message.method === "thread/status/changed") {
    const target = state.threads.find((thread) => thread.id === message.params?.threadId);
    if (target) {
      target.status = statusType(message.params.status);
      target.activeFlags = message.params.status?.activeFlags || [];
      target.updatedAt = Date.now();
      publish();
    }
  }
  if (message.method === "account/rateLimits/updated") {
    const incoming = normalizedLimits(message.params);
    if (incoming.length) {
      const limits = new Map(state.usage.limits.map((limit) => [limit.id, limit]));
      for (const limit of incoming) limits.set(limit.id, limit);
      state.usage = { ...state.usage, status: "ready", limits: [...limits.values()], updatedAt: Date.now(), message: "" };
      publish();
    }
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  stdoutBuffer = "";
  state.connection = "connecting";
  state.message = "Codexへ接続しています";
  state.usage.status = state.usage.updatedAt ? "stale" : "loading";
  publish();
  appServer = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  appServer.stdout.setEncoding("utf8");
  appServer.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); } catch { /* non-protocol output */ }
    }
  });
  appServer.stderr.on("data", () => {});
  appServer.on("error", (error) => disconnect(error.message));
  appServer.on("exit", () => disconnect("Codexとの接続が切れました"));
  send("initialize", {
    clientInfo: { name: "mission_control_panel", title: "Mission Control Panel", version },
    capabilities: { experimentalApi: true },
  }).then((result) => {
    codexHome = result.codexHome || codexHome;
    writeNotification({ method: "initialized", params: {} });
    state.connection = "live";
    state.message = "自動更新中";
    return Promise.all([refresh(), refreshUsage()]);
  }).catch((error) => disconnect(error.message));
}

function disconnect(message) {
  if (state.connection === "offline" && reconnectTimer) return;
  state.connection = "offline";
  state.message = message;
  state.usage.status = state.usage.updatedAt ? "stale" : "unavailable";
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error(message));
  }
  pending.clear();
  publish();
  reconnectTimer = setTimeout(connect, 3000);
}

async function listThreads() {
  const all = [];
  let cursor = null;
  do {
    const result = await send("thread/list", { cursor, limit: 100, sortKey: "updated_at", sortDirection: "desc", sourceKinds });
    all.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor && all.length < 500);
  return all;
}

function dateParts(date) {
  return [String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")];
}

async function recentRollouts() {
  const files = [];
  for (const daysAgo of [0, 1]) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const directory = join(codexHome, "sessions", ...dateParts(date));
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(directory, entry.name));
      }
    } catch { /* no sessions for this date */ }
  }
  return files;
}

async function readSessionStatus(path) {
  const info = await stat(path);
  const cached = sessionCache.get(path);
  if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.value;
  const handle = await open(path, "r");
  try {
    const firstSize = Math.min(info.size, 256 * 1024);
    const first = Buffer.alloc(firstSize);
    await handle.read(first, 0, firstSize, 0);
    const headText = first.toString("utf8");
    const firstLine = headText.split(/\r?\n/, 1)[0];
    const meta = JSON.parse(firstLine).payload || {};
    const tailSize = Math.min(info.size, 512 * 1024);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, info.size - tailSize);
    const text = tail.toString("utf8");
    const eventPattern = /"type":"(task_started|task_complete|task_aborted)"/g;
    const last = [...headText.matchAll(eventPattern), ...text.matchAll(eventPattern)].at(-1)?.[1];
    if (!meta.id || !last) return null;
    const headLines = headText.split(/\r?\n/);
    const lines = text.split(/\r?\n/);
    const tokenLine = lines.findLast((line) => line.includes('"type":"token_count"')) || headLines.findLast((line) => line.includes('"type":"token_count"'));
    const settingsLine = lines.findLast((line) => line.includes('"type":"turn_context"') || line.includes('"type":"thread_settings_applied"')) || headLines.findLast((line) => line.includes('"type":"turn_context"') || line.includes('"type":"thread_settings_applied"'));
    let context = null;
    let settings = { model: null, effort: null };
    try { context = normalizedContext(JSON.parse(tokenLine)?.payload?.info); } catch { /* no complete token line in tail */ }
    try { settings = normalizedSettings(JSON.parse(settingsLine)); } catch { /* no complete settings line in tail */ }
    const stale = Date.now() - info.mtimeMs > 30 * 60 * 1000;
    const value = {
      id: meta.id,
      parentId: meta.parent_thread_id || null,
      project: meta.cwd ? basename(meta.cwd) : "Codex",
      isSubagent: Boolean(meta.parent_thread_id || meta.thread_source === "subagent"),
      agentKind: meta.thread_source === "subagent" ? "subagent" : null,
      status: last === "task_started" ? (stale ? "notLoaded" : "active") : "idle",
      activeFlags: [],
      updatedAt: info.mtimeMs,
      context,
      ...settings,
    };
    sessionCache.set(path, { size: info.size, mtimeMs: info.mtimeMs, value });
    return value;
  } finally {
    await handle.close();
  }
}

async function mergeRuntime(threads) {
  const map = new Map(threads.map((thread) => [thread.id, normalizedThread(thread)]));
  const paths = new Set([...threads.map((thread) => safeSessionPath(thread.path)).filter(Boolean), ...await recentRollouts()]);
  const runtime = (await Promise.all([...paths].map((path) => readSessionStatus(path).catch(() => null)))).filter(Boolean);
  for (const item of runtime) {
    const existing = map.get(item.id);
    if (existing) {
      existing.status = item.status === "idle" && statusType(existing.status) === "systemError" ? "systemError" : item.status;
      existing.activeFlags = item.activeFlags;
      existing.updatedAt = Math.max(existing.updatedAt, item.updatedAt);
      existing.parentId ||= item.parentId;
      existing.isSubagent ||= item.isSubagent;
      existing.context = item.context || existing.context;
      existing.model = item.model || existing.model;
      existing.effort = item.effort || existing.effort;
    } else if (item.status !== "idle") {
      map.set(item.id, {
        ...item,
        title: item.isSubagent ? "実行中のサブエージェント" : `実行中のタスク ${item.id.slice(0, 8)}`,
        isPinned: false,
      });
    }
  }
  return [...map.values()].sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt - a.updatedAt);
}

async function refresh() {
  if (state.connection !== "live" || refreshing) return;
  refreshing = true;
  try {
    state.threads = await mergeRuntime(await listThreads());
    state.threadsReady = true;
    state.updatedAt = Date.now();
    state.message = "自動更新中";
    publish();
  } catch (error) {
    state.message = `更新待ち: ${error.message}`;
    publish();
  } finally {
    refreshing = false;
  }
}

async function refreshUsage() {
  if (state.connection !== "live") return;
  const [account, limits, activity] = await Promise.allSettled([
    send("account/read", { refreshToken: false }),
    send("account/rateLimits/read"),
    send("account/usage/read"),
  ]);
  const normalized = limits.status === "fulfilled" ? normalizedLimits(limits.value) : [];
  const plan = account.status === "fulfilled" ? account.value.account?.planType || null : null;
  const errors = [limits, activity].filter((item) => item.status === "rejected").map((item) => item.reason.message);
  state.usage = {
    status: normalized.length ? (errors.length ? "partial" : "ready") : "unavailable",
    plan: plan || normalized.find((limit) => limit.plan)?.plan || null,
    limits: normalized,
    activity: activity.status === "fulfilled" ? normalizedActivity(activity.value) : null,
    updatedAt: Date.now(),
    message: errors.length ? "一部の利用状況を取得できません" : "",
  };
  publish();
}

function publish() {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const response of subscribers) response.write(payload);
}

async function handler(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  if (url.pathname === "/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    subscribers.add(response);
    response.write(`data: ${JSON.stringify(state)}\n\n`);
    request.on("close", () => subscribers.delete(response));
    return;
  }
  if (url.pathname === "/api/state") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(state));
    return;
  }
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (url.pathname !== "/") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
  });
  response.end(await readFile(join(here, "index.html")));
}

function selfCheck() {
  assert.equal(parsePort("43177"), 43177);
  assert.throws(() => parsePort("70000"), /Invalid MISSION_CONTROL_PORT/);
  assert.equal(statusType({ type: "active" }), "active");
  assert.equal(subagentKind({ source: { subAgent: { other: "guardian" } } }), "guardian");
  const child = normalizedThread({ id: "123456789", parentThreadId: "root", status: { type: "idle" }, source: { subAgent: "worker" } });
  assert.equal(child.parentId, "root");
  assert.equal(child.isSubagent, true);
  assert.deepEqual(normalizedContext({ last_token_usage: { total_tokens: 250 }, model_context_window: 1000 }), { usedTokens: 250, contextWindow: 1000 });
  assert.deepEqual(normalizedSettings({ payload: { model: "gpt-test", effort: "high" } }), { model: "gpt-test", effort: "high" });
  assert.equal(safeSessionPath(join(codexHome, "sessions", "test.jsonl"))?.endsWith("test.jsonl"), true);
  assert.equal(safeSessionPath(join(codexHome, "outside.jsonl")), null);
  assert.equal(normalizedLimits({ rateLimits: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 60, resetsAt: 100 } } })[0].windows[0].resetsAt, 100_000);
  console.log("SELF_CHECK_OK");
}

if (process.argv.includes("--self-check")) {
  selfCheck();
} else {
  createServer((request, response) => handler(request, response).catch((error) => response.writeHead(500).end(error.message)))
    .listen(port, "127.0.0.1", () => {
      console.log(`Mission Control: http://127.0.0.1:${port}`);
      connect();
      setInterval(refresh, 3000).unref();
      setInterval(refreshUsage, 60_000).unref();
    });
}

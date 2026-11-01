import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let host = process.env.PI_HOST_DIR;
if (!host) {
  let dir = path.dirname(realpathSync(execFileSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]));
  while (dir !== path.dirname(dir)) {
    const p = path.join(dir, "package.json");
    if (existsSync(p) && JSON.parse(readFileSync(p, "utf8")).name === "@earendil-works/pi-coding-agent") { host = dir; break; }
    dir = path.dirname(dir);
  }
}
if (!host) throw new Error("Set PI_HOST_DIR to the installed Pi package directory.");
const hostImport = p => import(pathToFileURL(path.join(host, p)).href);
const { loadExtensions } = await hostImport("dist/core/extensions/loader.js");
const { SessionManager } = await hostImport("dist/core/session-manager.js");
const { createModels, InMemoryCredentialStore } = await hostImport("node_modules/@earendil-works/pi-ai/dist/index.js");
const { builtinProviders } = await hostImport("node_modules/@earendil-works/pi-ai/dist/providers/all.js");

async function fixture(fetch) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-offline-key" }));
  const models = createModels({ credentials });
  models.setProvider(builtinProviders().find(p => p.id === "openai"));
  const loaded = await loadExtensions([path.join(root, "extensions/index.ts")], root);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  const session = SessionManager.inMemory(root);
  loaded.runtime.flagValues.set("goal-classifier", "openai/gpt-6-luna");
  loaded.runtime.appendEntry = (type, data) => session.appendCustomEntry(type, data);
  loaded.runtime.sendUserMessage = text => session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  loaded.runtime.sendMessage = msg => session.appendCustomMessageEntry(msg.customType, msg.content, msg.display, msg.details);
  const ctx = { cwd: root, sessionManager: session, hasPendingMessages: () => false,
    ui: { setStatus() {}, notify() {} },
    modelRegistry: { getAvailableOfType: models.getAvailableOfType.bind(models), getModelOfType: models.getModelOfType.bind(models),
      classify: (m, c, o) => models.classify(m, c, { ...o, fetch }) } };
  const emit = async (name, event) => {
    let result;
    for (const handler of ext.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  await emit("session_start", { type: "session_start" });
  await ext.commands.get("goal").handler("Get the test suite passing", ctx);
  assert(session.getBranch().some(e => e.type === "custom" && e.customType === "pi-goal"));
  const settle = () => emit("agent_before_settle", { type: "agent_before_settle", outcome: "completed", continue: false, entries: [],
    context: { contextMessages: [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "3 tests failed" }], isError: false }], pendingMessages: [] } });
  return { settle, session };
}

test("plugin -> native classifier/auth/Decisions adapter -> fake HTTP -> continuation draft", async () => {
  let requests = 0;
  const { settle } = await fixture(async (url, init) => {
    requests++;
    assert.match(String(url), /\/decisions$/);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-offline-key");
    const body = JSON.parse(init.body);
    assert.equal(body.questions[0].type, "choice");
    assert.deepEqual(body.questions[0].choices.map(c => typeof c === "string" ? c : c.value).sort(), ["continue", "input", "met", "waiting"]);
    const input = JSON.parse(body.input);
    assert.match(input.goal, /test suite/);
    assert.match(input.recent[0].text, /3 tests failed/);
    return Response.json({ answers: [{ name: "next", type: "choice", choice: "continue", confidence: 0.99,
      probabilities: ["continue", "met", "waiting", "input"].map(value => ({ value, probability: value === "continue" ? 0.99 : 0.01 / 3 })) }],
      usage: { input_tokens: 10, output_tokens: 3 } });
  });
  const result = await settle();
  assert.equal(requests, 1);
  assert.equal(result.continue, true);
  assert.equal(result.entries.find(e => e.customType === "pi-goal").data.status, "continue");
  assert.equal(result.entries.find(e => e.customType === "pi-goal-feedback").details.usage.totalTokens, 13);
});

test("native 403 remains visible, keeps goal and makes exactly one HTTP attempt", async () => {
  let requests = 0;
  const { settle } = await fixture(async () => { requests++; return Response.json({ error: { message: "offline access denied" } }, { status: 403 }); });
  const result = await settle();
  assert.equal(requests, 1);
  assert.equal(result.continue, false);
  const state = result.entries.find(e => e.customType === "pi-goal").data;
  assert.equal(state.status, "error");
  assert.match(state.last.error, /denied/);
  assert.match(state.text, /test suite/);
});

import test, { before, after, mock } from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
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

// The only permitted transport is each fixture's injected fake HTTP boundary.
// Stored credentials, ambient auth discovery and session persistence are not used.
let unexpectedNetworkAttempts = 0;
before(() => {
  const blocked = () => {
    unexpectedNetworkAttempts++;
    throw new Error("Unexpected global network attempt in offline native adapter test");
  };
  mock.method(globalThis, "fetch", blocked);
  for (const transport of [http, https]) {
    mock.method(transport, "request", blocked);
    mock.method(transport, "get", blocked);
  }
  mock.method(net.Socket.prototype, "connect", blocked);
  mock.method(tls, "connect", blocked);
});
after(() => {
  mock.restoreAll();
  assert.equal(unexpectedNetworkAttempts, 0, "native adapter must use only the injected fake HTTP");
});

async function fixture(fetch, { provider = "openai", id = "gpt-6-luna", goal = "Get the test suite passing" } = {}) {
  const credentials = new InMemoryCredentialStore();
  // Both providers are available: failover would be observable, not masked by missing credentials.
  for (const name of ["openai", "opencode"]) {
    await credentials.modify(name, async () => ({ type: "api_key", key: "synthetic-offline-key" }));
  }
  const models = createModels({ credentials, authContext: {
    env: async () => undefined,
    fileExists: async () => { throw new Error("Offline test must not inspect auth files"); },
  } });
  for (const name of ["openai", "opencode"]) {
    const native = builtinProviders().find(p => p.id === name);
    assert(native, `Installed native provider ${name} is required`);
    models.setProvider(native);
  }
  const model = models.getModelOfType("classifier", provider, id);
  assert(model, `Installed native classifier ${provider}/${id} is required`);
  const classifications = [];
  const loaded = await loadExtensions([path.join(root, "extensions/index.ts")], root);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  const session = SessionManager.inMemory(root);
  assert.equal(session.getSessionFile(), undefined, "offline fixture must never persist a session");
  loaded.runtime.flagValues.set("goal-classifier", `${provider}/${id}`);
  loaded.runtime.appendEntry = (type, data) => session.appendCustomEntry(type, data);
  loaded.runtime.sendUserMessage = text => session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  loaded.runtime.sendMessage = msg => session.appendCustomMessageEntry(msg.customType, msg.content, msg.display, msg.details);
  const ctx = { cwd: root, sessionManager: session, hasPendingMessages: () => false,
    ui: { setStatus() {}, notify() {} },
    modelRegistry: { getAvailableOfType: models.getAvailableOfType.bind(models), getModelOfType: models.getModelOfType.bind(models),
      classify: (m, c, o) => {
        classifications.push({ model: m, context: c, options: o });
        return models.classify(m, c, { ...o, fetch });
      } } };
  const emit = async (name, event) => {
    let result;
    for (const handler of ext.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  await emit("session_start", { type: "session_start" });
  await ext.commands.get("goal").handler(goal, ctx);
  assert(session.getBranch().some(e => e.type === "custom" && e.customType === "pi-goal"));
  const settle = (messages = [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "3 tests failed" }], isError: false }]) =>
    emit("agent_before_settle", { type: "agent_before_settle", outcome: "completed", continue: false, entries: [],
      context: { contextMessages: messages, pendingMessages: [] } });
  return { settle, session, model, classifications };
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

const opencode = { provider: "opencode", id: "jev-1.13-free" };
const utf8Bytes = value => Buffer.byteLength(value, "utf8");
const contextBytes = context => utf8Bytes(JSON.stringify(context));
const stateEntry = result => result.entries.find(e => e.customType === "pi-goal").data;
const feedbackEntry = result => result.entries.find(e => e.customType === "pi-goal-feedback");
const systemOneContinue = () => Response.json({
  answers: { next: { type: "choice", choice: "continue", confidence: 0.99,
    probabilities: { continue: 0.99, met: 0.003, waiting: 0.003, input: 0.004 } } },
  usage: { input_tokens: 123, output_tokens: 4 },
});

function inspectSystemOneRequest(url, init) {
  // Pin installed catalog routing, not the stale /zen/v1 comment in opencode.js.
  assert.equal(String(url), "https://opencode.ai/inference/v1/systemone");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer synthetic-offline-key");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "jev-1.13-free");
  assert.equal(body.questions.next.type, "choice");
  assert.deepEqual(Object.keys(body.questions.next.criteria).sort(), ["continue", "input", "met", "waiting"]);
  assert(body.questions.next.instructions.length > 0, "independent evaluation instructions must survive");
  return { state: body.state, questions: body.questions };
}

function assertNativeCall(fixture, expectedCalls = 1) {
  assert.equal(fixture.classifications.length, expectedCalls);
  for (const call of fixture.classifications) {
    assert.equal(call.model.provider, "opencode");
    assert.equal(call.model.id, "jev-1.13-free");
    assert.equal(call.model.api, "typesafe-system-one");
    assert.equal(call.options.maxRetries, 0);
    assert.equal(call.options.timeoutMs, 30_000);
  }
}

for (const [name, bulk] of [
  ["Chinese", "中文证据保留经济目标与执行结果"],
  ["emoji", "🧪🚀😀🀄"],
  ["JSON escapes", '"\\\n\r\t\b\f\u0000中文😀'],
]) {
  test(`native OpenCode System One: huge ${name} trajectory fits serialized catalog budget and continues`, async t => {
    const goal = `完整用户Goal：保留所有授权和验收条件，不能截断。\n${'中文😀"\\\t'.repeat(160)}\nGOAL-END`;
    const newestHead = `NEWEST-HEAD-${name}😀`;
    const newestTail = `NEWEST-TAIL-${name}🧪`;
    const toolEvidence = "verify-native-input-budget-工具😀";
    const messages = [
      ...Array.from({ length: 14 }, (_, i) => ({ role: "user", content: `OLDEST-${i}\n${bulk.repeat(10_000)}` })),
      { role: "assistant", content: [{ type: "thinking", thinking: "HIDDEN-REASONING-NOT-VISIBLE" },
        { type: "toolCall", name: "bash", arguments: { command: toolEvidence, quote: '"\\\n' } }] },
      { role: "toolResult", toolName: "bash", isError: true, content: [
        { type: "text", text: newestHead + bulk.repeat(20_000) + newestTail },
        { type: "image", mimeType: "image/png", data: "IMAGE-BYTES-NOT-VISIBLE" },
      ] },
      ...["pi-goal-context", "pi-goal-feedback", "pi-goal-update"].map(customType =>
        ({ role: "custom", customType, content: `RECURSIVE-${customType}` })),
    ];
    let requests = 0;
    let wireContext;
    const f = await fixture(async (url, init) => {
      requests++;
      wireContext = inspectSystemOneRequest(url, init);
      return systemOneContinue();
    }, { ...opencode, goal });
    // This is real installed catalog metadata, not a test-defined model/context limit.
    assert.equal(f.model.contextWindow, 32_000);
    const budget = Math.floor(f.model.contextWindow * 0.8) - 1024;
    const result = await f.settle(messages);
    assert.equal(requests, 1);
    assertNativeCall(f);
    assert.deepEqual(wireContext, f.classifications[0].context, "native adapter must preserve bounded state/questions");
    assert(contextBytes(wireContext) <= budget,
      `serialized UTF-8 context (${contextBytes(wireContext)}) must fit catalog budget (${budget})`);
    assert.equal(wireContext.state.goal, goal);
    assert.equal(wireContext.state.possiblyTruncated, true);
    assert(wireContext.state.recent.length < 16, "oldest visible evidence must be dropped");
    assert(!JSON.stringify(wireContext.state.recent).includes("OLDEST-0"));
    for (const message of wireContext.state.recent) {
      assert(utf8Bytes(message.text) <= 8192, "each visible message has an 8192-byte ceiling");
      assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(message.text),
        "head/tail clipping must not split Unicode surrogate pairs");
    }
    const newest = wireContext.state.recent.at(-1);
    assert.equal(newest.role, "toolResult");
    assert.equal(newest.toolName, "bash");
    assert.equal(newest.isError, true);
    assert(newest.text.startsWith(newestHead));
    assert(newest.text.endsWith(newestTail));
    assert.match(newest.text, /\[truncated\]/);
    assert(wireContext.state.recent.some(m => m.role === "assistant" && m.text.includes("toolCall bash:") && m.text.includes(toolEvidence)));
    const serialized = JSON.stringify(wireContext);
    for (const hidden of ["HIDDEN-REASONING-NOT-VISIBLE", "IMAGE-BYTES-NOT-VISIBLE", "RECURSIVE-pi-goal-"]) {
      assert(!serialized.includes(hidden), `do not expose ${hidden}`);
    }
    assert.equal(result.continue, true);
    assert.equal(stateEntry(result).status, "continue");
    assert.equal(stateEntry(result).text, goal);
    assert.equal(feedbackEntry(result).details.classifier, "opencode/jev-1.13-free");
    assert.equal(feedbackEntry(result).details.usage.totalTokens, 127);
    t.diagnostic(JSON.stringify({ case: name, contextWindow: f.model.contextWindow, budget,
      serializedContextBytes: contextBytes(wireContext), recentMessages: wireContext.state.recent.length,
      largestVisibleTextBytes: Math.max(...wireContext.state.recent.map(m => utf8Bytes(m.text))), requests }));
  });
}

test("native OpenCode: single clipped message truthfully marks possiblyTruncated", async () => {
  let wireContext;
  const f = await fixture(async (url, init) => {
    wireContext = inspectSystemOneRequest(url, init);
    return systemOneContinue();
  }, opencode);
  const result = await f.settle([{ role: "user", content: `HEAD😀${"汉字🧪".repeat(20_000)}TAIL🚀` }]);
  assertNativeCall(f);
  assert.equal(wireContext.state.recent.length, 1);
  assert.equal(wireContext.state.possiblyTruncated, true, "clipping is truncation even when no message was dropped");
  assert.match(wireContext.state.recent[0].text, /\[truncated\]/);
  assert(wireContext.state.recent[0].text.endsWith("TAIL🚀"));
  assert.equal(result.continue, true);
});

test("native OpenCode: untouched small trajectory is not marked truncated", async () => {
  let wireContext;
  const f = await fixture(async (url, init) => {
    wireContext = inspectSystemOneRequest(url, init);
    return systemOneContinue();
  }, opencode);
  const messages = [{ role: "user", content: 'small 中文😀 evidence with "quotes" and \\slashes' },
    { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "1 test failed" }] }];
  const result = await f.settle(messages);
  assertNativeCall(f);
  assert.equal(wireContext.state.possiblyTruncated, false);
  assert.deepEqual(wireContext.state.recent.map(m => m.text), [messages[0].content, "1 test failed"]);
  assert.equal(result.continue, true);
});

test("native OpenCode 400 max_tokens_exceeded remains one HTTP attempt, visible error, no continuation/failover", async () => {
  let requests = 0;
  const f = await fixture(async (url, init) => {
    requests++;
    inspectSystemOneRequest(url, init);
    return Response.json({ error: { code: "max_tokens_exceeded", message: "max_tokens_exceeded: actual classifier input too large" } }, { status: 400 });
  }, opencode);
  const result = await f.settle();
  assert.equal(requests, 1);
  assertNativeCall(f);
  assert.equal(result.continue, false);
  const state = stateEntry(result);
  assert.equal(state.status, "error");
  assert.equal(state.text, "Get the test suite passing");
  assert.deepEqual(state.classifier, opencode);
  assert.match(state.last.error, /max_tokens_exceeded/);
  assert.match(feedbackEntry(result).content, /max_tokens_exceeded/);
  assert.equal(feedbackEntry(result).details.classifier, "opencode/jev-1.13-free");
});

for (const [name, goal] of [
  ["oversized multibyte Goal", `完整Goal ${"中文😀".repeat(10_000)} GOAL-END`],
  // The Goal alone fits 24576 bytes, but the JSON envelope and required questions do not.
  ["Goal plus required questions overhead", `Goal ${"g".repeat(24_560)}`],
]) {
  test(`native OpenCode: ${name} yields error without any classify or HTTP attempt`, async () => {
    let requests = 0;
    const f = await fixture(async () => { requests++; return systemOneContinue(); }, { ...opencode, goal });
    const result = await f.settle([{ role: "user", content: "Newest evidence must not cause Goal truncation" }]);
    assert.equal(requests, 0);
    assertNativeCall(f, 0);
    assert.equal(result.continue, false);
    const state = stateEntry(result);
    assert.equal(state.status, "error");
    assert.equal(state.text, goal, "oversized Goal must remain intact for the user");
    assert.deepEqual(state.classifier, opencode);
    assert(state.last.error, "preflight budget rejection must be visible");
    assert(feedbackEntry(result).content.length > 0);
    assert.equal(feedbackEntry(result).details.classifier, "opencode/jev-1.13-free");
  });
}

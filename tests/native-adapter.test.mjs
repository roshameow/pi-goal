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
let unexpectedAuthFileAttempts = 0;
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
  assert.equal(unexpectedAuthFileAttempts, 0, "native adapter must never inspect auth files");
});

async function fixture(fetch, { provider = "openai", id = "gpt-6-luna", goal = "Get the test suite passing" } = {}) {
  const credentials = new InMemoryCredentialStore();
  // Both providers are available: failover would be observable, not masked by missing credentials.
  for (const name of ["openai", "opencode"]) {
    await credentials.modify(name, async () => ({ type: "api_key", key: "synthetic-offline-key" }));
  }
  const models = createModels({ credentials, authContext: {
    env: async () => undefined,
    fileExists: async () => { unexpectedAuthFileAttempts++; throw new Error("Offline test must not inspect auth files"); },
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
  const settle = (messages = [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "3 tests failed" }], isError: false }], entries = []) =>
    emit("agent_before_settle", { type: "agent_before_settle", outcome: "completed", continue: false, entries,
      context: { contextMessages: messages, pendingMessages: [] } });
  const initialGoal = session.getBranch().find(e => e.type === "custom" && e.customType === "pi-goal").data;
  const persist = async result => {
    for (const entry of result.entries) {
      if (entry.type === "custom") session.appendCustomEntry(entry.customType, entry.data);
      else if (entry.type === "custom_message") session.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
      else assert.fail(`Unexpected native draft entry type: ${entry.type}`);
    }
    await emit("agent_settled", { type: "agent_settled", aborted: false });
  };
  return { settle, session, model, classifications, initialGoal, persist,
    restore: () => emit("session_start", { type: "session_start" }),
    inspectGoal: () => ext.commands.get("goal").handler("", ctx) };
}

test("plugin -> native classifier/auth/Decisions adapter -> fake HTTP -> continuation draft", async () => {
  let requests = 0;
  const { settle } = await fixture(async (url, init) => {
    requests++;
    assert.match(String(url), /\/decisions$/);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-offline-key");
    const body = JSON.parse(init.body);
    inspectDecisionsQuestions(body.questions);
    const input = JSON.parse(body.input);
    assert.match(input.goal, /test suite/);
    assert.match(input.recent[0].text, /3 tests failed/);
    return nativeResponse("openai", "continue", "none", { input_tokens: 10, output_tokens: 3 });
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
const nextLabels = ["continue", "correct", "met", "waiting", "input"];
const reasonLabels = ["none", "evidence_conflict", "no_action", "off_goal", "invalid_wait", "premature_completion"];
const correctReasons = reasonLabels.slice(1);
const choiceAnswer = (choice, labels, confidence = 0.97) => ({ type: "choice", choice, confidence,
  probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? confidence : (1 - confidence) / (labels.length - 1)])) });

// Use each native protocol's real answer shape; do not stub modelRegistry.classify.
function nativeResponse(provider, next = "continue", reason = "none", usage = { input_tokens: 123, output_tokens: 4 }, { malformed } = {}) {
  const answers = { next: choiceAnswer(next, nextLabels, 0.99) };
  if (reason !== undefined) answers.reason = choiceAnswer(reason, reasonLabels);
  if (malformed === "missing") delete answers.reason;
  if (malformed === "wrong_type") answers.reason = { type: "score", score: 1, confidence: 0.97 };
  if (malformed === "missing_confidence") delete answers.reason.confidence;
  const wireAnswers = provider === "openai" ? Object.entries(answers).map(([name, answer]) => ({ name, ...answer,
    ...(answer.probabilities ? { probabilities: Object.entries(answer.probabilities).map(([value, probability]) => ({ value, probability })) } : {}) })) : answers;
  return Response.json({ answers: wireAnswers, usage });
}
const systemOneContinue = () => nativeResponse("opencode");

function inspectQuestions(questions) {
  assert.deepEqual(Object.keys(questions), ["next", "reason"], "two questions must share the same native classify call");
  for (const [name, labels] of [["next", nextLabels], ["reason", reasonLabels]]) {
    assert.equal(questions[name].type, "choice");
    assert.deepEqual(Object.keys(questions[name].criteria), labels, `${name} criteria insertion order must survive`);
    assert(questions[name].instructions.length > 0, `${name} instructions must survive`);
    assert(Object.values(questions[name].criteria).every(text => typeof text === "string" && text.length > 0));
  }
}

function inspectDecisionsQuestions(questions) {
  assert.deepEqual(questions.map(q => q.name), ["next", "reason"]);
  const normalized = Object.fromEntries(questions.map(({ name, type, instructions, choices }) => [name, {
    type, instructions, criteria: Object.fromEntries(choices.map(({ value, description }) => [value, description])),
  }]));
  inspectQuestions(normalized);
  return normalized;
}

function inspectSystemOneRequest(url, init) {
  // Pin installed catalog routing, not the stale /zen/v1 comment in opencode.js.
  assert.equal(String(url), "https://opencode.ai/inference/v1/systemone");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer synthetic-offline-key");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "jev-1.13-free");
  inspectQuestions(body.questions);
  return { state: body.state, questions: body.questions };
}

function assertNativeCall(fixture, expectedCalls = 1) {
  assert.equal(fixture.classifications.length, expectedCalls);
  for (const call of fixture.classifications) {
    assert.equal(call.model.provider, fixture.model.provider);
    assert.equal(call.model.id, fixture.model.id);
    assert.equal(call.model.api, fixture.model.provider === "openai" ? "openai-decisions" : "typesafe-system-one");
    inspectQuestions(call.context.questions);
    assert.equal(call.options.maxRetries, 0);
    assert.equal(call.options.timeoutMs, 30_000);
  }
}

for (const [name, bulk] of [
  ["Chinese", "测试文本保留输入与输出"],
  ["emoji", "🧪🚀😀🀄"],
  ["JSON escapes", '"\\\n\r\t\b\f\u0000中文😀'],
]) {
  test(`native OpenCode System One: huge ${name} trajectory fits serialized catalog budget and continues`, async t => {
    const goal = `Complete synthetic Goal: preserve permissions and acceptance conditions.\n${'中文😀"\\\t'.repeat(160)}\nGOAL-END`;
    const newestHead = `NEWEST-HEAD-${name}😀`;
    const newestTail = `NEWEST-TAIL-${name}🧪`;
    const toolEvidence = "verify-native-input-budget-测试😀";
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
  ["oversized multibyte Goal", `Complete synthetic Goal ${"中文😀".repeat(10_000)} GOAL-END`],
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

const providers = [{ provider: "openai", id: "gpt-6-luna" }, opencode];
function inspectNativeRequest(config, url, init) {
  if (config.provider === "opencode") return inspectSystemOneRequest(url, init);
  assert.equal(String(url), "https://api.openai.com/v1/decisions");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer synthetic-offline-key");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(init.body);
  assert.equal(body.model, config.id);
  return { state: JSON.parse(body.input), questions: inspectDecisionsQuestions(body.questions) };
}

function assertGoalRetained(f, state) {
  for (const key of ["version", "owner", "id", "text", "source", "classifier"]) {
    assert.deepEqual(state[key], f.initialGoal[key], `classification must not change Goal ${key}`);
  }
  assert.equal(state.checks, f.initialGoal.checks + 1);
  assert.deepEqual(Object.keys(state).sort(), Object.keys(f.initialGoal).concat("last").sort(),
    "a correction must not invent Goal fields or grant permissions");
}

function assertUsagePreserved(f, result, totalTokens = 127) {
  const usage = feedbackEntry(result).details.usage;
  assert.equal(usage.input, totalTokens - 4);
  assert.equal(usage.output, 4);
  assert.equal(usage.totalTokens, totalTokens);
  assert.equal(typeof usage.cost.total, "number");
  assert.equal(stateEntry(result).costUsd, f.initialGoal.costUsd + usage.cost.total);
}

const targetedFeedback = {
  evidence_conflict: /evidence|证据/i,
  no_action: /action|execute|执行|行动/i,
  off_goal: /current goal|当前Goal|目标/i,
  invalid_wait: /wait|等待/i,
  premature_completion: /complet|验收|完成/i,
};

for (const config of providers) {
  for (const reason of correctReasons) {
    test(`native ${config.provider}: correct/${reason} gives targeted feedback and original-boundary continuation`, async () => {
      let requests = 0;
      let wireContext;
      const goal = "Make the synthetic text parser pass its acceptance tests without changing permissions.";
      const f = await fixture(async (url, init) => {
        requests++;
        wireContext = inspectNativeRequest(config, url, init);
        return nativeResponse(config.provider, "correct", reason);
      }, { ...config, goal });
      const originalEntry = { type: "custom", customType: "synthetic-boundary-marker", data: { preserve: true } };
      const result = await f.settle([
        { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "3 acceptance tests failed" }] },
        { role: "assistant", content: "The work is complete; I will wait now." },
      ], [originalEntry]);
      assert.equal(requests, 1, "next and reason must not become two HTTP requests");
      assertNativeCall(f);
      assert.deepEqual(wireContext, f.classifications[0].context);
      assert.equal(wireContext.state.goal, goal);
      assert.equal(result.continue, true);
      assert.equal(result.entries.length, 3, "only the original entry, Goal state, and feedback draft are returned");
      assert.strictEqual(result.entries[0], originalEntry, "preserve preceding boundary entries");
      const state = stateEntry(result);
      assertGoalRetained(f, state);
      assert.equal(state.status, "correct");
      assert.equal(state.last.verdict, "correct");
      assert.equal(state.last.confidence, 0.99);
      assert.equal(state.last.reason, reason);
      assert.equal(state.last.reasonConfidence, 0.97);
      assert.equal(state.last.error, undefined);
      const feedback = feedbackEntry(result);
      assert.equal(feedback.type, "custom_message");
      assert.equal(feedback.display, true);
      assert.match(feedback.content, /correct/);
      assert.match(feedback.content.split("\n").slice(1).join("\n"), targetedFeedback[reason],
        "feedback must give a reason-specific instruction, not only repeat the reason label");
      assert.equal(feedback.details.reason, reason);
      assert.equal(feedback.details.reasonConfidence, 0.97);
      assert.equal(feedback.details.classifier, `${config.provider}/${config.id}`);
      assertUsagePreserved(f, result);
      assert(!f.session.getBranch().some(e => e.type === "custom" && e.customType === "pi-goal" && e.data.status === "correct"),
        "boundary handler must return a draft, not eagerly append its verdict");
      await f.persist(result);
      await f.restore();
      await f.inspectGoal();
      const stored = f.session.getBranch().filter(e => e.type === "custom" && e.customType === "pi-goal").at(-1).data;
      assert.deepEqual(stored, state, "reason and confidence must survive native session persistence/restore");
      const report = f.session.getBranch().filter(e => e.type === "custom_message" && e.customType === "pi-goal-feedback").at(-1);
      assert(report.content.includes(reason));
      assert.equal(requests, 1, "persistence and inspection must not reclassify");
    });
  }

  for (const [name, reason, malformed] of [
    ["missing reason", "none", "missing"],
    ["invalid reason label", "unsupported_reason", undefined],
    ["none reason", "none", undefined],
    ["wrong reason type", "none", "wrong_type"],
    ["missing reason confidence", "off_goal", "missing_confidence"],
  ]) {
    test(`native ${config.provider}: correct with ${name} is error with Goal and billed usage retained, no retry`, async () => {
      let requests = 0;
      const f = await fixture(async (url, init) => {
        requests++;
        inspectNativeRequest(config, url, init);
        return nativeResponse(config.provider, "correct", reason, undefined, { malformed });
      }, config);
      const result = await f.settle();
      assert.equal(requests, 1);
      assertNativeCall(f);
      assert.equal(result.continue, false);
      const state = stateEntry(result);
      assertGoalRetained(f, state);
      assert.equal(state.status, "error");
      assert.equal(state.last.verdict, "error");
      assert.match(state.last.error, /reason/i);
      assert.equal(state.last.reason, undefined, "invalid correction must not be persisted as applied");
      assert.equal(state.last.reasonConfidence, undefined);
      assert(feedbackEntry(result).content.includes(state.last.error));
      assertUsagePreserved(f, result);
      await f.persist(result);
      await f.restore();
      await f.inspectGoal();
      assert.equal(requests, 1, "error persistence/inspection must not retry the native classifier");
    });
  }

  for (const verdict of ["continue", "met", "waiting", "input"]) {
    test(`native ${config.provider}: ${verdict} retains previous continuation behavior and ignores a noncorrect reason`, async () => {
      let requests = 0;
      const f = await fixture(async (url, init) => {
        requests++;
        inspectNativeRequest(config, url, init);
        return nativeResponse(config.provider, verdict, "off_goal");
      }, config);
      const result = await f.settle();
      assert.equal(requests, 1);
      assertNativeCall(f);
      assert.equal(result.continue, verdict === "continue");
      const state = stateEntry(result);
      assertGoalRetained(f, state);
      assert.equal(state.status, verdict);
      assert.equal(state.last.verdict, verdict);
      assert.equal(state.last.error, undefined);
      assert.equal(state.last.reason, undefined, "reason is applied only to correct");
      assert.equal(state.last.reasonConfidence, undefined);
      assert.equal(feedbackEntry(result).details.reason, undefined);
      assert.equal(feedbackEntry(result).details.reasonConfidence, undefined);
      assert(!feedbackEntry(result).content.includes("off_goal"));
      assertUsagePreserved(f, result);
    });
  }

  test(`native ${config.provider}: an old stored Goal without reason restores and is evaluated normally`, async () => {
    let requests = 0;
    const f = await fixture(async (url, init) => {
      requests++;
      inspectNativeRequest(config, url, init);
      return nativeResponse(config.provider);
    }, config);
    const legacy = { ...f.initialGoal, status: "waiting", checks: 2, last: { verdict: "waiting", confidence: 0.9 } };
    f.session.appendCustomEntry("pi-goal", legacy);
    await f.restore();
    await f.inspectGoal();
    assert.equal(requests, 0);
    const result = await f.settle();
    assert.equal(requests, 1);
    assertNativeCall(f);
    assert.equal(result.continue, true);
    assert.equal(stateEntry(result).id, legacy.id);
    assert.equal(stateEntry(result).text, legacy.text);
    assert.equal(stateEntry(result).checks, 3);
    assert.equal(stateEntry(result).status, "continue");
    assert.equal(stateEntry(result).last.reason, undefined);
  });

  test(`native ${config.provider}: complete Goal and both questions fit the existing serialized catalog budget on correct`, async t => {
    let requests = 0;
    let wireContext;
    const goal = `Complete synthetic Goal, with unchanged permissions and acceptance criteria.\n${'test🧪"\\\t'.repeat(160)}\nGOAL-END`;
    const f = await fixture(async (url, init) => {
      requests++;
      wireContext = inspectNativeRequest(config, url, init);
      return nativeResponse(config.provider, "correct", "evidence_conflict");
    }, { ...config, goal });
    const result = await f.settle([
      ...Array.from({ length: 12 }, (_, i) => ({ role: "user", content: `OLDEST-${i} ${"synthetic😀\n\\".repeat(20_000)}` })),
      { role: "toolResult", toolName: "bash", isError: true,
        content: [{ type: "text", text: `NEWEST-HEAD ${"synthetic🧪\n\\".repeat(20_000)} NEWEST-TAIL` }] },
    ]);
    assert.equal(requests, 1);
    assertNativeCall(f);
    assert.deepEqual(wireContext, f.classifications[0].context);
    const budget = Math.max(0, Math.min(60_000, Math.floor(f.model.contextWindow * 0.8) - 1024));
    assert(contextBytes(wireContext) <= budget, "serialized state plus both complete questions must fit");
    assert.equal(wireContext.state.goal, goal);
    assert.equal(wireContext.state.possiblyTruncated, true);
    assert.equal(wireContext.state.recent.at(-1).text.startsWith("NEWEST-HEAD"), true);
    assert.equal(wireContext.state.recent.at(-1).text.endsWith("NEWEST-TAIL"), true);
    assert.equal(stateEntry(result).last.inputBudget.requestBytes, contextBytes(wireContext));
    assert.equal(stateEntry(result).last.inputBudget.budgetBytes, budget);
    assert.equal(stateEntry(result).status, "correct");
    assert.equal(result.continue, true);
    assertUsagePreserved(f, result);
    t.diagnostic(JSON.stringify({ provider: config.provider, questions: 2, requests, budget,
      serializedContextBytes: contextBytes(wireContext) }));
  });
}

test("native OpenAI 400 max_tokens_exceeded remains one HTTP attempt, visible error, no continuation/failover", async () => {
  let requests = 0;
  const config = providers[0];
  const f = await fixture(async (url, init) => {
    requests++;
    inspectNativeRequest(config, url, init);
    return Response.json({ error: { code: "max_tokens_exceeded", message: "max_tokens_exceeded: synthetic input too large" } }, { status: 400 });
  }, config);
  const result = await f.settle();
  assert.equal(requests, 1);
  assertNativeCall(f);
  assert.equal(result.continue, false);
  const state = stateEntry(result);
  assertGoalRetained(f, state);
  assert.equal(state.status, "error");
  assert.match(state.last.error, /max_tokens_exceeded/);
  assert(feedbackEntry(result).content.includes(state.last.error));
});

// Independent offline acceptance tests. Never load user/project settings or credentials.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function locatePi() {
  if (process.env.PI_HOST_DIR) return realpathSync(process.env.PI_HOST_DIR);
  let dir = path.dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@earendil-works/pi-coding-agent') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot locate installed Pi; set PI_HOST_DIR.');
    dir = parent;
  }
}
const hostDir = locatePi();
const hostImport = (relative) => import(pathToFileURL(path.join(hostDir, relative)).href);
const root = fileURLToPath(new URL('../', import.meta.url));
const product = path.join(root, 'extensions/index.ts');
const { loadExtensions } = await hostImport('dist/core/extensions/loader.js');
const { ExtensionRunner } = await hostImport('dist/core/extensions/runner.js');
const { SessionManager } = await hostImport('dist/core/session-manager.js');
const { AgentSession } = await hostImport('dist/core/agent-session.js');
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network forbidden in offline /goal tests'); };
after(() => { globalThis.fetch = originalFetch; assert.equal(networkAttempts, 0, 'No code may attempt network access'); });

const fixtureErrors = [];
after(() => { for (const errors of fixtureErrors) assert.deepEqual(errors, [], 'Native runner errors must not be swallowed'); });
const dirs = [];
const temporaryDir = () => { const dir = mkdtempSync(path.join(tmpdir(), 'pi-goal-test-')); dirs.push(dir); return dir; };
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const classifier = { type: 'classifier', provider: 'offline-native', id: 'judge/one', api: 'test-classifier', input: ['text'] };

async function harness({ manager, classify, available = [classifier], preference } = {}) {
  assert.ok(existsSync(product), `Missing implementation: ${product}`);
  const cwd = temporaryDir();
  const sm = manager ?? SessionManager.inMemory(cwd);
  const loaded = await loadExtensions([product], cwd);
  assert.deepEqual(loaded.errors, [], 'Actual installed Pi loader must accept the extension');
  assert.equal(loaded.extensions.length, 1);
  const calls = [], sent = [], notices = [], errors = [];
  if (preference !== undefined) loaded.runtime.flagValues.set('goal-classifier', preference);
  let verdict = 'continue';
  const statuses = [];
  const classifications = () => calls.filter(c => c.model);
  let pending = false;
  let signal;
  const registry = {
    getAvailableOfType: async (type) => { calls.push({ discovery: type }); assert.equal(type, 'classifier'); return available; },
    getModelOfType: (type, provider, id) => {
      calls.push({ lookup: [type, provider, id] });
      return type === 'classifier' && available.some(m => m.provider === provider && m.id === id) ? available.find(m => m.provider === provider && m.id === id) : undefined;
    },
    findOfType(type, provider, id) { return this.getModelOfType(type, provider, id); },
    classify: async (model, context, options) => {
      calls.push({ model, context, options });
      return classify ? await classify(model, context, options) : answer(verdict, model);
    },
  };
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sm, registry);
  const customMessage = message => sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  runner.bindCore({
    appendEntry: (type, data) => sm.appendCustomEntry(type, data),
    sendMessage: (message, options) => { sent.push({ message, options }); customMessage(message); },
    sendUserMessage: (content, options) => { sent.push({ content, options }); sm.appendMessage({ role: 'user', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, timestamp: Date.now() }); },
    getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), getCommands: () => [],
    getThinkingLevel: () => 'off',
  }, {
    getModel: () => undefined, getScopedModels: () => [], isIdle: () => true,
    isProjectTrusted: () => true, getSignal: () => signal, hasPendingMessages: () => pending,
    getContextUsage: () => undefined, getSystemPrompt: () => 'Offline test',
    compact: () => { throw new Error('Unexpected real compaction request'); },
    abort: () => { throw new Error('Unexpected abort request'); }, shutdown: () => { throw new Error('Unexpected shutdown'); },
  });
  runner.setUIContext({
    notify: (message, level) => notices.push({ message, level }),
    setStatus: (key, text) => statuses.push({ key, text }), setWidget: () => {},
  }, 'print');
  runner.onError(error => errors.push(error));
  fixtureErrors.push(errors);
  await runner.emit({ type: 'session_start', reason: 'startup' });
  const command = async args => {
    const registered = runner.getCommand('goal');
    assert.ok(registered, '/goal is registered');
    return registered.handler(args, runner.createCommandContext());
  };
  // Use Pi's actual boundary projection/commit implementation with an isolated,
  // real SessionManager, not a hand-written approximation of canContinue.
  const session = Object.create(AgentSession.prototype);
  Object.assign(session, {
    sessionManager: sm, _cwd: cwd, _pendingCustomMessages: [],
    _entryIdsByMessage: new WeakMap(), _eventListeners: [],
    _extensionRunner: runner, _lastActivityOutcome: 'completed',
    agent: { state: { messages: [] }, peekQueuedMessages: () => [], hasQueuedMessages: () => pending },
    _flushPendingCustomMessages: () => {},
  });
  const boundary = async ({ outcome = 'completed', before = [] } = {}) => {
    session._lastActivityOutcome = outcome;
    if (before.length) {
      const extra = { path: '<offline-earlier-extension>', handlers: new Map([['agent_before_settle', before]]) };
      loaded.extensions.unshift(extra);
      try { return await session._runBeforeSettleBoundary(); }
      finally { loaded.extensions.shift(); }
    }
    return await session._runBeforeSettleBoundary();
  };
  return { cwd, sm, loaded, runner, registry, calls, sent, notices, errors, session, command, boundary, classifications, statuses,
    setVerdict: value => { verdict = value; },
    setPending: value => { pending = value; }, setSignal: value => { signal = value; } };
}

function conversation(sm, text = 'Task finished') {
  sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Please work' }], timestamp: 1 });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text }], api: 'test', provider: 'test', model: 'offline', stopReason: 'stop', usage, timestamp: 2 });
}

function answer(verdict = 'continue', model = classifier) {
  return { provider: model.provider, model: model.id, api: model.api, answers: { next: {
    type: 'choice', choice: verdict, confidence: 0.95, probabilities: { [verdict]: 0.95 },
  } }, usage: { ...usage, cost: { ...usage.cost, total: 0.012 } }, stopReason: 'stop', timestamp: Date.now() };
}
function state(sm) {
  const entries = sm.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-goal');
  const value = entries.at(-1)?.data;
  return value?.cleared ? undefined : value;
}
const drafts = sm => sm.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'pi-goal-feedback');
async function active(options) {
  const h = await harness(options);
  await h.command('Deliver the requested change');
  conversation(h.sm);
  return h;
}
// Product-specific cases follow below; all classifier responses are local stubs.
test('implementation loads through installed Pi without network or configured sessions', async () => {
  const h = await harness();
  assert.equal(h.calls.length, 0, 'Inert load must not resolve/run a classifier');
  assert.equal(h.sent.length, 0, 'Inert load must not trigger the agent');
  assert.equal(await h.boundary(), false);
  assert.equal(h.sm.getBranch().length, 0);
  const input = [{ role: 'user', content: 'Ordinary prompt', timestamp: 1 }];
  assert.deepEqual(await h.runner.emitContext(input), input, 'No goal means no context reminder');
  assert.deepEqual(h.errors, []);
});

test('/goal text starts work; status observes; clear stops only the goal loop', async () => {
  const h = await harness();
  await h.command('');
  assert.match(h.sent.at(-1).message.content, /No goal/);
  assert.equal(h.classifications().length, 0);
  await h.command('  Make the tests pass  ');
  assert.equal(state(h.sm).text, 'Make the tests pass');
  assert.equal(state(h.sm).owner, h.sm.getSessionId());
  assert.equal(state(h.sm).status, 'active');
  assert.deepEqual(state(h.sm).classifier, { provider: classifier.provider, id: classifier.id });
  assert.equal(h.sent.at(-1).options.deliverAs, 'steer');
  assert.match(h.sent.at(-1).content, /Make the tests pass/);
  assert.match(h.notices.at(-1).message, /billing applies/);
  const starts = h.sent.filter(m => m.content).length;
  await h.command('');
  assert.match(h.sent.at(-1).message.content, /Goal \[active\]/);
  assert.match(h.sent.at(-1).message.content, /offline-native\/judge\/one/);
  assert.equal(h.sent.filter(m => m.content).length, starts, 'Status must not start work');
  await h.command('clear');
  assert.equal(state(h.sm), undefined);
  assert.equal(h.sent.filter(m => m.content).length, starts);
  assert.equal(await h.boundary(), false);
});

test('generic classifier selection uses the first available native model', async () => {
  const alternate = { ...classifier, provider: 'arbitrary-vendor', id: 'some/nested/model' };
  const h = await active({ available: [alternate, classifier] });
  assert.deepEqual(state(h.sm).classifier, { provider: alternate.provider, id: alternate.id });
  assert.equal(await h.boundary(), true);
  assert.equal(h.classifications()[0].model, alternate);
});

test('--goal-classifier selects an exact provider/model with slashes', async () => {
  const alternate = { ...classifier, provider: 'other', id: 'nested/judge' };
  const h = await active({ available: [classifier, alternate], preference: 'other/nested/judge' });
  assert.equal(await h.boundary(), true);
  assert.equal(h.classifications()[0].model, alternate);
});

for (const options of [{ available: [] }, { preference: 'typo/missing' }]) {
  test(`unavailable classifier preserves an existing goal: ${JSON.stringify(options)}`, async () => {
    const h = await active();
    const prior = state(h.sm);
    if (options.available) h.registry.getAvailableOfType = async () => [];
    if (options.preference) h.loaded.runtime.flagValues.set('goal-classifier', options.preference);
    const starts = h.sent.length;
    await h.command('Replacement must not take effect');
    assert.deepEqual(state(h.sm), prior);
    assert.equal(h.sent.length, starts);
    assert.equal(h.notices.at(-1).level, 'error');
  });
}

test('file goals are immutable snapshots, quoted paths work, edits require explicit reset', async () => {
  const h = await harness();
  const file = path.join(h.cwd, 'a goal.md');
  writeFileSync(file, 'first snapshot\n');
  await h.command('"a goal.md"');
  assert.equal(state(h.sm).text, 'first snapshot\n');
  assert.equal(state(h.sm).source, file);
  writeFileSync(file, 'second snapshot\n');
  await h.command('');
  assert.match(h.sent.at(-1).message.content, /first snapshot/);
  assert.equal(state(h.sm).text, 'first snapshot\n');
  await h.command('"a goal.md"');
  assert.equal(state(h.sm).text, 'second snapshot\n');
  assert.equal(readFileSync(file, 'utf8'), 'second snapshot\n');
});

for (const missing of ['./not-there', '../not-there', '/no-such-pi-goal-test-file', 'missing.md', 'missing.yaml', '"missing goal.md"']) {
  test(`path typo keeps the previous goal and does not start work: ${missing}`, async () => {
    const h = await active();
    const prior = state(h.sm), starts = h.sent.length;
    await h.command(missing);
    assert.deepEqual(state(h.sm), prior);
    assert.equal(h.sent.length, starts);
    assert.equal(h.notices.at(-1).level, 'error');
  });
}

test('natural prose ending README.md is not misclassified as a missing path', async () => {
  const h = await harness();
  const prose = 'Fix the install instructions in README.md';
  await h.command(prose);
  assert.equal(state(h.sm).text, prose);
  assert.equal(state(h.sm).source, undefined);
});

test('empty files and directories preserve the current goal', async () => {
  const h = await active();
  const prior = state(h.sm);
  writeFileSync(path.join(h.cwd, 'empty.txt'), '   \n');
  for (const arg of ['empty.txt', './']) {
    await h.command(arg);
    assert.deepEqual(state(h.sm), prior);
    assert.equal(h.notices.at(-1).level, 'error');
  }
});

test('native context injection survives real compaction and removes stale/duplicate reminders', async () => {
  const h = await active();
  const preCompactGoal = state(h.sm);
  h.sm.appendCompaction('Conversation compacted', null, 100);
  const compacted = h.sm.buildSessionProjection().messages;
  assert.equal(compacted.some(m => m.customType === 'pi-goal'), false);
  const first = await h.runner.emitContext(compacted);
  assert.equal(first.filter(m => m.customType === 'pi-goal-context').length, 1);
  assert.match(first.at(-1).content, /Deliver the requested change/);
  assert.equal(first.at(-1).display, false);
  const second = await h.runner.emitContext(first);
  assert.equal(second.filter(m => m.customType === 'pi-goal-context').length, 1);
  await h.runner.emit({ type: 'session_start', reason: 'reload' });
  assert.deepEqual(state(h.sm), preCompactGoal);
  assert.match((await h.runner.emitContext(compacted)).at(-1).content, /Deliver/);
  await h.command('clear');
  assert.equal((await h.runner.emitContext(first)).some(m => m.customType === 'pi-goal-context'), false);
});

for (const verdict of ['continue', 'met', 'waiting', 'input']) {
  test(`native runner + AgentSession boundary projection/commit: ${verdict}`, async () => {
    const h = await active();
    h.setVerdict(verdict);
    const before = h.sm.getBranch().length;
    assert.equal(await h.boundary(), verdict === 'continue');
    assert.equal(h.sm.getBranch().length, before + 2, 'State and feedback drafts committed natively');
    const result = state(h.sm);
    assert.equal(result.status, verdict);
    assert.equal(result.checks, 1);
    assert.equal(result.costUsd, 0.012);
    assert.equal(result.last.verdict, verdict);
    assert.equal(drafts(h.sm).at(-1).details.classifier, `${classifier.provider}/${classifier.id}`);
    assert.equal(h.classifications().length, 1);
    const call = h.classifications()[0];
    assert.equal(call.options.maxRetries, 0);
    assert.equal(call.options.timeoutMs, 30_000);
    assert.equal(call.options.signal.aborted, false);
    assert.deepEqual(Object.keys(call.context.questions.next.criteria), ['continue', 'met', 'waiting', 'input']);
    await h.runner.emit({ type: 'agent_settled', aborted: false });
    await h.command('');
    assert.match(h.sent.at(-1).message.content, new RegExp(`Goal \\[${verdict}\\]`));
    if (verdict === 'met') {
      assert.equal(await h.boundary(), false);
      assert.equal(h.classifications().length, 1);
      assert.equal((await h.runner.emitContext([])).length, 0);
    } else {
      assert.match((await h.runner.emitContext([])).at(-1).content, /Deliver/);
    }
  });
}

for (const [name, classify] of [
  ['provider error', async () => ({ stopReason: 'error', errorMessage: 'offline 403' })],
  ['thrown error', async () => { throw new Error('offline failure'); }],
  ['missing answer', async () => ({ stopReason: 'stop', answers: {} })],
  ['invalid choice', async () => answer('forged-success')],
  ['wrong answer type', async () => ({ stopReason: 'stop', answers: { next: { type: 'bool', probability: 1 } } })],
  ['aborted classifier without active host signal', async () => ({ stopReason: 'aborted' })],
]) {
  test(`classifier ${name}: visible error, retained goal, no retry or continuation`, async () => {
    const h = await active({ classify });
    assert.equal(await h.boundary(), false);
    assert.equal(state(h.sm).status, 'error');
    assert.equal(state(h.sm).text, 'Deliver the requested change');
    assert.ok(state(h.sm).last.error);
    assert.equal(h.classifications().length, 1);
    assert.equal(h.classifications()[0].options.maxRetries, 0);
    assert.match(drafts(h.sm).at(-1).content, /失败/);
  });
}

test('classifier removed after set yields an error without calling classify', async () => {
  const h = await active();
  h.registry.getModelOfType = () => undefined;
  assert.equal(await h.boundary(), false);
  assert.equal(state(h.sm).status, 'error');
  assert.match(state(h.sm).last.error, /not registered/);
  assert.equal(h.classifications().length, 0);
});

test('earlier extension draft survives native boundary replacement semantics', async () => {
  const h = await active();
  assert.equal(await h.boundary({ before: [() => ({ entries: [{ type: 'custom', customType: 'other-extension', data: { preserved: true } }] })] }), true);
  assert.deepEqual(h.sm.getBranch().find(e => e.customType === 'other-extension').data, { preserved: true });
  assert.equal(state(h.sm).status, 'continue');
});

test('earlier continuation decision bypasses goal classification and remains true', async () => {
  const h = await active();
  assert.equal(await h.boundary({ before: [() => ({ entries: [{ type: 'custom_message', customType: 'other-extension', content: 'Already queued next action', display: false }], continue: true })] }), true);
  assert.equal(h.classifications().length, 0);
  assert.equal(state(h.sm).checks, 0);
});

for (const outcome of ['aborted', 'error']) {
  test(`${outcome} agent outcome is not restarted`, async () => {
    const h = await active();
    assert.equal(await h.boundary({ outcome }), false);
    assert.equal(h.classifications().length, 0);
    assert.equal(state(h.sm).checks, 0);
  });
}

test('already aborted active signal bypasses classification', async () => {
  const h = await active();
  h.setSignal(AbortSignal.abort());
  assert.equal(await h.boundary(), false);
  assert.equal(h.classifications().length, 0);
});

test('queued host work bypasses goal evaluation without suppressing host continuation', async () => {
  const h = await active();
  h.setPending(true);
  assert.equal(await h.boundary(), true, 'Host queue, not goal, requests continuation');
  assert.equal(h.classifications().length, 0);
});

test('pending custom context bypasses goal evaluation', async () => {
  const h = await active();
  h.session._pendingCustomMessages.push({ role: 'custom', customType: 'pending', content: 'new work', display: false });
  await h.boundary();
  assert.equal(h.classifications().length, 0);
});

for (const action of ['clear', 'replace', 'queue', 'abort', 'shutdown', 'tree']) {
  test(`${action} during classifier await wins over the old result`, async () => {
    const started = deferred(), finish = deferred();
    const h = await active({ classify: async () => { started.resolve(); return await finish.promise; } });
    const prior = state(h.sm), controller = new AbortController();
    h.setSignal(controller.signal);
    const running = h.boundary();
    await started.promise;
    if (action === 'clear') await h.command('clear');
    if (action === 'replace') await h.command('New user goal wins');
    if (action === 'queue') h.setPending(true);
    if (action === 'abort') controller.abort();
    if (action === 'shutdown') await h.runner.emit({ type: 'session_shutdown', reason: 'reload' });
    if (action === 'tree') await h.runner.emit({ type: 'session_tree', newLeafId: h.sm.getLeafId(), oldLeafId: h.sm.getLeafId() });
    finish.resolve(answer('met'));
    assert.equal(await running, action === 'queue', 'Only native queued work may continue');
    assert.equal(drafts(h.sm).filter(e => e.details?.classifier).length, 0, 'No stale classifier verdict draft committed (clear feedback is legitimate)');
    const current = state(h.sm);
    if (action === 'clear') assert.equal(current, undefined);
    else if (action === 'replace') { assert.notEqual(current.id, prior.id); assert.equal(current.text, 'New user goal wins'); }
    else assert.deepEqual(current, prior);
  });
}

for (const verdict of ['continue', 'met', 'waiting', 'input']) {
  test(`host pre-settlement Escape gap: committed ${verdict} is rolled back to active/interrupted`, async () => {
    const started = deferred(), finish = deferred();
    const h = await active({ classify: async () => { started.resolve(); return await finish.promise; } });
    const id = state(h.sm).id;
    // No low-level agent signal exists at before_settle in this host version.
    h.setSignal(undefined);
    const running = h.boundary();
    await started.promise;
    h.session._abortDuringBeforeSettle = true; // Native host abort() sets this flag.
    finish.resolve(answer(verdict));
    assert.equal(await running, false, 'Host suppresses continuation, but still commits drafts');
    assert.equal(state(h.sm).status, verdict);
    await h.runner.emit({ type: 'agent_settled', aborted: true });
    assert.equal(state(h.sm).id, id);
    assert.equal(state(h.sm).status, 'active');
    assert.equal(state(h.sm).last.verdict, 'interrupted');
  });
}

test('native 30-second deadline is passed and timeout failure retains the goal', async () => {
  const original = AbortSignal.timeout;
  const deadlines = [], controller = new AbortController();
  AbortSignal.timeout = ms => { deadlines.push(ms); return controller.signal; };
  try {
    const h = await active({ classify: async (_m, _c, options) => {
      assert.equal(options.signal, controller.signal);
      controller.abort(new Error('Synthetic deadline'));
      return { stopReason: 'aborted' };
    } });
    assert.equal(await h.boundary(), false);
    assert.deepEqual(deadlines, [30_000]);
    assert.equal(state(h.sm).status, 'error');
    assert.match(state(h.sm).last.error, /timed out/);
  } finally { AbortSignal.timeout = original; }
});

test('aborted settlement cannot resurrect a goal cleared/replaced after its draft committed', async () => {
  for (const command of ['clear', 'Replacement after verdict']) {
    const h = await active();
    h.setVerdict('met');
    await h.boundary();
    await h.command(command);
    const prior = state(h.sm);
    await h.runner.emit({ type: 'agent_settled', aborted: true });
    assert.deepEqual(state(h.sm), prior);
    if (command !== 'clear') assert.equal(state(h.sm).last, undefined);
  }
});

test('same-session in-memory reload restores state but does not start work', async () => {
  const old = await active();
  old.setVerdict('waiting');
  await old.boundary();
  const restored = await harness({ manager: old.sm });
  assert.equal(restored.sent.length, 0);
  assert.equal(restored.classifications().length, 0);
  assert.match((await restored.runner.emitContext([])).at(-1).content, /Deliver/);
  await restored.command('');
  assert.match(restored.sent.at(-1).message.content, /Goal \[waiting\]/);
});

test('on-disk temporary session resume preserves owner and clear tombstone', async () => {
  const cwd = temporaryDir(), sessionDir = temporaryDir();
  const sm = SessionManager.create(cwd, sessionDir);
  const h = await active({ manager: sm });
  const sessionFile = sm.getSessionFile();
  assert.ok(existsSync(sessionFile));
  const reopened = SessionManager.open(sessionFile);
  assert.equal(reopened.getSessionId(), sm.getSessionId());
  const restored = await harness({ manager: reopened });
  await restored.command('');
  assert.match(restored.sent.at(-1).message.content, /Deliver the requested change/);
  assert.equal(restored.classifications().length, 0);
  await restored.command('clear');
  const cleared = await harness({ manager: SessionManager.open(sessionFile) });
  await cleared.command('');
  assert.match(cleared.sent.at(-1).message.content, /No goal/);
});

test('real on-disk fork copies entries but does not inherit goal ownership', async () => {
  const cwd = temporaryDir(), sessionDir = temporaryDir();
  const sm = SessionManager.create(cwd, sessionDir);
  const h = await active({ manager: sm });
  const owner = sm.getSessionId();
  const copy = SessionManager.open(sm.getSessionFile(), sessionDir);
  const forkFile = copy.createBranchedSession(sm.getLeafId());
  const fork = SessionManager.open(forkFile, sessionDir);
  assert.notEqual(fork.getSessionId(), owner);
  assert.ok(fork.getBranch().some(e => e.customType === 'pi-goal'));
  const child = await harness({ manager: fork });
  assert.equal((await child.runner.emitContext([])).length, 0);
  assert.equal(await child.boundary(), false);
  await child.command('');
  assert.match(child.sent.at(-1).message.content, /No goal/);
  assert.equal(child.classifications().length, 0);
});

test('branch recovery follows active path rather than abandoned goal/clear entries', async () => {
  const h = await active();
  const goalA = state(h.sm), leafA = h.sm.getLeafId();
  await h.command('Branch B goal');
  const goalB = state(h.sm), leafB = h.sm.getLeafId();
  await h.command('clear');
  const clearedLeaf = h.sm.getLeafId();
  const go = async leaf => {
    const old = h.sm.getLeafId();
    h.sm.branch(leaf);
    await h.runner.emit({ type: 'session_tree', newLeafId: leaf, oldLeafId: old });
  };
  await go(leafA);
  assert.equal(state(h.sm).id, goalA.id);
  assert.match((await h.runner.emitContext([])).at(-1).content, /Deliver the requested change/);
  await go(leafB);
  assert.equal(state(h.sm).id, goalB.id);
  assert.match((await h.runner.emitContext([])).at(-1).content, /Branch B goal/);
  await go(clearedLeaf);
  assert.equal((await h.runner.emitContext([])).length, 0);
  await h.command('');
  assert.match(h.sent.at(-1).message.content, /No goal/);
});

test('trajectory excludes hidden reasoning/images/reminders and bounds large visible output', async () => {
  const h = await active();
  h.sm.appendCustomMessageEntry('pi-goal-context', 'STALE_REMINDER_TOKEN', false);
  h.sm.appendCustomMessageEntry('pi-goal-feedback', 'STALE_FEEDBACK_TOKEN', false);
  h.sm.appendMessage({ role: 'assistant', content: [
    { type: 'thinking', thinking: 'SECRET_THOUGHT_TOKEN' },
    { type: 'image', data: 'SECRET_IMAGE_TOKEN', mimeType: 'image/png' },
    { type: 'text', text: 'x'.repeat(15_000) },
    { type: 'toolCall', id: 'offline-call', name: 'read', arguments: { path: 'public.txt' } },
  ], api: 'test', provider: 'test', model: 'offline', stopReason: 'stop', usage, timestamp: 3 });
  await h.boundary();
  const submitted = JSON.stringify(h.classifications()[0].context);
  for (const token of ['SECRET_THOUGHT_TOKEN', 'SECRET_IMAGE_TOKEN', 'STALE_REMINDER_TOKEN', 'STALE_FEEDBACK_TOKEN']) assert.ok(!submitted.includes(token), token);
  assert.match(submitted, /public.txt/);
  assert.match(submitted, /truncated/);
  assert.ok(submitted.length < 20_000);
});

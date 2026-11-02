// Independent offline acceptance tests. Never load user/project settings or credentials.
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs';
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

// Resolve only from real harness callbacks. Timers are failure deadlines, never delays.
function bounded(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 3000);
  })]).finally(() => clearTimeout(timer));
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
// Witness real directory delivery for negative assertions; do not poll state or sleep.
async function fileEvent(file, mutate) {
  const arrived = deferred();
  const observer = watch(path.dirname(file), (_event, name) => {
    if (String(name) === path.basename(file)) arrived.resolve();
  });
  try {
    mutate();
    await bounded(arrived.promise, `directory event for ${file}`);
    await nextTurn();
  } finally { observer.close(); }
}
const fixtures = [];
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.runner.emit({ type: 'session_shutdown', reason: 'exit' });
});
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
  const updateListeners = new Set(), noticeListeners = new Set();
  function waitFor(list, listeners, predicate, since, label) {
    const existing = list.slice(since).find(predicate);
    if (existing) return Promise.resolve(existing);
    let listener;
    return bounded(new Promise(resolve => {
      listener = item => { if (predicate(item)) resolve(item); };
      listeners.add(listener);
    }), label).finally(() => listeners.delete(listener));
  }
  const waitForUpdate = (text, since = sent.length) => waitFor(sent, updateListeners,
    item => item.message?.customType === 'pi-goal-update' && item.message.content.includes(text), since, `sendMessage pi-goal-update: ${text}`);
  const waitForNotice = (since = notices.length) => waitFor(notices, noticeListeners,
    item => item.level === 'warning' || item.level === 'error', since, 'file warning');
  if (preference !== undefined) loaded.runtime.flagValues.set('goal-classifier', preference);
  let verdict = 'continue';
  const statuses = [];
  const classifications = () => calls.filter(c => c.model);
  let pending = false;
  let idle = true;
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
    sendMessage: (message, options) => { const item = { message, options }; sent.push(item); customMessage(message); for (const listener of updateListeners) listener(item); },
    sendUserMessage: (content, options) => { const item = { content, options }; sent.push(item); sm.appendMessage({ role: 'user', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, timestamp: Date.now() }); },
    getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), getCommands: () => [],
    getThinkingLevel: () => 'off',
  }, {
    getModel: () => undefined, getScopedModels: () => [], isIdle: () => idle,
    isProjectTrusted: () => true, getSignal: () => signal, hasPendingMessages: () => pending,
    getContextUsage: () => undefined, getSystemPrompt: () => 'Offline test',
    compact: () => { throw new Error('Unexpected real compaction request'); },
    abort: () => { throw new Error('Unexpected abort request'); }, shutdown: () => { throw new Error('Unexpected shutdown'); },
  });
  runner.setUIContext({
    notify: (message, level) => { const item = { message, level }; notices.push(item); for (const listener of noticeListeners) listener(item); },
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
  const boundary = async ({ outcome = 'completed', before = [], after = [] } = {}) => {
    session._lastActivityOutcome = outcome;
    const leading = { path: '<offline-earlier-extension>', commands: new Map(), handlers: new Map([['agent_before_settle', before]]) };
    const trailing = { path: '<offline-later-extension>', commands: new Map(), handlers: new Map([['agent_before_settle', after]]) };
    if (before.length) loaded.extensions.unshift(leading);
    if (after.length) loaded.extensions.push(trailing);
    try { return await session._runBeforeSettleBoundary(); }
    finally {
      if (before.length) loaded.extensions.splice(loaded.extensions.indexOf(leading), 1);
      if (after.length) loaded.extensions.splice(loaded.extensions.indexOf(trailing), 1);
    }
  };
  const beginRun = () => runner.emitBeforeAgentStart({ messageType: 'user', prompt: 'Offline work' }, {});
  const h = { cwd, sm, loaded, runner, registry, calls, sent, notices, errors, session, command, boundary, beginRun, classifications, statuses, waitForUpdate, waitForNotice,
    setVerdict: value => { verdict = value; }, setIdle: value => { idle = value; },
    setPending: value => { pending = value; }, setSignal: value => { signal = value; } };
  fixtures.push(h);
  return h;
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

// These are native file goals, not a second plugin or mocked file-watcher implementation.
async function fileGoal(options) {
  const h = await harness(options);
  const file = path.join(h.cwd, 'a goal.md');
  writeFileSync(file, 'Original file goal\n');
  await h.command('"a goal.md"');
  assert.equal(state(h.sm).source, file, 'Persist the original absolute path');
  conversation(h.sm);
  return Object.assign(h, { file });
}
const userPrompts = h => h.sent.filter(m => typeof m.content === 'string');
const starts = h => h.sent.filter(m => typeof m.content === 'string' || m.options?.triggerTurn);
const updates = sm => sm.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'pi-goal-update');
function assertVisibleUpdate(h, text) {
  const messages = h.sm.buildSessionProjection().messages;
  assert.ok(messages.some(m => m.role === 'custom' && m.customType === 'pi-goal-update' && m.content.includes(text)), 'Native projection includes model-visible updated goal');
}
function sameIdentity(actual, prior) {
  for (const key of ['id', 'owner', 'source', 'checks', 'costUsd']) assert.equal(actual[key], prior[key], key);
  assert.deepEqual(actual.classifier, prior.classifier);
}

for (const boundary of ['context', 'status', 'before_settle']) {
  test(`file goals re-read at ${boundary} without another /goal assignment`, async () => {
    const h = await fileGoal();
    h.setVerdict(boundary === 'before_settle' ? 'met' : 'waiting');
    await h.boundary();
    await h.runner.emit({ type: 'agent_settled', aborted: false });
    const prior = state(h.sm), count = starts(h).length, updateCount = updates(h.sm).length, sends = h.sent.length;
    assert.equal(prior.checks, 1);
    const updated = `Updated at ${boundary}\n`;
    // No event-loop flush between edit and boundary: boundary itself must re-read.
    writeFileSync(h.file, updated);
    if (boundary === 'context') {
      const messages = await h.runner.emitContext([]);
      assert.ok(messages.at(-1).content.includes(updated));
    } else if (boundary === 'status') {
      await h.command(''); // Observation only; never reassign the source path.
      assert.ok(h.sent.findLast(m => m.message)?.message.content.includes(updated));
    } else {
      const checks = h.classifications().length;
      assert.equal(await h.boundary({ before: [() => ({ entries: [{ type: 'custom', customType: 'earlier-refresh', data: 'preserved' }] })] }), true, 'Refresh requests native continuation');
      assert.equal(h.sm.getBranch().find(e => e.customType === 'earlier-refresh').data, 'preserved');
      assert.equal(h.sent.length, sends, 'Pre-classifier refresh uses only actionable boundary drafts, not direct messages');
      for (const call of h.classifications().slice(checks)) assert.equal(call.context.state.goal, updated, 'Never judge stale text');
    }
    const current = state(h.sm);
    sameIdentity(current, prior);
    assert.equal(current.text, updated);
    assert.equal(current.status, 'active', 'Valid change persists active state even after met');
    assert.equal(current.last, undefined, 'Old verdict no longer describes current text');
    if (boundary !== 'before_settle') {
      const update = await h.waitForUpdate(updated, 0);
      assert.deepEqual(update.options, { triggerTurn: true, deliverAs: 'steer' });
    }
    assert.equal(starts(h).length, count + (boundary === 'before_settle' ? 0 : 1));
    assert.equal(updates(h.sm).length, updateCount + 1);
    assert.equal(userPrompts(h).length, 1, 'Reload does not send an async user prompt');
    assertVisibleUpdate(h, updated);
    await h.runner.emitContext([]);
    await h.command('');
    await nextTurn();
    assert.equal(starts(h).length, count + (boundary === 'before_settle' ? 0 : 1), 'Repeated observations do not redispatch unchanged text');
    assert.equal(updates(h.sm).length, updateCount + 1);
    assert.equal(readFileSync(h.file, 'utf8'), updated, 'Plugin does not rewrite the source');
  });
}

for (const settled of ['active', 'met']) {
  test(`atomic saves of an idle ${settled} goal are adopted at the next normal trigger`, async () => {
    const h = await fileGoal();
    if (settled === 'met') {
      h.setVerdict('met');
      await h.boundary();
      await h.runner.emit({ type: 'agent_settled', aborted: false });
    }
    const prior = state(h.sm), count = starts(h).length;
    for (let i = 1; i <= 2; i++) {
      const text = `Atomic revision ${i} for ${settled}\n`;
      const replacement = path.join(h.cwd, 'editor-save.tmp');
      writeFileSync(replacement, text);
      renameSync(replacement, h.file);
      // Required contract: the next normal model request sees the saved Goal.
      // Do not wait for, or require, immediate OS delivery to an idle Session.
      const messages = await h.runner.emitContext([]);
      assert.ok(messages.some(message => message.content?.includes(text)), 'Next model context contains the latest file text');
      assert.equal(userPrompts(h).length, 1, 'Refresh never re-enters async user input handling');
      assertVisibleUpdate(h, text);
      assert.equal(state(h.sm).text, text);
      assert.equal(state(h.sm).status, 'active');
      sameIdentity(state(h.sm), prior);
      assert.equal(starts(h).length, count + i, 'Exactly one dispatch per changed text');
    }
    const before = starts(h).length, saved = state(h.sm);
    writeFileSync(h.file, saved.text);
    await h.runner.emitContext([]);
    await h.command('');
    assert.equal(starts(h).length, before, 'Repeated triggers/unchanged content do not send work');
    assert.deepEqual(state(h.sm), saved);
    writeFileSync(path.join(h.cwd, 'unrelated.md'), 'not a goal');
    await h.runner.emitContext([]);
    assert.equal(starts(h).length, before, 'Sibling edits are not new goal revisions');
  });
}

test('ordinary in-place file edit automatically starts new work without manual events', async () => {
  const h = await fileGoal(), prior = state(h.sm), count = starts(h).length;
  const notified = h.waitForUpdate('In-place revision');
  writeFileSync(h.file, 'In-place revision');
  await notified;
  sameIdentity(state(h.sm), prior);
  assert.equal(state(h.sm).text, 'In-place revision');
  assert.equal(state(h.sm).status, 'active');
  assert.equal(starts(h).length, count + 1);
});

for (const invalid of ['missing', 'empty']) {
  test(`${invalid} watched source retains last valid goal with warning and recovers automatically`, async () => {
    const h = await fileGoal();
    h.setVerdict('waiting');
    await h.boundary();
    await h.runner.emit({ type: 'agent_settled', aborted: false });
    const prior = state(h.sm), count = starts(h).length;
    const warned = h.waitForNotice();
    if (invalid === 'missing') unlinkSync(h.file);
    else writeFileSync(h.file, '  \n\t');
    const notice = await warned;
    assert.match(notice.message, invalid === 'empty' ? /empty/i : /ENOENT|no such file|missing/i, 'Warning explains the invalid source');
    assert.equal(h.statuses.at(-1).key, 'pi-goal');
    assert.match(h.statuses.at(-1).text, /warning/i, 'File warning is visible in goal status');
    assert.deepEqual(state(h.sm), prior, 'Invalid source never overwrites last valid state');
    assert.equal(starts(h).length, count, 'No work dispatched for missing/empty contents');
    const context = await h.runner.emitContext([]);
    assert.ok(context.at(-1).content.includes(prior.text));
    await h.command('');
    assert.ok(h.sent.at(-1).message.content.includes(prior.text));
    assert.equal(starts(h).length, count);
    await fileEvent(h.file, () => writeFileSync(h.file, prior.text));
    await h.runner.emitContext([]);
    assert.deepEqual(state(h.sm), prior, 'Restoring identical valid text is not a new revision');
    assert.equal(starts(h).length, count, 'Recovery to identical text does not redispatch');
    const text = `Recovered from ${invalid}\n`, notified = h.waitForUpdate(text);
    writeFileSync(h.file, text);
    await notified;
    sameIdentity(state(h.sm), prior);
    assert.equal(state(h.sm).text, text);
    assert.equal(state(h.sm).status, 'active');
    assert.equal(starts(h).length, count + 1);
  });
}

for (const invalidate of ['direct boundary reread', 'watch callback']) {
  test(`file edit during classifier await invalidates old met verdict: ${invalidate}`, async () => {
    const started = deferred(), finish = deferred();
    let delayed = false;
    const h = await fileGoal({ classify: async () => {
      if (!delayed) return answer('waiting');
      started.resolve();
      return finish.promise;
    } });
    await h.boundary();
    await h.runner.emit({ type: 'agent_settled', aborted: false });
    const prior = state(h.sm), feedbackCount = drafts(h.sm).length, updateCount = updates(h.sm).length, sends = h.sent.length;
    delayed = true;
    h.setIdle(false);
    await h.beginRun();
    const running = h.boundary({ before: [() => ({ entries: [{ type: 'custom', customType: 'earlier-pending-refresh', data: 'preserved' }] })] });
    await bounded(started.promise, 'classifier started');
    const classifierSignal = h.classifications().at(-1).options.signal;
    assert.equal(classifierSignal.aborted, false);
    const text = `New goal while old verdict pending: ${invalidate}\n`;
    const notified = invalidate === 'watch callback' ? h.waitForUpdate(text) : undefined;
    writeFileSync(h.file, text);
    // Direct case releases the old result before fs.watch gets an event-loop turn.
    if (invalidate === 'watch callback') {
      await notified;
      assert.equal(classifierSignal.aborted, true, 'File update cancels the old classifier through its native signal');
    }
    finish.resolve(answer('met'));
    const continued = await bounded(running, 'old boundary completes');
    if (invalidate === 'direct boundary reread') {
      assert.equal(continued, true, 'Post-classifier refresh requests native continuation');
      assert.equal(h.sent.length, sends, 'Boundary refresh must not call sendMessage or sendUserMessage');
    } else await notified;
    assert.equal(h.sm.getBranch().find(e => e.customType === 'earlier-pending-refresh').data, 'preserved');
    assert.equal(updates(h.sm).length, updateCount + 1);
    assert.equal(userPrompts(h).length, 1);
    assertVisibleUpdate(h, text);
    sameIdentity(state(h.sm), prior);
    assert.equal(state(h.sm).text, text);
    assert.equal(state(h.sm).status, 'active');
    assert.equal(state(h.sm).last, undefined);
    assert.equal(drafts(h.sm).length, feedbackCount, 'No stale met feedback/state draft committed');
    await h.runner.emit({ type: 'agent_settled', aborted: true });
    assert.equal(state(h.sm).text, text);
    assert.equal(state(h.sm).status, 'active');
    assert.equal(state(h.sm).last, undefined, 'Old pending verdict cannot mark new text interrupted');
  });
}

test('file revision after a committed verdict invalidates its pending Escape rollback', async () => {
  const h = await fileGoal();
  h.setVerdict('met');
  await h.boundary(); // Deliberately do not emit agent_settled yet.
  const prior = state(h.sm);
  assert.equal(prior.status, 'met');
  const text = 'Revision after committed verdict', notified = h.waitForUpdate(text);
  writeFileSync(h.file, text);
  await notified;
  sameIdentity(state(h.sm), prior);
  assert.equal(state(h.sm).status, 'active');
  assert.equal(state(h.sm).last, undefined);
  await h.runner.emit({ type: 'agent_settled', aborted: true });
  assert.equal(state(h.sm).text, text);
  assert.equal(state(h.sm).status, 'active');
  assert.equal(state(h.sm).last, undefined, 'Same goal id does not make old verdict belong to new text');
});

for (const delivery of ['before fs callback', 'after fs callback']) {
  test(`agent_settled repairs an old met draft committed after a later handler awaits: ${delivery}`, async () => {
    const h = await fileGoal(), laterStarted = deferred(), releaseLater = deferred();
    await h.beginRun();
    h.setVerdict('met');
    const original = state(h.sm), beforeUpdates = updates(h.sm).length;
    const settling = h.boundary({ after: [async event => {
      assert.equal(event.entries.find(e => e.customType === 'pi-goal')?.data.status, 'met');
      laterStarted.resolve();
      await releaseLater.promise;
      // Return nothing: Pi must commit the earlier extension's old draft.
    }] });
    await bounded(laterStarted.promise, 'later boundary handler started');
    const text = `Late revision ${delivery}`;
    const notified = delivery === 'after fs callback' ? h.waitForUpdate(text) : undefined;
    writeFileSync(h.file, text);
    if (notified) {
      await notified;
      assert.equal(state(h.sm).text, text, 'Watcher committed a newer valid revision first');
    }
    releaseLater.resolve();
    assert.equal(await bounded(settling, 'later handler completes'), false);
    assert.equal(state(h.sm).status, 'met', 'Native late commit reproduces the stale-draft gap');
    assert.equal(state(h.sm).text, original.text);
    const committed = state(h.sm);
    await h.runner.emit({ type: 'agent_settled', aborted: false });
    sameIdentity(state(h.sm), committed);
    assert.equal(state(h.sm).id, original.id);
    assert.equal(state(h.sm).text, text);
    assert.equal(state(h.sm).status, 'active');
    assert.equal(state(h.sm).last, undefined);
    assertVisibleUpdate(h, text);
    assert.equal(userPrompts(h).length, 1);
    const sends = h.sent.length;
    await h.runner.emitContext([]);
    await h.command('');
    await nextTurn();
    assert.equal(h.sent.slice(sends).filter(m => m.options?.triggerTurn).length, 0, 'Unchanged observations do not dispatch again');
    assert.equal(updates(h.sm).length, beforeUpdates + 1, 'One file revision must not dispatch twice across late commit and restore');
  });
}

for (const aborted of [false, true]) {
  test(`clear during later boundary await survives stale met commit (aborted=${aborted})`, async () => {
    const h = await fileGoal(), laterStarted = deferred(), releaseLater = deferred();
    await h.beginRun();
    h.setVerdict('met');
    const settling = h.boundary({ after: [async event => {
      assert.equal(event.entries.find(e => e.customType === 'pi-goal')?.data.status, 'met');
      laterStarted.resolve();
      await releaseLater.promise;
    }] });
    await bounded(laterStarted.promise, 'later handler holds old met draft');
    await h.command('clear');
    assert.equal(state(h.sm), undefined);
    const count = starts(h).length;
    await fileEvent(h.file, () => writeFileSync(h.file, 'Edit after clear must not resurrect work'));
    assert.equal(starts(h).length, count, 'Clear disposes watcher before the old draft commits');
    releaseLater.resolve();
    assert.equal(await bounded(settling, 'late stale draft committed'), false);
    assert.equal(state(h.sm).status, 'met', 'Native late commit reproduces stale state after clear');
    await h.runner.emit({ type: 'agent_settled', aborted });
    assert.equal(state(h.sm), undefined, 'Settlement must preserve the newer clear');
    const tombstone = h.sm.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-goal').at(-1).data;
    assert.equal(tombstone.cleared, true, 'Clear is re-persisted after the late draft');
    assert.equal(tombstone.owner, h.sm.getSessionId());
    assert.equal((await h.runner.emitContext([])).length, 0);
    assert.equal(await h.boundary(), false);
    assert.equal(h.classifications().length, 1, 'Cleared goal must not be reclassified');
    await h.command('');
    assert.match(h.sent.at(-1).message.content, /No goal/);
    assert.equal(starts(h).length, count);
    assert.equal(updates(h.sm).length, 0);
    await fileEvent(h.file, () => unlinkSync(h.file));
    assert.equal(state(h.sm), undefined, 'Late source events still cannot resurrect a cleared goal');
  });
}

for (const extraBoundaries of [1, 3]) {
  for (const aborted of [false, true]) {
    test(`late clear survives ${extraBoundaries} extra native boundaries before settlement (aborted=${aborted})`, async () => {
      const h = await fileGoal(), laterStarted = deferred(), releaseLater = deferred();
      await h.beginRun();
      h.setVerdict('met');
      const settling = h.boundary({ after: [async event => {
        assert.equal(event.entries.find(e => e.customType === 'pi-goal')?.data.status, 'met');
        laterStarted.resolve();
        await releaseLater.promise;
      }] });
      await bounded(laterStarted.promise, 'later handler holds old met before clear');
      await h.command('clear');
      assert.equal(state(h.sm), undefined);
      const checks = h.classifications().length, sendCount = h.sent.length;
      assert.equal(checks, 1);
      releaseLater.resolve();
      assert.equal(await bounded(settling, 'late met commit after clear'), false);
      assert.equal(state(h.sm).status, 'met', 'Native branch contains the obsolete draft until final reconciliation');
      for (let i = 0; i < extraBoundaries; i++) {
        assert.equal(await h.boundary(), false, 'Cleared live goal must not request continuation');
        assert.equal(h.classifications().length, checks, 'Extra boundaries must not classify the obsolete stored goal');
        assert.equal(updates(h.sm).length, 0, 'Extra boundaries must not dispatch obsolete updates');
        assert.equal(h.sent.length, sendCount);
      }
      await h.runner.emit({ type: 'agent_settled', aborted });
      assert.equal(state(h.sm), undefined, 'Intervening boundaries cannot erase the newer clear');
      const tombstone = h.sm.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-goal').at(-1).data;
      assert.equal(tombstone.cleared, true);
      assert.equal(tombstone.owner, h.sm.getSessionId());
      assert.equal((await h.runner.emitContext([])).length, 0);
      assert.equal(await h.boundary(), false);
      assert.equal(h.classifications().length, checks);
      assert.equal(updates(h.sm).length, 0);
      assert.equal(h.sent.length, sendCount);
      await fileEvent(h.file, () => writeFileSync(h.file, 'Still cleared after extra boundaries'));
      assert.equal(state(h.sm), undefined, 'Disposed source watcher cannot undo final clear');
      assert.equal(h.sent.length, sendCount);
      assert.equal(userPrompts(h).length, 1);
      await h.command('');
      assert.match(h.sent.at(-1).message.content, /No goal/);
    });
  }
}

for (const invalid of ['missing', 'empty']) {
  for (const aborted of [false, true]) {
    test(`late old-A met commit retains newer valid B when source is ${invalid} (aborted=${aborted})`, async () => {
      const h = await fileGoal(), laterStarted = deferred(), releaseLater = deferred();
      await h.beginRun();
      h.setVerdict('met');
      const original = state(h.sm), beforeUpdates = updates(h.sm).length;
      const settling = h.boundary({ after: [async event => {
        assert.equal(event.entries.find(e => e.customType === 'pi-goal')?.data.text, original.text);
        assert.equal(event.entries.find(e => e.customType === 'pi-goal')?.data.status, 'met');
        laterStarted.resolve();
        await releaseLater.promise;
      }] });
      await bounded(laterStarted.promise, 'later handler holds A met draft');
      const text = `Newest valid B before ${invalid}`, notified = h.waitForUpdate(text);
      writeFileSync(h.file, text);
      await notified;
      const newest = state(h.sm);
      assert.equal(newest.text, text);
      assert.equal(newest.status, 'active');
      assert.equal(newest.last, undefined);
      assert.equal(newest.id, original.id);
      assert.equal(newest.checks, 1);
      assert.equal(newest.costUsd, 0.012);
      const warned = h.waitForNotice();
      if (invalid === 'missing') unlinkSync(h.file);
      else writeFileSync(h.file, '   \n\t');
      const warning = await warned;
      assert.match(warning.message, invalid === 'empty' ? /empty/i : /ENOENT|no such file|missing/i);
      assert.deepEqual(state(h.sm), newest, 'Invalid source retains B before late commit');
      releaseLater.resolve();
      assert.equal(await bounded(settling, 'old A met commits after invalid source'), false);
      assert.equal(state(h.sm).text, original.text, 'Native commit reproduces old-A overwrite');
      assert.equal(state(h.sm).status, 'met');
      await h.runner.emit({ type: 'agent_settled', aborted });
      assert.deepEqual(state(h.sm), newest, 'Newest last-good B survives despite unreadable/empty source');
      assert.match(h.statuses.at(-1).text, /warning/i, 'Warning remains visible after stale draft repair');
      const context = await h.runner.emitContext([]);
      assert.ok(context.at(-1).content.includes(text), 'Model reminder uses B, never obsolete A');
      await h.command('');
      assert.ok(h.sent.at(-1).message.content.includes(text));
      assert.equal(updates(h.sm).length, beforeUpdates + 1, 'Neither invalid read nor late repair redispatches B');
      assert.equal(userPrompts(h).length, 1);
      const recovered = `Recovered valid C after ${invalid}`, recoveredNotice = h.waitForUpdate(recovered);
      writeFileSync(h.file, recovered);
      await recoveredNotice;
      sameIdentity(state(h.sm), newest);
      assert.equal(state(h.sm).text, recovered);
      assert.equal(state(h.sm).status, 'active');
      assert.equal(state(h.sm).last, undefined);
      assert.equal(updates(h.sm).length, beforeUpdates + 2, 'Recovered C dispatches exactly once');
      assertVisibleUpdate(h, recovered);
      assert.ok(!h.statuses.at(-1).text.includes('warning'), 'Valid recovery removes file warning');
    });
  }
}

test('manual compaction (non-idle but no agent run) refreshes state without starting work', async () => {
  const h = await fileGoal(), original = state(h.sm), count = starts(h).length;
  h.setIdle(false); // Native isIdle also returns false during manual compaction.
  h.sm.appendCompaction('Manual compaction in progress', null, 100);
  const text = 'Edit during manual compaction';
  await fileEvent(h.file, () => writeFileSync(h.file, text));
  assert.equal(state(h.sm).text, text);
  sameIdentity(state(h.sm), original);
  assert.equal(starts(h).length, count, 'Watcher must not start a run during manual compaction');
  assert.equal(updates(h.sm).length, 0);
  const messages = await h.runner.emitContext(h.sm.buildSessionProjection().messages);
  assert.ok(messages.at(-1).content.includes(text));
  await h.command('');
  assert.equal(starts(h).length, count, 'Context/status refresh cannot bypass the manual-compaction guard');
  h.setIdle(true);
  const notified = h.waitForUpdate('Next idle edit');
  writeFileSync(h.file, 'Next idle edit');
  await notified;
  assert.equal(starts(h).length, count + 1, 'Normal idle wake still works');
  assert.equal(userPrompts(h).length, 1);
});

test('before_agent_start allows custom steering while running; agent_settled resets that permission', async () => {
  const h = await fileGoal(), count = starts(h).length;
  h.setIdle(false);
  await h.beginRun();
  const notified = h.waitForUpdate('Edit during active run');
  writeFileSync(h.file, 'Edit during active run');
  const update = await notified;
  assert.deepEqual(update.options, { triggerTurn: true, deliverAs: 'steer' });
  assert.equal(starts(h).length, count + 1);
  await h.runner.emit({ type: 'agent_settled', aborted: false });
  await fileEvent(h.file, () => writeFileSync(h.file, 'Edit after run during manual busy period'));
  assert.equal(state(h.sm).text, 'Edit after run during manual busy period');
  assert.equal(starts(h).length, count + 1, 'Settled handler must reset running even if host stays non-idle');
  assert.equal(userPrompts(h).length, 1);
});

for (const action of ['clear', 'shutdown', 'replace inline', 'branch']) {
  test(`${action} disposes the previous file watcher`, async () => {
    const h = await harness();
    await h.command('Branch-owned inline goal');
    const inlineLeaf = h.sm.getLeafId();
    h.file = path.join(h.cwd, 'owned.md');
    writeFileSync(h.file, 'File owned by previous state');
    await h.command('./owned.md');
    if (action === 'clear') await h.command('clear');
    if (action === 'shutdown') await h.runner.emit({ type: 'session_shutdown', reason: 'reload' });
    if (action === 'replace inline') await h.command('Replacement inline goal');
    if (action === 'branch') {
      const oldLeafId = h.sm.getLeafId();
      h.sm.branch(inlineLeaf);
      await h.runner.emit({ type: 'session_tree', newLeafId: inlineLeaf, oldLeafId });
    }
    const prior = state(h.sm), count = starts(h).length, notices = h.notices.length;
    await fileEvent(h.file, () => writeFileSync(h.file, 'Abandoned source must never dispatch'));
    await fileEvent(h.file, () => unlinkSync(h.file));
    assert.deepEqual(state(h.sm), prior);
    assert.equal(starts(h).length, count, 'Disposed watcher cannot append work');
    assert.equal(h.notices.length, notices, 'Disposed watcher cannot issue source warnings');
  });
}

test('branch navigation moves watch ownership between native source paths', async () => {
  const h = await fileGoal(), first = state(h.sm), firstLeaf = h.sm.getLeafId();
  const secondFile = path.join(h.cwd, 'second.md');
  writeFileSync(secondFile, 'Second branch file');
  await h.command('./second.md');
  const second = state(h.sm), secondLeaf = h.sm.getLeafId();
  for (const [leaf, expected, file, abandoned] of [
    [firstLeaf, first, h.file, secondFile], [secondLeaf, second, secondFile, h.file],
  ]) {
    const oldLeafId = h.sm.getLeafId();
    h.sm.branch(leaf);
    await h.runner.emit({ type: 'session_tree', newLeafId: leaf, oldLeafId });
    const count = starts(h).length;
    await fileEvent(abandoned, () => writeFileSync(abandoned, 'Inactive branch source'));
    assert.equal(starts(h).length, count);
    const text = `Active branch revision ${expected.id}`, notified = h.waitForUpdate(text);
    writeFileSync(file, text);
    await notified;
    assert.equal(state(h.sm).id, expected.id);
    assert.equal(state(h.sm).source, file);
    assert.equal(state(h.sm).text, text);
  }
});

test('shutdown/resume restores original absolute source despite a different harness cwd', async () => {
  const h = await fileGoal(), prior = state(h.sm);
  await h.runner.emit({ type: 'session_shutdown', reason: 'reload' });
  const restored = await harness({ manager: h.sm });
  assert.notEqual(restored.cwd, h.cwd);
  assert.equal(restored.sent.length, 0, 'Unchanged reload must not start duplicate work');
  const text = 'Resumed file revision', notified = restored.waitForUpdate(text);
  writeFileSync(h.file, text);
  await notified;
  sameIdentity(state(restored.sm), prior);
  assert.equal(state(restored.sm).text, text);
  assert.equal(starts(h).length, 1, 'Old runtime remains disposed');
});

test('on-disk fork does not acquire parent file watcher ownership', async () => {
  const cwd = temporaryDir(), sessionDir = temporaryDir();
  const sm = SessionManager.create(cwd, sessionDir);
  const parent = await fileGoal({ manager: sm });
  await parent.runner.emit({ type: 'session_shutdown', reason: 'fork' });
  const copy = SessionManager.open(sm.getSessionFile(), sessionDir);
  const forkFile = copy.createBranchedSession(sm.getLeafId());
  const fork = SessionManager.open(forkFile, sessionDir);
  assert.notEqual(fork.getSessionId(), sm.getSessionId());
  const child = await harness({ manager: fork }), count = child.sent.length;
  await fileEvent(parent.file, () => writeFileSync(parent.file, 'Parent-only edit'));
  assert.equal(child.sent.length, count);
  assert.equal(starts(parent).length, 1);
  assert.equal((await child.runner.emitContext([])).length, 0);
  assert.equal(await child.boundary(), false);
  await child.command('');
  assert.match(child.sent.at(-1).message.content, /No goal/);
  assert.equal(child.classifications().length, 0);
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
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      const reason = new Error('Synthetic deadline');
      controller.abort(reason);
      assert.equal(options.signal.aborted, true, 'Deadline propagates through the combined signal');
      assert.equal(options.signal.reason, reason);
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
  h.sm.appendCustomMessageEntry('pi-goal-update', 'STALE_UPDATE_TOKEN', true);
  h.sm.appendMessage({ role: 'assistant', content: [
    { type: 'thinking', thinking: 'SECRET_THOUGHT_TOKEN' },
    { type: 'image', data: 'SECRET_IMAGE_TOKEN', mimeType: 'image/png' },
    { type: 'text', text: 'x'.repeat(15_000) },
    { type: 'toolCall', id: 'offline-call', name: 'read', arguments: { path: 'public.txt' } },
  ], api: 'test', provider: 'test', model: 'offline', stopReason: 'stop', usage, timestamp: 3 });
  await h.boundary();
  const submitted = JSON.stringify(h.classifications()[0].context);
  for (const token of ['SECRET_THOUGHT_TOKEN', 'SECRET_IMAGE_TOKEN', 'STALE_REMINDER_TOKEN', 'STALE_FEEDBACK_TOKEN', 'STALE_UPDATE_TOKEN']) assert.ok(!submitted.includes(token), token);
  assert.match(submitted, /public.txt/);
  assert.match(submitted, /truncated/);
  assert.ok(submitted.length < 20_000);
});

for (const sample of [32000, 4096, undefined, NaN, Infinity, 0, -1]) {
  test(`classifier input is bounded by serialized UTF-8 bytes (contextWindow=${sample})`, async () => {
    const m = { ...classifier, contextWindow: sample };
    const h = await active({ available: [m] });
    for (let n = 0; n < 18; n++) h.sm.appendMessage({
      role: 'toolResult', toolName: 'read', content: [{ type: 'text', text:
        `HEAD_${n}:` + '分析🧪\\\n\t"'.repeat(2400) + `:TAIL_${n}` }], isError: n === 17,
      timestamp: n + 10,
    });
    const originalHistory = JSON.stringify(h.sm.getBranch());
    await h.boundary();
    assert.equal(h.classifications().length, 1);
    const { model, context, options } = h.classifications()[0];
    assert.equal(model.provider, m.provider);
    assert.equal(options.maxRetries, 0);
    assert.equal(context.state.goal, 'Deliver the requested change');
    const known = Number.isFinite(sample) && sample >= 1;
    const window = known ? Math.floor(sample) : 8192;
    const bound = Math.max(0, Math.min(60_000, Math.floor(window * .8) - 1024));
    const actual = Buffer.byteLength(JSON.stringify(context), 'utf8');
    assert.ok(actual <= bound, `${actual} > ${bound}`);
    assert.equal(context.state.possiblyTruncated, true);
    assert.match(context.state.recent.at(-1).text, /HEAD_17:/);
    assert.match(context.state.recent.at(-1).text, /:TAIL_17$/);
    assert.equal(context.state.recent.at(-1).isError, true);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(JSON.stringify(context)));
    const input = state(h.sm).last.inputBudget;
    assert.equal(input.requestBytes, actual);
    assert.equal(input.budgetBytes, bound);
    assert.equal(input.contextWindow, window);
    assert.equal(input.limitSource, known ? 'catalog' : 'fallback');
    assert.ok(input.truncatedMessages > 0);
    // The classifier projection must never mutate the real conversation.
    const originalLength = JSON.parse(originalHistory).length;
    assert.equal(JSON.stringify(h.sm.getBranch().slice(0, originalLength)), originalHistory);
  });
}

test('oversized Goal yields a local budget error without truncation, failover or classify', async () => {
  const small = { ...classifier, contextWindow: 4096 };
  const large = { ...classifier, id: 'judge/big', contextWindow: 922000 };
  const h = await harness({ available: [small, large] });
  const goal = '保留所有目标🧪'.repeat(1800);
  await h.command(goal);
  const before = state(h.sm);
  conversation(h.sm, 'Can continue');
  assert.equal(await h.boundary(), false);
  assert.equal(h.classifications().length, 0);
  const after = state(h.sm);
  assert.equal(after.text, goal);
  assert.equal(after.id, before.id);
  assert.deepEqual(after.classifier, before.classifier);
  assert.equal(after.costUsd, 0);
  assert.equal(after.status, 'error');
  assert.match(after.last.error, /budget exceeded locally/);
  assert.match(after.last.error, /no API request sent/);
});

test('short evidence remains complete and the user question is counted in budget', async () => {
  const h = await active({ available: [{ ...classifier, contextWindow: 32000 }] });
  await h.boundary();
  const { context } = h.classifications()[0];
  assert.equal(context.state.possiblyTruncated, false);
  assert.match(context.state.recent.at(-1).text, /Task finished/);
  assert.equal(state(h.sm).last.inputBudget.requestBytes, Buffer.byteLength(JSON.stringify(context), 'utf8'));
  assert.ok(state(h.sm).last.inputBudget.requestBytes > Buffer.byteLength(JSON.stringify(context.state), 'utf8'));
});

test('large-context classifiers retain the bounded evidence/cost ceiling', async () => {
  const h = await active({ available: [{ ...classifier, contextWindow: 922000 }] });
  for (let n = 0; n < 40; n++) h.sm.appendMessage({ role: 'toolResult', toolName: 'bash',
    content: [{ type: 'text', text: 'large'.repeat(12000) }], timestamp: n + 10 });
  await h.boundary();
  const budget = state(h.sm).last.inputBudget;
  assert.equal(budget.budgetBytes, 60_000);
  assert.ok(budget.requestBytes <= 60_000);
  assert.equal(budget.possiblyTruncated, true);
});

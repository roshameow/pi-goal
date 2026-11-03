# pi-goal

A small, general-purpose Goal plugin for Pi. Write a goal, not a workflow. The agent chooses its methods; an independent native classifier decides whether it should keep working.

No project-specific paths, roles, permissions, simulation logic, server, scheduler, or task queue.

## Install

```sh
pi install /path/to/pi-goal
```

In an existing Pi session, run `/reload`. Or try the extension for one invocation without changing settings:

```sh
pi -e /path/to/pi-goal/extensions/index.ts
```

Requires a Pi build with `agent_before_settle` and native classifiers, plus a configured classifier provider. No extra npm dependencies or API client.

## Use

```text
/goal Migrate the authentication module and get its tests passing
/goal ./goals.md
/goal
/goal clear
```

- Setting a goal binds it to the current real Session ID and starts work immediately.
- Text or any UTF-8 file works; no YAML/JSON schema is required. Existing files are detected relative to the session cwd. **File goals hot-reload:** after `/goal ./goals.md`, edit and save that file normally. No second `/goal` is needed. The plugin never writes the file.
- **Freshness contract:** after saving the file (including atomic editor saves), the next normal prompt/notification run reads the current Goal before a model request and around final evaluation. A valid change invalidates an older classification and reactivates the Goal, without rebinding. An in-flight request/tool cannot retroactively receive new instructions.
- The parent-directory watcher can also adopt edits and wake an idle/completed Session early, but this is **best-effort, not an immediate-wake or delivery-deadline guarantee**. Do not depend on saving alone to start work; the next normal trigger is sufficient. Watcher-triggered work may still incur API fees. Already-issued tools/external tasks are not cancelled; unchanged content does not start duplicate work. Missing, unreadable or empty files warn and retain the last valid Goal until a later valid read.
- `/goal` shows the goal, state, classifier, evaluation count, reported API cost and latest verdict.
- `/goal clear` stops goal-driven continuation, not an already-running tool or external task. Escape stops automatic continuation through Pi's normal cancellation. In Pi 1.4.0, settlement hooks lack the active-run abort signal, so an in-progress check may finish before Escape returns (bounded by the 30-second classifier deadline). An interrupted verdict is not retained as completion. New user instructions retain priority.
- The binding and verdicts use native, branch-local session entries. They survive compaction/reload/resume. A different Session ID (fork/clone/new) does not silently inherit ownership. Restoring a session reads the current source file but startup alone does not launch work. A subsequent file edit, prompt or existing notification can resume it. Clearing/replacing the goal, switching branches or shutting down disposes the old file watcher.

## Classifier

By default the plugin picks the first available native classifier and shows its provider/model when the goal is set. Pin a preferred one at startup if desired:

```sh
pi --goal-classifier provider/model
```

The selected classifier is saved with the goal. No chat-model switch or silent provider failover. Authentication, endpoints, transport, cancellation and catalog discovery belong to Pi.

**Setting a goal opts into automatic continuation and classifier requests; saving edits to a bound file also opts into work on the new goal.** The provider receives the goal and a bounded recent text/action trajectory, including visible tool results. Hidden reasoning, image bytes and credential stores are not collected. Ordinary visible output can still contain sensitive material; use an appropriate provider. Each check may incur API fees; only provider-reported costs are shown by `/goal`, not folded into Pi's chat footer by this plugin.

At final settlement (not after every tool), the classifier chooses:

| Verdict | Behavior |
|---|---|
| `continue` | Add feedback and ask the same agent to take the next useful action. |
| `correct` | Send targeted correction feedback and continue the same agent within the unchanged Goal and permissions. |
| `met` | End the loop for a one-shot goal, retaining its status. This is a model judgment, not independent business verification. |
| `waiting` | Keep the goal; yield to existing external work/notifications or the next period. |
| `input` | Keep the goal; yield for a genuine user decision or access requirement. |

### Correction feedback

One native classification request answers two typed questions: `next` (the five verdicts above) and `reason`. When `next=correct`, `reason` must identify one supported issue:

| Reason | Corrective direction |
|---|---|
| `evidence_conflict` | Reconcile the response with the newest available evidence; distinguish successful and failed substeps. |
| `no_action` | Stop merely repeating plans/status; take a useful authorized action, or identify the real blocker. |
| `off_goal` | Return to the current Goal and latest user instructions without expanding scope. |
| `invalid_wait` | Check whether the claimed dependency still applies; proceed when it has been resolved. |
| `premature_completion` | Withdraw an unsupported completion claim and address missing acceptance evidence/work. |

Other verdicts use `reason=none`. A missing/unsupported reason for `correct` is a malformed evaluation: keep the Goal, report the error and yield without retry. Existing saved Goals need no migration. `/goal` and saved feedback show the latest reason/confidence; correction feedback is model-visible through the existing native settlement boundary.

These are generic Goal/action/evidence judgments, not project-specific status parsers or business rules. They do not modify the Goal, grant permissions, force tools, rerun external actions, impose a turn budget, or guarantee the agent will comply. Truncated evidence is explicitly marked; the classifier must not invent missing facts. Normal difficulties, valid external waiting and an explicit user pause must not be treated as misconduct. `correct` requests a next run just like `continue`, rather than ending the Goal.

The two answers share **one request to the already-selected classifier**; there is no second model, provider switch or extra retry. The extra question can increase provider-billed input/output usage. Both questions and their criteria are included in the existing input budget.

Each classification uses a 30-second deadline and no client retries. A failed/malformed classification preserves the goal and reports the error without retrying or automatically continuing. It can be evaluated again after the next normal prompt/notification. Aborted/error agent runs and already-queued work are not restarted by this plugin.

### Input budget / `max_tokens_exceeded`

Before calling the classifier, the plugin budgets the **entire serialized `{state, questions}`**, including the complete Goal, instructions, JSON escaping and visible evidence. The budget is `min(60000, floor(contextWindow * 0.8) - 1024)` UTF-8 bytes (never below zero); missing/invalid catalog limits use an 8192-token context fallback. This is a conservative byte-based proxy, **not an exact provider token count**. The reserve allows for transport framing/output; the ceiling prevents large-context models from silently expanding the old evidence/cost scope. For `opencode/jev-1.13-free` with catalog context 32000, the request budget is 24576 bytes, not 60000 characters.

The complete Goal and questions are preserved. Newest visible records are selected first; large individual records keep Unicode-safe head/tail excerpts with a truncation marker. Old excess records are omitted, and `possiblyTruncated` tells the evaluator evidence is incomplete. Hidden reasoning, images and plugin reminders/feedback remain excluded. This does not compact or mutate the main conversation or Goal file. `/goal`'s latest result and saved feedback details include input-budget sizes/counts for diagnosis.

**If the Goal/questions alone exceed the budget, evaluation fails locally, retains the Goal, and makes no API request.** Explicitly shorten the Goal or choose a larger-context classifier; the plugin never silently truncates requirements, switches providers or retries. Catalog limits and provider restrictions can differ, so this does not guarantee every server accepts a request; an actual provider error remains visible. After installing this source update, `/reload` adopts it without rebinding the Goal; the next ordinary run/notification can evaluate again.

### Host limitations

File notifications use the operating system's directory watcher. Replacing the entire watched directory or editing a symlink target elsewhere may not notify an idle session; the request/settlement rereads still pick up the latest file when work resumes.

In Pi 1.4.0, an edit during **manual idle compaction** is adopted but cannot reliably start a new run until the next normal prompt/notification. There is no public extension `compaction_end` hook, and the plugin does not poll or bypass compaction. You do not need to repeat `/goal`. SDK hosts must perform orderly runtime shutdown (emitting `session_shutdown`); bare `session.dispose()` in this host version does not emit that cleanup event.

A recurring goal stays bound after a period is met. **This plugin does not schedule the next period or launch a notification producer.** Use the host's existing scheduler/notifications. It also does not impose research budgets, rewrite goals, grant permissions, enforce an OS sandbox, or retry external side effects. There is no plugin-imposed total-turn limit: use normal cancellation or `/goal clear` to stop.

## Tests

```sh
npm test
```

Offline tests use the actual installed Pi extension loader; no production Session, provider request, or project task is started. Set `PI_HOST_DIR` if Pi cannot be found on PATH. Live evaluator accuracy and provider availability are separate from offline lifecycle verification.

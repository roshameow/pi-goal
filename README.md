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
- Text or any UTF-8 file works; no YAML/JSON schema is required. Existing files are detected relative to the session cwd. A file is read as a snapshot when set; repeat `/goal ./goals.md` to adopt edits. No file is modified.
- `/goal` shows the goal, state, classifier, evaluation count, reported API cost and latest verdict.
- `/goal clear` stops goal-driven continuation, not an already-running tool or external task. Escape stops automatic continuation through Pi's normal cancellation. In Pi 1.4.0, settlement hooks lack the active-run abort signal, so an in-progress check may finish before Escape returns (bounded by the 30-second classifier deadline). An interrupted verdict is not retained as completion. New user instructions retain priority.
- The binding and verdicts use native, branch-local session entries. They survive compaction/reload/resume. A different Session ID (fork/clone/new) does not silently inherit ownership. Restoring a session restores its goal; startup alone does not launch work. The next prompt or existing notification resumes it.

## Classifier

By default the plugin picks the first available native classifier and shows its provider/model when the goal is set. Pin a preferred one at startup if desired:

```sh
pi --goal-classifier provider/model
```

The selected classifier is saved with the goal. No chat-model switch or silent provider failover. Authentication, endpoints, transport, cancellation and catalog discovery belong to Pi.

**Setting a goal opts into automatic continuation and classifier requests.** The provider receives the goal and a bounded recent text/action trajectory, including visible tool results. Hidden reasoning, image bytes and credential stores are not collected. Ordinary visible output can still contain sensitive material; use an appropriate provider. Each check may incur API fees; only provider-reported costs are shown by `/goal`, not folded into Pi's chat footer by this plugin.

At final settlement (not after every tool), the classifier chooses:

| Verdict | Behavior |
|---|---|
| `continue` | Add feedback and ask the same agent to take the next useful action. |
| `met` | End the loop for a one-shot goal, retaining its status. This is a model judgment, not independent business verification. |
| `waiting` | Keep the goal; yield to existing external work/notifications or the next period. |
| `input` | Keep the goal; yield for a genuine user decision or access requirement. |

Each classification uses a 30-second deadline and no client retries. A failed/malformed classification preserves the goal and reports the error without retrying or automatically continuing. It can be evaluated again after the next normal prompt/notification. Aborted/error agent runs and already-queued work are not restarted by this plugin.

A recurring goal stays bound after a period is met. **This plugin does not schedule the next period or launch a notification producer.** Use the host's existing scheduler/notifications. It also does not impose research budgets, rewrite goals, grant permissions, enforce an OS sandbox, or retry external side effects. There is no plugin-imposed total-turn limit: use normal cancellation or `/goal clear` to stop.

## Tests

```sh
npm test
```

Offline tests use the actual installed Pi extension loader; no production Session, provider request, or project task is started. Set `PI_HOST_DIR` if Pi cannot be found on PATH. Live evaluator accuracy and provider availability are separate from offline lifecycle verification.

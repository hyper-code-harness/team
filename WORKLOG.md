# Team MVP implementation worklog

## Delivered

Private plugin root `/Users/niquola/.hyper/user/team`, mounted as `team`. No commit, push or publication. No production test teams, tasks, messages or agent sessions created. Existing unrelated workspace changes were not modified.

Dedicated PostgreSQL schema `team`; exactly six tables: team, member, task, event, command, delivery. Additive migration `20291012000100_team` applied explicitly (not all pending migrations) under framework transaction, with migration ledger entry in the same transaction. Schema verified through information_schema. Indexes include active-agent membership uniqueness and one working/blocked slot per member.

Runtime functions (21), all created via procs.dev.createFunction and strict metadata/typecheck validated after final edits:
- create, activate, archive
- executeCommand, resolveActor, reduceTask
- taskCreate, taskAssign, taskTransition
- get, list, sync, tasks, timeline
- say, report
- configureMaintenance, maintenance, checkDeadlines, flushDeliveries, recordDeliveryFailure

One function per file; no runtime project cross-imports. All plugin domain SQL schema-qualified team.*; no direct core agents/messages SQL. Framework transaction uses parent-provided generic core API. Actor inferred from injected context: service rejected; injected agent takes precedence over user; owner requires authenticated HTTP context. Core trusted enqueue and cron scoped authority used, no opts.agent impersonation.

UI routes `/team` GET/POST and `/team/:id` GET plus `/team/:id/command` POST. Bootstrap instructions link standard new-agent UI and warn against reusing personal chats. Fixed roster uses existing owner nonhidden nonarchived sessions. Creation does not automatically provision sessions. Activation sends the complete passport through outbox. UI supports task creation/assignment, explicit owner review, activation/archive, failed-delivery retry, and maintenance grant configure/repair. POSTs enforce same Origin, form content type, owner authority and stale-version handling. Board, timeline/evidence payloads and delivery failures are visible. Actual `cron.workerReadiness` result is displayed dynamically.

## Correctness and review fixes

- Team row lock serializes commands, successful command dedup includes payload/version hash. Access check precedes replay; archive exact retry remains possible after archived state.
- Started assignment immutable; started cancellation denied; blocked retains slot; submit releases slot. Reviewer cannot approve stale submission; supervisor's own work requires owner.
- Submit evidence lives in immutable event payload, including artifact references and verification.
- Sequence allocated under team lock. Reports/say do not alter normative task versions.
- Deadline scan excludes already-escalated generations before LIMIT, avoiding starvation beyond the first batch.
- Outbox token/lease claims; stable core delivery keys; token-checked finalize; finite retries. Failed deliveries produce public system audit event plus coalesced supervisor alert, without recursive failure-alert notifications. Owner retry is versioned/audited.
- Fixed submit-next-work notification: author suppression now applies only to say, not task notifications.
- UI activation configures owner-scoped grant before executing activation; repair action is separately reachable.

## Tests actually run

1. `bun test tests/reduceTask.test.ts tests/routes.test.ts`: **159 pass, 0 fail, 298 assertions** (115 reducer + 44 route contracts). Output `tests/unit-output.txt`.
2. `bun test tests/integration.test.ts`: **12 pass, 0 fail, 50 assertions**, final implementer rerun 1.85s. Output `tests/integration-output.txt`.
3. Integration creates a unique disposable cached postgres:17 container with loopback ephemeral port, team_test DB, tmpfs data, memory256m/cpu1. Final rerun container `hyper-team-test-ac55ebf5-200` removed by harness. Production DB never used for fixture setup/cleanup. prepare:false matches framework configuration.
4. Integration proves real SQL/domain races, CAS, slot constraints, replay/conflict, rollback, membership uniqueness, permissions, stale review, archive replay, and >20 deadline generations. Core enqueue/cron/current identity are mocked there: **not full end-to-end transport or worker proof**.
5. Parent independently reran 12 integration tests and read-only authenticated browser `/team` smoke; screenshot in main workspace `research/agent-teams/team-ui-smoke.png`. No live mutations during smoke.
6. Parent core foundation tests: transaction13, cron authority12, enqueue10, lifecycle5. Those generic changes are parent-owned, not plugin files.
7. Final strict runtime metadata/typecheck: all 21 functions pass. Boundary audit no errors; three pre-existing unrelated core/plugin warnings.

## Operational gates and limitations — do not overclaim

**Code and schema/UI are runnable; automatic background delivery on the existing live process is NOT yet ready.** Parent verified cron.workerReadiness: ready=false, running=true, tracked=false, legacyRequiresDrain=true, reason=legacy-worker-untracked. Existing old loop closure cannot be safely proven drained by hot-reload alone. No server restart or unsafe worker toggle performed. Parent controls generic lifecycle deployment and enqueue receipt migration. Owner grants alone do not close this gate.

Per-owner maintenance is a scoped dynamic cron job, not the originally proposed one static declaration. This is required by generic owner-bound authority. Automatic plugin-disable reconciliation of these dynamic jobs is not proven; disabled/unloaded target must fail closed, and lifecycle remains a deployment consideration. No automatic per-agent per-turn hook.

Manual dedicated-session bootstrap is explicit; no idempotent session provisioning claim. No private team messages, dynamic membership, safe started-work reassignment/cancel, sandbox, external-action approval, or exactly-once model/external work guarantees. Progress updates record evidence but do not perpetually reset the hard generation deadline.

System domain author remains `system` in team.event and the notification envelope. Generic enqueue currently records owner transport attribution for system-origin notices, clearly separated by the automated envelope; it does not represent a direct human instruction. Full service/source attribution extension is outside this plugin scope.

Creation replay validates session ownership before returning prior result (may reject after session archival). Passport arrives as queued event notification, not an enlarged system prompt. Failed alert can block archive until owner retries/resolves delivery; no hidden destructive recovery.

## Backlog, queues, pause and preempt (2026-11-19)

Changes (uncommitted, for manager review):
- New additive migration `$migration_20291020000100_team_queue`: `team.task.rank double precision`, `group_key text`, `depends_on text[] NOT NULL DEFAULT '{}'`, `paused_note text`. Status CHECK extended with `paused`. New CHECK: paused requires an assignee. Index `(team_id,assignee_agent_id,rank)`. The slot index is unchanged (`working`,`blocked` only), so paused does not hold the slot. The existing migration is untouched. On the live DB the hot-reload auto-applied it; ledger row `20291020000100_team_queue` present, columns verified via information_schema. Live `team.task` had 0 rows before and after; no live team data touched.
- `types.team.Task` adds rank/groupKey/dependsOn/pausedNote. `Transition` adds `claim`, `pause {note}`, `cancel {reason?}`. `Command` adds `taskCreate.rank/groupKey/dependsOn`, `taskReorder`, `preempt`.
- `reduceTask` (pure): claim (agent only, unassigned todo, every dependsOn `done` via the new `dependencyStatuses` input); pause (assignee/supervisor/owner, working|blocked → paused, note required, deadline cleared); resume from blocked or paused (assignee, free slot); cancel paused (supervisor/owner, reason required). Start still requires assigned.
- `executeCommand`: taskCreate validates rank/groupKey and that dependsOn ids exist; the default rank is the end of the queue. taskAssign to a new assignee moves the task to the end of their queue. taskReorder (task-version CAS, manager, never-started only, optional assign). preempt (team-version CAS, manager): locks the assignee's slot task, pauses it via the reducer with its own `pause` event, assigns the urgent task at min(rank)-1 and writes a `preempt` event + delivery to the assignee. After commit (not on replay): `procs.events.refresh({topic:'team'})` in try/catch. For preempt, `agent.message` to the assignee when the caller has an agent session; the result carries `interrupt:{messaged,stopped:false,reason?}`. `checkDeadlines` and `maintenance` refresh when they changed something.
- Convenience fns: `team.claim`, `team.taskReorder`, `team.preempt`; `taskCreate` gains rank/groupKey/dependsOn. `get`/`tasks`/`sync` order tasks by `assignee_agent_id NULLS FIRST, rank, id` and return the new columns. The board route shows the paused column.

Verified:
- `bun test tests/reduceTask.test.ts tests/routes.test.ts`: 192 pass, 0 fail (new reducer cases: claim with/without deps, claim denials for user/assigned/every non-todo status, pause by 3 actors × 2 states, pause denials, resume from paused, slot conflict, cancel paused + denials, start/submit from paused rejected).
- `bun test tests/integration.test.ts` (ephemeral docker postgres:17, both migrations run twice): 16 pass, 0 fail. New: migration idempotent + paused needs assignee; claim gated by dependency, then a real concurrent claim race where exactly one wins (the loser gets Version conflict); preempt pauses current work, urgent ranks above the existing queue, `pause`+`preempt` events in order with delivery to the assignee, an urgent message is sent once, exact replay sends no second message, paused frees the slot (urgent starts; resume is rejected until urgent is submitted), owner preempt without an agent session reports outbox-only, the assignee cannot cancel paused work, the owner can; reorder: denial for a member, the queue order `[a, c(1.5), b]` via team.tasks, reorder of started work rejected.
- `runtime.docs.validate({strict:true,typecheck:true})` true for executeCommand, reduceTask, taskCreate, claim, taskReorder, preempt, get, sync, tasks, checkDeadlines, maintenance.

Limitations: no safe documented API stops another agent's in-flight turn (`agent.stop` needs the live target agent object and is a user-stop; `agent.stopMember` only covers delegated children), so preempt messages and wakes the assignee but does not abort its current tool call or LLM turn. An owner-HTTP preempt sends no agent.message (no sender agent); it relies on the team.delivery outbox, which is gated by the cron worker readiness above. Dependencies gate only `claim`; `taskAssign`/`start` of assigned work do not check dependsOn. No dependency-cycle detection beyond "must already exist" (cycles impossible at creation, since deps must pre-exist). Ranks are not renormalized.

## Task report, task card popup, owner feedback (2026-11-19, Ян)

Uncommitted. New: `TaskReport.ts` (type), `normalizeReport`, `reportTask`, `taskView` (@view @live team), `taskPopup`, `feedback`, `$route_feedback_POST`. Changed: `Transition.ts` (submit.report?), `executeCommand.ts` (normalized report → `team.event.payload.report` of the submit event). No migration: the report lives in the immutable submit event, each resubmit has its own.
- Format: `{summary, done[], decisions[{what,why}], checks[], files[], questions[]}`; rule in SKILL.md.
- Delegated children: `team.reportTask({taskId, report})` writes `plan.tasks[i].report` in the caller's own scratchpad (mutateScratchpad). taskView also reads `result.report`/`result` shape or `resultSummary` (legacy fallback).
- Popup: `hx-popup="team.taskPopup"` + `hx-popup-params='{"taskId":…,"agentId":…?}'`, or `w.*({action:{popup:{method:'team.taskPopup',params}}})`. It uses the core preset kind `file-preview` (90rem × 97vh); the card scrolls itself.
- Feedback `POST /team/feedback` (form taskId, agentId?, text, _csrf): owner only; the CSRF token is the gate instead of an Origin check, because behind the mesh proxy Origin ≠ req.url (the command route has the same issue). Team: review → `changes` (back to assigned, assignee notified); otherwise `say` to=assignee in the task thread; a done task stays terminal (reduceTask cannot reopen it). Child: `session.enqueueNotification` from the person into the child chat; archived → to the manager (parent_id) with the task noted; the comment is also kept in `plan.tasks[i].feedback[]`.
- Proposal for the core (not done): `agent.finishTask`/`session.done` could accept an optional `report` and put it into plan.tasks[i].report, and the delegate prompt could ask children for it — then children would not need a plugin call.
- Checks: repl.load team; docs.validate strict+typecheck ok for every new function; bun test 209 pass (new integration test: report in the payload, feedback changes→assigned, say delivery, agent caller refused); popup screenshot in a live browser, form POST reached the route (CSRF passed, empty comment rejected by the domain check).

## Hiring and firing (Рома)
- Migration `$migration_20291101000100_team_roster`: team.member + persona/joined_at/left_at/left_reason/hired_by; team.delivery status + 'cancelled'.
- Commands `memberHire` / `memberFire` in executeCommand (supervisor or owner; departed members are filtered out of the roster); wrappers `team.hire` (new session via agent.start, passport in system prompt and agents.meta.persona, kickoff) and `team.fire` (tasks to backlog or reassignTo, deliveries cancelled, session archived). Archive ignores cancelled deliveries.
- Checked live: hire → 2 tasks (one working) → fire → both todo without assignee, events memberHire/taskCreate×2/memberFire, session archived, departed agent cannot be assigned; test data removed.

## Team rules brief + team.delegate (Ян)

Uncommitted. New: `team.brief`, `team.delegate`; SKILL.md gets a `<!-- brief --> … <!-- /brief -->` block — the single source of team rules (estimate/progress, team.feed, team.post, two-layer task text and summary, result fields checked/notCovered/notDone/next/visuals, reportTask).
- `team.brief({agentId?, taskId?, managerAgentId?})` → ≤40 lines: the block from SKILL.md + task id + «Сейчас работают» and last 5 entries from `team.feed`.
- `team.delegate({agent, title, human, details?, tasks?, persona?, model?})` → instructions of the first task = human + `\n---\n` + details + brief; calls `agent.delegate`; persona: copies icon + meta from the latest session with `meta.persona.name`, else letter icon; meta written via UPDATE after delegate (agent.delegate has no meta option; verified it survives the child's run/save).
- Checked: docs.validate strict+typecheck ok for both; team.brief live = 23 lines; dummy child cepu via team.delegate(persona "Ян") — first user message contains "Team rules" and "notDone", meta.persona and icon present after its run, it finished with "Team rules received"; archived.

Core proposal (not done): today rules reach the child only as text in the first user message, which compaction can drop and which `agent.start`/hire/plain `agent.delegate` do not get. Minimal core change: let plugins declare a `$promptSection_<name>.ts` file exporting `(ctx, {agent}) => string | null`; `agent.fullSystemPrompt` (and therefore `agent.buildDelegatedTaskPrompt` children) collects all registered sections, calls them with the agent, and appends non-empty results under a `## <plugin>` heading, each bounded (e.g. 4 KB) and wrapped in try/catch so a broken plugin never breaks a prompt. team would then ship `$promptSection_rules.ts` returning `team.brief({agentId})` for agents with a parent or a team membership, and team.delegate would shrink to persona handling.

## Manager review of handed-in tasks (Лена)
- Core already notifies: `session.done` → `agent.steer({ event: 'task.completed', taskId })` for every plan task of a delegated child; no core change needed.
- `team.accept` now accepts calls from the manager agent (the child's parent_id). `team.accept.accepted_by` = person id | `manager:<agentId>`. A person's accept overwrites a manager's mark; a manager never overwrites a person's one. `team.accepted` returns `by`.
- Board (row/tile in History) and popup show «принял <manager>» with the manager's face; the chronicle `accepted` entry has the manager as actor (byUser=false).
- Returning to work: `team.reopen({ taskId, agentId?, comment, nextIdx? })` by Рома (ceqd), not yet mounted at the time of writing; it deletes the team.accept mark, so a person can return a task the manager accepted. The manager section in SKILL.md points to it.

## Persona team (Рома, ceqe)

Uncommitted. Members are personas; their sessions are replaceable.
- Migrations `$migration_20291225000100_team_persona` (team.persona, persona_rev, team_persona, persona_session) and `_000200_team_persona_link` (persona_rev.reason/base_version, team.task_link).
- New: `team.personaGet`, `team.personaSave` (deltas/text/revert; owner or the persona itself; card owner-only; `<!-- owner -->` prompt section owner-only; size limits; baseVersion check; event kind persona), `team.personaCreate`, `team.dispatch`, `team.createForm` (board block, owner only, no team yet).
- executeCommand: `personaJoin`, `personaBind` (new session → member row, current_agent_id, persona_session; open tasks of the previous session move unless moveOpen:false), `personaLeave`; `memberFire` clears current_agent_id and closes persona_session.
- `team.create({personas})`; `POST /team/` route: CSRF instead of Origin (mesh proxy), personas JSON, activate=1, back.
- `team.delegate`: active persona team → taskCreate in backlog → team.dispatch; else old path (now passes persona to team.brief).
- `team.reportTask`: plan task with team.task_link → start + submit of the team task (review) with the report.
- `team.fire`: archives via `team.retire` (Ян) instead of session.archive.
- dashboard.ts: only +2 lines (createBlock). Faces/sections/dedup by task_link — Даша; persona pages — Катя; retire + persona brief — Ян; team.reopen — Рома (ceqd).

## Persona memory as memos, mandatory at hand-in (Ян, cesr)

Uncommitted. Why memory stayed empty: (1) `team.delegate({persona})` without a team never wrote `team.persona_session`, so `personaSave` rejected the persona's own sessions («only the owner or the persona itself» — Катя cese, Даша cesf); (2) some sessions (Рома ceqd) got no persona block in the brief at all; (3) the save was only a reminder, nothing enforced it.
- Migration `$migration_20300105000100_team_persona_memo`: `team.persona_memo`; `persona_rev.path`/`meta`, field check + 'memo'; non-empty `persona.notes` → memo `notes/legacy.md`; backfill `persona_session` from `agents.meta.persona` (43 rows).
- New: `team.memoSave`, `memoDelete`, `memoSearch`, `memoRead`. Limit 2500 chars per memo → error asking to compress/split.
- `team.reportTask`: persona session must have a memo revision (author = this session) since the plan task started/reopened; optional `memo` arg saved first. Otherwise a clear Russian error.
- `team.brief` (+`query`): memo table of contents + full text of ≤3 relevant memos; delegate/dispatch pass the task text as query. `retire` asks for memos. `personaGet` returns `memos`, `persona.ts` shows «Память» + memo revisions with rollback (`$route_persona_POST` → memoSave revertOf); notes textarea removed from the form.
- Даша's draft (cesf result.personaNotesDraft) moved into memos code/board.md and howto/screenshots.md.
- Checked: live session via team.delegate(persona ТестМемо) → reportTask without memo rejected, with memo accepted, persona_rev row author agent; limit, ops, revert, delete; screenshot .hyper/tmp/cesr/persona-memos.png. Test persona/session data removed.

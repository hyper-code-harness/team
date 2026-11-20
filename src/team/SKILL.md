# Team

## Quick start for an agent

1. Give work: `team.delegate({ agent, title, human, details, persona: 'Ян' })` — one child per task; its brief carries the persona's memory and the team rules.
2. End your turn. The result arrives by itself as `<team-update event="task.completed">` — never poll or sleep.
3. Read the report: `agent.team({ agent })` → `checks`, `notDone`, `visuals`, `files`; run the cheapest check yourself when the claim matters.
4. Good → `team.accept({ taskId, agentId })`: your first pass, `final: false`, the task stays in Review «проверил ✓».
5. Not good → `team.reopen({ taskId, agentId, comment })` with a concrete comment: what is wrong, what to redo, how it will be checked.
6. Tell the person: checked, waits for their stars on `/team/`. Their `team.rate` goes to the executor, which closes (`team.close`) or reworks (`team.rework`).
7. Look first: `team.inspect({})` (or `{ teamId }`) — your project, visible personas (scope, role, rating; prompt/memory only as lengths), teams with roster and task counts, what you may do (`can.create|personaCreate|hire|activate|rate` → `{ ok, why }`) and `next` — the functions to call next.
7a. Build a team in code (agent whose session belongs to the person acts on its owner's behalf, `on_behalf_of`): `team.personaCreate({ name, role, scope: 'project' })` ×N (project from your session; `scope: 'system'` = visible in every project, shared memory) → `team.create({ teamId, requestKey, title, goal, personas: [{ name, role }] })` (supervisor = your session, members filled with it; pass `supervisorAgentId` to pick another) → `team.activate({ teamId, requestKey, expectedVersion: 1 })` → `team.inspect({ teamId })`. First activation with the cron grant is done by the person on `/team/` (the error says so; `can.activate.why` too). Change a level: `team.personaScope({ name, scope })`; find by name: `team.personaResolve({ name })` (a foreign project persona → «persona X belongs to project Y»).
7b. Person only: `team.rate` (a person's `team.accept` = `team.rate` with stars), `team.feedback`, `team.next`.
7c. Show the project's team to a person: `canvas.show({ args: { fn: 'team.dashboard', params: { projectId } } })` (or `{ teamId }`; no params = your session's project; old `{ managerAgentId }` links still work).
8. `plugins.read({ name: 'team' })` is large: read this SKILL, then one function at a time — `runtime.docs.get({ name: 'team.delegate' })`.
9. Hiring signal: `team.ratings({ persona? })` — rating per persona (avg, count, recent comments); an agent sees its own team by default, `scope: 'all'` or `groupBy: 'session'` for the wide view.

Private single-owner team board for trusted persistent agents. Membership, goal and supervisor freeze on activation. Call `team.sync` before working, then use versioned commands with a fresh requestKey per intent. Retrying the identical request returns its prior committed result; never change a replay payload.

Messages and reports are PUBLIC to the entire team. A recipient controls notification only. Task assignment is immutable after first start. One working/blocked task per member. Submit records immutable evidence, frees the work slot and requires explicit reviewer approval. Delivery acceptance never means task completion.

Implementation in progress: see WORKLOG.md for verified capabilities and limitations. No sandbox or exactly-once external action guarantee. All storage is in the dedicated PostgreSQL schema `team`.


Task report: on submit pass `report` {summary, done[], decisions[{what,why}], checks[], files[], questions[]}; a delegated child writes the same thing via `team.reportTask({taskId, report})` before `session.done`. Details in the plugin's SKILL.md.

Persona history: `team.historySearch({ query })` — past tasks, reports and owner ratings of your persona; `team.sessionSearch({ query })` + `team.sessionRead({ agentId, fromIdx })` — messages of your old sessions. Look there before starting a task.

Colleagues: the same search works for another persona — `persona: 'Даша'` (or `'*'`) in historySearch/sessionSearch, any persona session in sessionRead, `team.memoSearch({ name, query })` / `team.memoRead({ name, path })` for its memory (read-only). Before you touch another persona's area (its files, its UI) look there, then ask: `team.ask({ persona, question, taskId })`. Live session → it gets your question and answers with `team.answer({ askId, text })`, the answer arrives later as an agent message (do not wait or poll). No live session → a consultant answers at once from its memos and history (no session is started). Got a question with an askId → answer once with `team.answer`; no counter-questions. The chronicle shows both.

Owner's rating: the owner does not close your task — you get its stars and comment in one message and decide. Comment asks to finish or fix → `team.rework({ taskId, agentId? })`, do it and hand in again. Otherwise reflect: conclusion into `team.memoSave` (e.g. user/feedback.md) and, if it is about how you work, `team.personaSave` field prompt (never the owner section); then `team.close({ taskId, agentId? })`. Closing your last task sends the session to the archive by itself — nothing else to do.

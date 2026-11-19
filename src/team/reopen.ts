/**
 * Returns a handed-in task to work with the owner's comment: the same assignee continues the same task
 *
 * Signed-in person (owner) or the manager agent (for a delegated child: its parent; for a team task: the supervisor, enforced by executeCommand). The comment says what is wrong and what to finish. Team task: in review → changes to the same assignee (reason = comment), then team.dispatch hands it to the assignee's persona session when there is one; done/cancelled (terminal in reduceTask) → a new team task «Доделать: <title>» for the same assignee, linked as its continuation; assigned/working → the comment goes to the assignee (say). Delegated child plan task (agentId) whose session is alive: the plan task goes back to active (delegation working again, the previous report kept in reopens[]), acceptance marks are removed, and the child gets «Владелец вернул задачу …: <comment>. Доделай и снова отчитайся (finishTask)» — the board shows it in «В работе» until a new report. Archived child: team.delegate to the same persona (meta.persona of the archived session) with human «Доделать: <title>» and details = original task + previous report (summary, notDone, next) + the comment; the old task is marked continued (leaves Review) and the new one is linked to it (reopenOf). A plan task linked to a team task (team.task_link) is reopened as that team task. Every reopen is a row in team.reopen and an entry of kind 'reopen' in team.feed and the task history; refreshes the 'team' live topic.
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child whose plan holds the task.
 * @param opts.comment What is wrong and what to finish, up to 8000 characters; required.
 * @param opts.nextIdx Index of the report «Дальше» item this reopen comes from (team.next), stored for the link. @minimum 0
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child whose plan holds the task. */
        agentId?: string;
        /** What is wrong and what to finish, up to 8000 characters; required. */
        comment: string;
        /** Index of the report «Дальше» item this reopen comes from (team.next), stored for the link. @minimum 0 */
        nextIdx?: number;
    },
): Promise<{kind:'team'|'child'; action:'changes'|'continueTask'|'say'|'agent'|'redelegate'; to:string; toName:string; title:string; at:number; reopenId:string; newAgentId:string|null; newTaskId:string|null}> {
    type Row = Record<string, any>;
    const comment = String(opts.comment ?? '').replace(/\u0000/g, '').trim();
    if (!comment) throw new Error('Напишите комментарий: что не так и что доделать');
    if (comment.length > 8000) throw new Error('Комментарий длиннее 8000 символов');
    const actor = await ctx.fns.team.resolveActor({});
    const by = actor.kind === 'agent' ? 'manager:' + actor.id : String(actor.id);
    const author = actor.kind === 'agent' ? 'agent:' + actor.id : String(actor.id);
    let taskId = String(opts.taskId ?? '').trim(); let agentId = String(opts.agentId ?? '').trim();
    if (!taskId) throw new Error('taskId required');
    const nextIdx = opts.nextIdx === undefined || opts.nextIdx === null ? null : Number(opts.nextIdx);
    if (nextIdx !== null && (!Number.isInteger(nextIdx) || nextIdx < 0)) throw new Error('nextIdx must be a non-negative integer');
    const json = (v: unknown): Row => { if (!v) return {}; if (typeof v === 'object') return v as Row; try { return JSON.parse(String(v)); } catch { return {}; } };
    const at = Date.now(); const reopenId = 'reopen-' + Bun.randomUUIDv7();
    // Self-heal when the migration has not run yet (same DDL as $migration_20291226000100_team_reopen).
    await ctx.fns.procs.db.run({ sql: "CREATE TABLE IF NOT EXISTS team.reopen (id text PRIMARY KEY, agent_id text NOT NULL DEFAULT '', task_id text NOT NULL, comment text NOT NULL, action text NOT NULL, to_agent_id text NOT NULL DEFAULT '', new_agent_id text NOT NULL DEFAULT '', new_task_id text NOT NULL DEFAULT '', next_idx integer, by_actor text NOT NULL, at bigint NOT NULL)" });
    const nameOf = async (id: string) => { if (!id) return ''; try { const r = (await ctx.fns.procs.db.select({ sql: 'SELECT title, meta FROM agents WHERE id = ?', params: [id] }) as Row[])[0]; return r ? String(json(r.meta)?.persona?.name ?? r.title ?? id) : id; } catch { return id; } };
    const unaccept = async (aid: string, tid: string) => { try { await ctx.fns.procs.db.run({ sql: 'DELETE FROM team.accept WHERE agent_id = ? AND task_id = ?', params: [aid, tid] }); } catch (e) { if (!/team\.accept|does not exist/.test(String(e))) throw e; } };
    const record = async (aid: string, tid: string, action: string, to: string, newAgentId = '', newTaskId = '') => {
        await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.reopen (id, agent_id, task_id, comment, action, to_agent_id, new_agent_id, new_task_id, next_idx, by_actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', params: [reopenId, aid, tid, comment, action, to, newAgentId, newTaskId, nextIdx, by, at] });
        try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    };

    // plan task that works on a team task (team.dispatch link): reopen the team task itself
    if (agentId) {
        try {
            const l = (await ctx.fns.procs.db.select({ sql: 'SELECT task_id FROM team.task_link WHERE agent_id = ? AND plan_task_id = ?', params: [agentId, taskId] }) as Row[])[0];
            if (l) { taskId = String(l.task_id); agentId = ''; }
        } catch (e) { if (!/task_link|does not exist/.test(String(e))) throw e; }
    }

    if (agentId) {
        const a = (await ctx.fns.procs.db.select({ sql: 'SELECT id, title, parent_id, archived_at, scratchpad, meta FROM agents WHERE id = ?', params: [agentId] }) as Row[])[0];
        if (!a) throw new Error('Agent not found');
        if (actor.kind === 'agent') { if (String(a.parent_id ?? '') !== actor.id) throw new Error('Only the manager (parent agent) of ' + agentId + ' can return its tasks'); }
        else if (!(await ctx.fns.jobs.canSee({ agentId }))) throw new Error('Not your agent');
        const t = (json(a.scratchpad).plan?.tasks ?? []).find((x: Row) => x?.id === taskId) as Row | undefined;
        if (!t) throw new Error('No plan task ' + taskId);
        const title = String(t.title ?? taskId);
        const r = t.result && typeof t.result === 'object' ? t.result as Row : null;
        const report: Row | null = t.report ?? (r && (r.report || r.summary || r.notDone || r.next) ? await ctx.fns.team.normalizeReport({ report: r.report ?? r, fallbackSummary: String(t.resultSummary ?? '') || undefined }) : t.resultSummary ? { summary: String(t.resultSummary) } : null);
        if (a.archived_at == null) {
            if (t.status !== 'done' && t.status !== 'active') throw new Error('Задача ещё не начата — вернуть в работу нечего');
            const out: any = await ctx.fns.session.mutateScratchpad({ id: agentId, mutate: (sp: Row, now: number) => {
                const task = (sp.plan?.tasks ?? []).find((x: Row) => x?.id === taskId);
                if (!task) throw new Error('No plan task ' + taskId);
                task.reopens = [...(Array.isArray(task.reopens) ? task.reopens : []), { at: now, by, comment, report: task.report ?? null, resultSummary: task.resultSummary ?? null }].slice(-20);
                if (task.status !== 'active') { task.status = 'active'; task.activeSince = now; }
                task.reopenedAt = now;
                sp.plan.updatedAt = now; sp.plan.pausedAt = null;
                if (sp.delegation) { sp.delegation.status = 'working'; delete sp.delegation.summary; delete sp.delegation.result; }
                return true;
            } });
            const live: Row | undefined = (ctx.state as any).agent?.[agentId];
            if (live) live.scratchpad = out.scratchpad;
            await unaccept(agentId, taskId);
            const prev = report?.summary ? '\n\nТвой прошлый отчёт: ' + String(report.summary).split(/\n\s*---/)[0]!.trim().slice(0, 1500) : '';
            await ctx.fns.session.enqueueNotification({ to: agentId, key: 'team-reopen:' + reopenId, text: 'Владелец вернул задачу «' + title + '» (' + taskId + ') в работу:\n\n' + comment + prev + '\n\nЭто та же задача, не начинай с нуля: прочти комментарий и прошлый отчёт, доделай, затем team.reportTask({ taskId: \'' + taskId + '\', report }), session.done({ id: \'' + taskId + '\' }) и снова agent.finishTask.', originalAuthor: author });
            await record(agentId, taskId, 'agent', agentId);
            return { kind: 'child', action: 'agent', to: agentId, toName: await nameOf(agentId), title, at, reopenId, newAgentId: null, newTaskId: null };
        }
        // archived: start a new session of the same persona with the task, the report and the comment
        const managerId = String(a.parent_id ?? '');
        if (!managerId) throw new Error('Archived agent has no manager to delegate from');
        const manager: any = (session as any)?.agent?.id === managerId ? (session as any).agent : ((ctx.state as any).agent?.[managerId] ?? await ctx.fns.session.load({ id: managerId }));
        if (!manager) throw new Error('Manager session ' + managerId + ' not found (archived?)');
        const persona = String(json(a.meta)?.persona?.name ?? '').trim();
        const instr = String(t.instructions ?? '');
        const cut = /^[ \t]*---[ \t]*$/m.exec(instr);
        const human0 = (cut ? instr.slice(0, cut.index) : instr).trim();
        // the old brief (team rules, feed) is dropped: team.delegate adds a fresh one
        const agentPart = (cut ? instr.slice(cut.index + cut[0].length) : '').split(/\n+Team rules — /)[0]!.trim();
        const list = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((x: any) => '- ' + (typeof x === 'string' ? x : String(x?.title ?? '') + (x?.why ? ' — ' + x.why : ''))).join('\n');
        const details = [
            'Это продолжение задачи «' + title + '» (агент ' + agentId + ', задача ' + taskId + '), которую владелец вернул в работу. Не начинай с нуля: сначала прочти комментарий владельца и прошлый отчёт, доделай, отчитайся заново.',
            '## Комментарий владельца\n' + comment,
            '## Исходное задание\n' + (human0 || title) + (agentPart ? '\n\n' + agentPart : ''),
            '## Прошлый отчёт\n' + (report ? [String(report.summary ?? ''), Array.isArray(report.notDone) && report.notDone.length ? 'Не сделано:\n' + list(report.notDone) : '', Array.isArray(report.next) && report.next.length ? 'Дальше:\n' + list(report.next) : ''].filter(Boolean).join('\n\n') : '(отчёта нет)'),
        ].join('\n\n').slice(0, 9000);
        const human = ('Доделать: ' + title).replace(/\n---/g, ' ').slice(0, 300);
        const d = await ctx.fns.team.delegate({ agent: manager, title: (persona ? persona + ': ' : '') + 'доделать ' + title.replace(/^[\p{L}-]{2,20}:\s*/u, '').slice(0, 150), human, details, ...(persona ? { persona } : {}) });
        await ctx.fns.procs.db.run({ sql: 'CREATE TABLE IF NOT EXISTS team.accept (agent_id text NOT NULL, task_id text NOT NULL, accepted_by text NOT NULL, accepted_at bigint NOT NULL, PRIMARY KEY (agent_id, task_id))' });
        // the old card leaves Review: its work continues in the new session (accepted() lists it as continued)
        await unaccept(agentId, taskId);
        await record(agentId, taskId, 'redelegate', d.id, d.id, 'task');
        return { kind: 'child', action: 'redelegate', to: d.id, toName: persona || await nameOf(d.id), title, at, reopenId, newAgentId: d.id, newTaskId: 'task' };
    }

    // ---- team task
    const found = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id = ?', params: [taskId] }) as Row[];
    let team: any = null; let task: Row | undefined;
    for (const r of found) { try { const g = await ctx.fns.team.get({ teamId: String(r.team_id) }); const x = g.tasks.find((y: Row) => y.id === taskId); if (x) { team = g; task = x; break; } } catch {} }
    if (!team || !task) throw new Error('Task not found or access denied');
    const teamId = String(team.team.id); const title = String(task.title);
    const assignee = String(task.assignee_agent_id ?? team.team.supervisor_agent_id);
    const key = 'team-reopen:' + reopenId;
    let action: 'changes' | 'continueTask' | 'say'; let newTaskId = '';
    if (task.status === 'review' && task.current_submission_id) {
        await ctx.fns.team.executeCommand({ teamId, requestKey: key, expectedVersion: Number(task.version), command: { action: 'taskTransition', taskId, transition: { action: 'changes', submissionId: String(task.current_submission_id), reason: 'Владелец вернул в работу: ' + comment } } });
        action = 'changes';
    } else if (task.status === 'done' || task.status === 'cancelled') {
        // done is terminal in reduceTask: the work continues as a new task of the same assignee
        newTaskId = (taskId + '-reopen-' + reopenId.slice(-6)).slice(0, 120);
        await ctx.fns.team.taskCreate({ teamId, requestKey: key, expectedVersion: Number(team.team.version), taskId: newTaskId, title: ('Доделать: ' + title).slice(0, 200), instructions: 'Доделать: ' + title + '\n---\nПродолжение задачи «' + title + '» (' + taskId + '): владелец вернул её в работу. Сначала прочти комментарий и прошлый отчёт задачи ' + taskId + ', доделай, отчитайся заново.\n\nКомментарий владельца:\n' + comment + '\n\nИсходное задание:\n' + String(task.instructions ?? '').slice(0, 6000), acceptanceCriteria: String(task.acceptance_criteria || 'Комментарий владельца учтён; отчёт с notDone/next.'), ...(task.assignee_agent_id ? { assigneeAgentId: assignee } : {}) });
        action = 'continueTask';
    } else {
        await ctx.fns.team.executeCommand({ teamId, requestKey: key, expectedVersion: Number(team.team.version), command: { action: 'say', text: 'Владелец вернул в работу: ' + comment, to: assignee, taskId } });
        action = 'say';
    }
    await unaccept('', taskId);
    // persona-based team: hand the task (or its continuation) back to the assignee's persona session
    if (action !== 'say' && task.assignee_agent_id && typeof (ctx.fns.team as any).dispatch === 'function') {
        try { await ctx.fns.team.dispatch({ teamId, taskId: newTaskId || taskId, note: comment }); } catch { /* no persona or team not active: the changes/assign event already reached the assignee */ }
    }
    await record('', taskId, action, assignee, '', newTaskId);
    return { kind: 'team', action, to: assignee, toName: await nameOf(assignee), title, at, reopenId, newAgentId: null, newTaskId: newTaskId || null };
}

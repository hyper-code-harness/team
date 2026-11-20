/**
 * The executor takes its handed-in task back to work because the owner's rating comment asks for more
 *
 * Called by the assignee session itself (agent actor = the task's assignee; for a delegated child plan task = that child) after it read the owner's rating (team.rate → team.reflect message) and the comment asks to finish or fix something. Allowed only when the owner rated the task AFTER its last hand-in; otherwise «Нет оценки владельца после последней сдачи». Team task in review: team.executeCommand changes with byOwnerRating (review → assigned to the same session, reason = the owner's comment); then start it again and hand in anew. Delegated plan task: the plan task goes back to active (previous report kept in reopens[]), acceptance marks are removed; hand in again with team.reportTask / session.done / agent.finishTask. The session stays alive. Posts «<persona> доделывает по комментарию: …» to the chronicle and records a team.reopen row (action 'rework').
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child whose plan holds the task (the caller itself).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child whose plan holds the task (the caller itself). */
        agentId?: string;
    },
): Promise<{ status: 'rework'; taskId: string; comment: string }> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    const taskId = String(opts.taskId ?? '').trim(); const agentId = String(opts.agentId ?? '').trim();
    if (!taskId) throw new Error('taskId required');
    if (actor.kind !== 'agent') throw new Error('team.rework: вызывает исполнитель; владелец пишет комментарий к оценке (team.rate)');
    const me = actor.id; const now = Date.now();
    const rating = (await ctx.fns.procs.db.select({ sql: 'SELECT stars, comment, rated_by, rated_at FROM team.rating WHERE agent_id = ? AND task_id = ?', params: [agentId, taskId] }).catch(() => []) as Row[])[0];
    const comment = String(rating?.comment ?? '');
    let title = taskId; let teamId: string | null = null;
    if (agentId) {
        if (agentId !== me) throw new Error('team.rework: только исполнитель задачи');
        const a = (await ctx.fns.procs.db.select({ sql: 'SELECT scratchpad FROM agents WHERE id = ?', params: [agentId] }) as Row[])[0];
        if (!a) throw new Error('Agent not found');
        const sp = typeof a.scratchpad === 'string' ? JSON.parse(a.scratchpad || '{}') : (a.scratchpad ?? {});
        const t = (sp.plan?.tasks ?? []).find((x: Row) => x?.id === taskId);
        if (!t) throw new Error('No plan task ' + taskId);
        title = String(t.title ?? taskId);
        if (t.status !== 'done') throw new Error('Задача не сдана — она и так в работе');
        if (!rating || Number(rating.rated_at) < (Number(t.completedAt) || 0)) throw new Error('Нет оценки владельца после последней сдачи');
        const out: any = await ctx.fns.session.mutateScratchpad({ id: agentId, mutate: (s: Row, at: number) => {
            const task = (s.plan?.tasks ?? []).find((x: Row) => x?.id === taskId);
            if (!task) throw new Error('No plan task ' + taskId);
            task.reopens = [...(Array.isArray(task.reopens) ? task.reopens : []), { at, by: 'rating:' + String(rating.rated_by), comment, report: task.report ?? null, resultSummary: task.resultSummary ?? null }].slice(-20);
            task.status = 'active'; task.activeSince = at; task.reopenedAt = at;
            s.plan.updatedAt = at; s.plan.pausedAt = null;
            if (s.delegation) { s.delegation.status = 'working'; delete s.delegation.summary; delete s.delegation.result; }
            return true;
        } });
        const live: Row | undefined = (ctx.state as any).agent?.[agentId];
        if (live) live.scratchpad = out.scratchpad;
        try { await ctx.fns.procs.db.run({ sql: 'DELETE FROM team.accept WHERE agent_id = ? AND task_id = ?', params: [agentId, taskId] }); } catch {}
    } else {
        const found = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id = ?', params: [taskId] }) as Row[];
        let team: Row | undefined; let task: Row | undefined;
        for (const r of found) { try { const g = await ctx.fns.team.get({ teamId: String(r.team_id) }); task = g.tasks.find((y: Row) => y.id === taskId); if (task) { team = g; break; } } catch {} }
        if (!task || !team) throw new Error('Task not found or access denied');
        if (String(task.assignee_agent_id ?? '') !== me) throw new Error('team.rework: только исполнитель задачи');
        title = String(task.title ?? taskId); teamId = String(team.team.id);
        if (task.status !== 'review' || !task.current_submission_id) throw new Error('Задача не на ревью');
        await ctx.fns.team.executeCommand({ teamId, requestKey: 'team-rework:' + Bun.randomUUIDv7(), expectedVersion: Number(task.version), command: { action: 'taskTransition', taskId, transition: { action: 'changes', submissionId: String(task.current_submission_id), reason: 'Доделываю по комментарию владельца' + (comment ? ': ' + comment.slice(0, 500) : ''), byOwnerRating: true } } });
        try { await ctx.fns.procs.db.run({ sql: "DELETE FROM team.accept WHERE agent_id = '' AND task_id = ?", params: [taskId] }); } catch {}
    }
    try { await ctx.fns.procs.db.run({ sql: "INSERT INTO team.reopen (id, agent_id, task_id, comment, action, to_agent_id, new_agent_id, new_task_id, next_idx, by_actor, at) VALUES (?, ?, ?, ?, 'rework', ?, '', '', NULL, ?, ?)", params: [Bun.randomUUIDv7(), agentId, taskId, comment || '(по оценке)', me, 'agent:' + me, now] }); } catch {}
    const p = (await ctx.fns.procs.db.select({ sql: 'SELECT p.name, s.team_id FROM team.persona_session s JOIN team.persona p ON p.name = s.persona_name WHERE s.agent_id = ? UNION ALL SELECT name, NULL FROM team.persona WHERE current_agent_id = ? LIMIT 1', params: [me, me] }).catch(() => []) as Row[])[0];
    const who = p ? String(p.name) : me;
    try { await ctx.fns.procs.db.run({ sql: "INSERT INTO team.post (id, author_kind, author_id, team_id, task_id, kind, text, created_at) VALUES (?, 'agent', ?, ?, ?, 'note', ?, ?)", params: [Bun.randomUUIDv7(), me, teamId ?? p?.team_id ?? null, agentId ? null : taskId, `${who} доделывает по комментарию: «${title.slice(0, 80)}»${comment ? ' — ' + comment.slice(0, 140) : ''}`.slice(0, 280), now] }); } catch {}
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { status: 'rework', taskId, comment };
}

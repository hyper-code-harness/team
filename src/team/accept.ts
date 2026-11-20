/**
 * Manager's first review pass on a handed-in task (final: false, stays in Review); a person's call needs stars and is team.rate
 *
 * Review has two passes. First pass — the manager agent (for a delegated child plan task the child's parent agent; for a team task the team supervisor): records a mark 'manager:<agentId>' in team.accept; the task stays in Review marked «проверил <manager> ✓» and waits for the person (team.nextReview gives such tasks first); a manager never overwrites a person's mark. Second pass — the signed-in person only rates: a person's call requires `stars` and is team.rate (the rating goes to the executor in one message; the executor closes the task with team.close after reflecting, or takes it back with team.rework). Without stars a person gets an error. `final`/`accepted` for a person = the task got closed right away (executor session archived). Team-task marks use agent_id ''. Undoing a manager's accept = return to work (team.reopen / team.feedback). Refreshes the 'team' live topic.
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child whose plan holds the task.
 * @param opts.stars Person only (required for them): rating 1–5 — a person's accept is team.rate. @minimum 1 @maximum 5
 * @param opts.comment Person only: optional rating comment, up to 2000 characters.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child whose plan holds the task. */
        agentId?: string;
        /** Person only (required for them): rating 1–5 — a person's accept is team.rate. @minimum 1 @maximum 5 */
        stars?: number;
        /** Person only: optional rating comment, up to 2000 characters. */
        comment?: string;
    },
): Promise<{kind:"team"|"child"; accepted:boolean; final?:boolean; at:number; by:string; [k:string]:unknown}> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    const by = actor.kind === 'agent' ? 'manager:' + actor.id : String(actor.id);
    const taskId = String(opts.taskId ?? '').trim();
    if (!taskId) throw new Error('taskId required');
    const at = Date.now();
    const refresh = async () => { try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {} };
    if (actor.kind === 'user') {
        // the person does not close tasks any more: they rate (team.rate) and the executor closes (team.close) or reworks (team.rework)
        if (opts.stars == null) throw new Error('Владелец не закрывает задачу, а оценивает: передайте stars 1–5 (team.rate) — исполнитель сам закроет её или доделает');
        const r = await ctx.fns.team.rate({ taskId, stars: Number(opts.stars), ...(opts.comment ? { comment: opts.comment } : {}), ...(opts.agentId ? { agentId: String(opts.agentId) } : {}) });
        return { kind: opts.agentId ? 'child' : 'team', accepted: r.closed, final: r.closed, at: r.at, by, rating: { stars: r.stars, comment: r.comment }, reflect: r.reflect };
    }
    if (opts.agentId) {
        const agentId = String(opts.agentId);
        const rows = await ctx.fns.procs.db.select({ sql: 'SELECT parent_id, scratchpad FROM agents WHERE id = ?', params: [agentId] }) as Row[];
        if (!rows[0]) throw new Error('Agent not found');
        if (actor.kind === 'agent') { if (String(rows[0].parent_id ?? '') !== actor.id) throw new Error('Only the manager (parent agent) of ' + agentId + ' can accept its tasks'); }
        else if (!(await ctx.fns.jobs.canSee({ agentId }))) throw new Error('Not your agent');
        const sp = typeof rows[0].scratchpad === 'string' ? JSON.parse(rows[0].scratchpad || '{}') : (rows[0].scratchpad ?? {});
        const t = (sp.plan?.tasks ?? []).find((x: Row) => x?.id === taskId);
        if (!t) throw new Error('No plan task ' + taskId);
        if (t.status !== 'done') throw new Error('Задача ещё не завершена');
        // Self-heal when the migration has not run yet (same DDL as $migration_20291115000100_team_accept).
        await ctx.fns.procs.db.run({ sql: 'CREATE TABLE IF NOT EXISTS team.accept (agent_id text NOT NULL, task_id text NOT NULL, accepted_by text NOT NULL, accepted_at bigint NOT NULL, PRIMARY KEY (agent_id, task_id))' });
        // First pass only: a manager never overwrites a person's mark.
        await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.accept (agent_id, task_id, accepted_by, accepted_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, task_id) DO NOTHING', params: [agentId, taskId, by, at] });
        const cur = await ctx.fns.procs.db.select({ sql: 'SELECT accepted_by, accepted_at FROM team.accept WHERE agent_id = ? AND task_id = ?', params: [agentId, taskId] }) as Row[];
        await refresh();
        const finalBy = String(cur[0]?.accepted_by ?? by);
        return { kind: 'child', accepted: true, final: !/^manager:/.test(finalBy), at: Number(cur[0]?.accepted_at ?? at), by: finalBy };
    }
    const found = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id = ?', params: [taskId] }) as Row[];
    let team: any = null; let task: Row | undefined;
    for (const r of found) { try { const g = await ctx.fns.team.get({ teamId: String(r.team_id) }); const x = g.tasks.find((y: Row) => y.id === taskId); if (x) { team = g; task = x; break; } } catch {} }
    if (!team || !task) throw new Error('Task not found or access denied');
    if (task.status === 'done') return { kind: 'team', accepted: true, final: true, at, by };
    if (task.status !== 'review' || !task.current_submission_id) throw new Error('Задача не на ревью');
    // First pass: the supervisor checked it; the task stays in review until the person accepts.
    if (String(team.team.supervisor_agent_id ?? '') !== actor.id) throw new Error('Only the team supervisor can accept its tasks');
    await ctx.fns.procs.db.run({ sql: 'CREATE TABLE IF NOT EXISTS team.accept (agent_id text NOT NULL, task_id text NOT NULL, accepted_by text NOT NULL, accepted_at bigint NOT NULL, PRIMARY KEY (agent_id, task_id))' });
    await ctx.fns.procs.db.run({ sql: "INSERT INTO team.accept (agent_id, task_id, accepted_by, accepted_at) VALUES ('', ?, ?, ?) ON CONFLICT (agent_id, task_id) DO NOTHING", params: [taskId, by, at] });
    await refresh();
    return { kind: 'team', accepted: true, final: false, at, by };
}

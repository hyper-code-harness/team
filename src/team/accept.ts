/**
 * Accepts a finished task: a manager's accept is the first review pass, a person's accept is final and moves it to History
 *
 * Review has two passes. First pass — the manager agent (for a delegated child plan task the child's parent agent; for a team task the team supervisor): records a mark 'manager:<agentId>' in team.accept; the task stays in Review marked «проверил <manager> ✓» and waits for the person (team.nextReview gives such tasks first). Final pass — the signed-in person (owner): records the person's id (taking over a manager's mark; a manager never overwrites a person's one) and only then the task goes to History; a team task is approved through team.executeCommand (review -> done). Team-task marks use agent_id ''. Idempotent. Undoing a manager's accept = return to work (team.reopen / team.feedback). When a person's accept closes the last open task of a persona session (every plan task accepted by a person, or no other open team task assigned to it), calls team.retire: the session updates its persona and is archived; the result carries `retire`. `final` tells whether the accept was final (person) or the first pass (manager). Refreshes the 'team' live topic.
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child whose plan holds the task.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child whose plan holds the task. */
        agentId?: string;
    },
): Promise<{kind:"team"|"child"; accepted:boolean; final?:boolean; at:number; by:string; [k:string]:unknown}> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    const by = actor.kind === 'agent' ? 'manager:' + actor.id : String(actor.id);
    const taskId = String(opts.taskId ?? '').trim();
    if (!taskId) throw new Error('taskId required');
    const at = Date.now();
    const refresh = async () => { try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {} };
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
        // A person takes over a manager's mark; a manager never overwrites a person's one.
        const conflict = actor.kind === 'user' ? "DO UPDATE SET accepted_by = EXCLUDED.accepted_by, accepted_at = EXCLUDED.accepted_at WHERE team.accept.accepted_by LIKE 'manager:%'" : 'DO NOTHING';
        await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.accept (agent_id, task_id, accepted_by, accepted_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, task_id) ' + conflict, params: [agentId, taskId, by, at] });
        const cur = await ctx.fns.procs.db.select({ sql: 'SELECT accepted_by, accepted_at FROM team.accept WHERE agent_id = ? AND task_id = ?', params: [agentId, taskId] }) as Row[];
        // Last task of a persona session accepted → the session updates its persona and goes to the archive (team.retire).
        let retire: unknown = null;
        try {
            const tasks = (sp.plan?.tasks ?? []) as Row[];
            const acc = new Set((await ctx.fns.procs.db.select({ sql: "SELECT task_id FROM team.accept WHERE agent_id = ? AND accepted_by NOT LIKE 'manager:%'", params: [agentId] }) as Row[]).map(x => String(x.task_id)));
            if (actor.kind === 'user' && tasks.length && tasks.every(x => x?.status === 'done' && acc.has(String(x.id))) && await ctx.fns.team.personaGet({ agentId, revisions: 0 }))
                retire = await ctx.fns.team.retire({ agentId, reason: 'последняя задача принята' });
        } catch (e) { retire = { error: String((e as Error)?.message ?? e).slice(0, 200) }; }
        await refresh();
        const finalBy = String(cur[0]?.accepted_by ?? by);
        return { kind: 'child', accepted: true, final: !/^manager:/.test(finalBy), at: Number(cur[0]?.accepted_at ?? at), by: finalBy, ...(retire ? { retire } : {}) };
    }
    const found = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id = ?', params: [taskId] }) as Row[];
    let team: any = null; let task: Row | undefined;
    for (const r of found) { try { const g = await ctx.fns.team.get({ teamId: String(r.team_id) }); const x = g.tasks.find((y: Row) => y.id === taskId); if (x) { team = g; task = x; break; } } catch {} }
    if (!team || !task) throw new Error('Task not found or access denied');
    if (task.status === 'done') return { kind: 'team', accepted: true, final: true, at, by };
    if (task.status !== 'review' || !task.current_submission_id) throw new Error('Задача не на ревью');
    if (actor.kind === 'agent') {
        // First pass: the supervisor checked it; the task stays in review until the person accepts.
        if (String(team.team.supervisor_agent_id ?? '') !== actor.id) throw new Error('Only the team supervisor can accept its tasks');
        await ctx.fns.procs.db.run({ sql: 'CREATE TABLE IF NOT EXISTS team.accept (agent_id text NOT NULL, task_id text NOT NULL, accepted_by text NOT NULL, accepted_at bigint NOT NULL, PRIMARY KEY (agent_id, task_id))' });
        await ctx.fns.procs.db.run({ sql: "INSERT INTO team.accept (agent_id, task_id, accepted_by, accepted_at) VALUES ('', ?, ?, ?) ON CONFLICT (agent_id, task_id) DO NOTHING", params: [taskId, by, at] });
        await refresh();
        return { kind: 'team', accepted: true, final: false, at, by };
    }
    const out = await ctx.fns.team.executeCommand({ teamId: String(team.team.id), requestKey: 'team-accept:' + Bun.randomUUIDv7(), expectedVersion: Number(task.version), command: { action: 'taskTransition', taskId, transition: { action: 'approve', submissionId: String(task.current_submission_id), reason: 'Принято владельцем' } } });
    try { await ctx.fns.procs.db.run({ sql: "INSERT INTO team.accept (agent_id, task_id, accepted_by, accepted_at) VALUES ('', ?, ?, ?) ON CONFLICT (agent_id, task_id) DO UPDATE SET accepted_by = EXCLUDED.accepted_by, accepted_at = EXCLUDED.accepted_at", params: [taskId, by, at] }); } catch {}
    let retire: unknown = null;
    try {
        const who = String(task.assignee_agent_id ?? '');
        if (who) {
            const open = await ctx.fns.procs.db.select({ sql: "SELECT 1 FROM team.task WHERE assignee_agent_id = ? AND id <> ? AND status NOT IN ('done','cancelled') LIMIT 1", params: [who, taskId] }) as Row[];
            if (!open.length && await ctx.fns.team.personaGet({ agentId: who, revisions: 0 })) retire = await ctx.fns.team.retire({ agentId: who, reason: 'последняя задача принята' });
        }
    } catch (e) { retire = { error: String((e as Error)?.message ?? e).slice(0, 200) }; }
    await refresh();
    return { kind: 'team', accepted: true, final: true, at, by, eventId: out.eventId, ...(retire ? { retire } : {}) };
}

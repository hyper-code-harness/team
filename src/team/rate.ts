/**
 * Stores the owner's 1–5 star rating (with an optional comment) of a handed-in task
 *
 * Owner (signed-in person) only. Team task (status review or done) or delegated child plan task (agentId, status done). One rating per task; rating again replaces it. Stored in team.rating (agent_id '' for team tasks) with the assignee, so team.ratings can average per executor. Shows as kind 'rating' in team.feed and in the task history; refreshes the 'team' live topic.
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child whose plan holds the task.
 * @param opts.stars Rating from 1 to 5. @minimum 1 @maximum 5
 * @param opts.comment Optional comment, up to 2000 characters.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child whose plan holds the task. */
        agentId?: string;
        /** Rating from 1 to 5. @minimum 1 @maximum 5 */
        stars: number;
        /** Optional comment, up to 2000 characters. */
        comment?: string;
    },
): Promise<{stars:number; comment:string; assigneeAgentId:string; at:number}> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    if (actor.kind !== 'user') throw new Error('Rating is given on behalf of the signed-in person');
    const taskId = String(opts.taskId ?? '').trim(); const agentId = String(opts.agentId ?? '').trim();
    const stars = Number(opts.stars);
    if (!taskId) throw new Error('taskId required');
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error('Оценка — целое число от 1 до 5');
    const comment = String(opts.comment ?? '').replace(/\u0000/g, '').trim();
    if (comment.length > 2000) throw new Error('Комментарий длиннее 2000 символов');
    let assignee = '';
    if (agentId) {
        if (!(await ctx.fns.jobs.canSee({ agentId }))) throw new Error('Not your agent');
        const rows = await ctx.fns.procs.db.select({ sql: 'SELECT scratchpad FROM agents WHERE id = ?', params: [agentId] }) as Row[];
        if (!rows[0]) throw new Error('Agent not found');
        const sp = typeof rows[0].scratchpad === 'string' ? JSON.parse(rows[0].scratchpad || '{}') : (rows[0].scratchpad ?? {});
        const t = (sp.plan?.tasks ?? []).find((x: Row) => x?.id === taskId);
        if (!t) throw new Error('No plan task ' + taskId);
        if (t.status !== 'done') throw new Error('Оценить можно только сданную задачу');
        assignee = agentId;
    } else {
        const found = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id = ?', params: [taskId] }) as Row[];
        let task: Row | undefined;
        for (const r of found) { try { const g = await ctx.fns.team.get({ teamId: String(r.team_id) }); task = g.tasks.find((y: Row) => y.id === taskId); if (task) break; } catch {} }
        if (!task) throw new Error('Task not found or access denied');
        if (!['review', 'done'].includes(String(task.status))) throw new Error('Оценить можно только сданную задачу');
        assignee = String(task.assignee_agent_id ?? '');
    }
    const at = Date.now();
    // Self-heal when the migration has not run yet (same DDL as $migration_20291215000100_team_next_rating).
    await ctx.fns.procs.db.run({ sql: "CREATE TABLE IF NOT EXISTS team.rating (agent_id text NOT NULL DEFAULT '', task_id text NOT NULL, assignee_agent_id text NOT NULL, stars integer NOT NULL CHECK (stars BETWEEN 1 AND 5), comment text NOT NULL DEFAULT '', rated_by text NOT NULL, rated_at bigint NOT NULL, PRIMARY KEY (agent_id, task_id))" });
    await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.rating (agent_id, task_id, assignee_agent_id, stars, comment, rated_by, rated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (agent_id, task_id) DO UPDATE SET stars = EXCLUDED.stars, comment = EXCLUDED.comment, rated_by = EXCLUDED.rated_by, rated_at = EXCLUDED.rated_at', params: [agentId, taskId, assignee, stars, comment, actor.id, at] });
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { stars, comment, assigneeAgentId: assignee, at };
}

/**
 * The owner's review of a handed-in task: 1–5 stars and an optional comment, sent in one action; the executor then decides — close or rework
 *
 * Owner (signed-in person) only. Team task (status review or done) or delegated child plan task (agentId, status done). Stores the rating in team.rating (agent_id '' for team tasks; rating again replaces it — re-rating a closed task just updates the stars) and does NOT close the task: team.reflect sends the stars and comment as ONE message to the executor persona's live session, which reads it and either reworks (team.rework → back in work, same session) or reflects into memory and closes (team.close → final accept on the owner's behalf; its last task closed → the session leaves without an extra turn). Executor session archived (or no session, or not a persona so nobody gets the message to decide) and the task still open: closed at once on the owner's behalf (`closed: true`) and the feedback is queued for the persona's next brief — to get more work done after that, return it with a comment (team.reopen → new session of the persona). Shows as kind 'rating' in team.feed and the task history; refreshes the 'team' live topic.
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
): Promise<{stars:number; comment:string; assigneeAgentId:string; at:number; closed:boolean; reflect:unknown}> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    if (actor.kind !== 'user') throw new Error('Rating is given on behalf of the signed-in person');
    const taskId = String(opts.taskId ?? '').trim(); const agentId = String(opts.agentId ?? '').trim();
    const stars = Number(opts.stars);
    if (!taskId) throw new Error('taskId required');
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error('Оценка — целое число от 1 до 5');
    const comment = String(opts.comment ?? '').replace(/\u0000/g, '').trim();
    if (comment.length > 2000) throw new Error('Комментарий длиннее 2000 символов');
    let assignee = ''; let title = ''; let closed = false; let archived = false;
    const at = Date.now();
    // Self-heal when the migration has not run yet (same DDL as $migration_20291215000100_team_next_rating).
    await ctx.fns.procs.db.run({ sql: "CREATE TABLE IF NOT EXISTS team.rating (agent_id text NOT NULL DEFAULT '', task_id text NOT NULL, assignee_agent_id text NOT NULL, stars integer NOT NULL CHECK (stars BETWEEN 1 AND 5), comment text NOT NULL DEFAULT '', rated_by text NOT NULL, rated_at bigint NOT NULL, PRIMARY KEY (agent_id, task_id))" });
    let team: Row | undefined; let task: Row | undefined;
    if (agentId) {
        if (!(await ctx.fns.jobs.canSee({ agentId }))) throw new Error('Not your agent');
        const rows = await ctx.fns.procs.db.select({ sql: 'SELECT scratchpad, archived_at FROM agents WHERE id = ?', params: [agentId] }) as Row[];
        if (!rows[0]) throw new Error('Agent not found');
        const sp = typeof rows[0].scratchpad === 'string' ? JSON.parse(rows[0].scratchpad || '{}') : (rows[0].scratchpad ?? {});
        const t = (sp.plan?.tasks ?? []).find((x: Row) => x?.id === taskId);
        if (!t) throw new Error('No plan task ' + taskId);
        if (t.status !== 'done') throw new Error('Оценить можно только сданную задачу');
        assignee = agentId; title = String(t.title ?? taskId); archived = rows[0].archived_at != null;
    } else {
        const found = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id = ?', params: [taskId] }) as Row[];
        for (const r of found) { try { const g = await ctx.fns.team.get({ teamId: String(r.team_id) }); task = g.tasks.find((y: Row) => y.id === taskId); if (task) { team = g; break; } } catch {} }
        if (!task || !team) throw new Error('Task not found or access denied');
        if (!['review', 'done'].includes(String(task.status))) throw new Error('Оценить можно только сданную задачу');
        assignee = String(task.assignee_agent_id ?? ''); title = String(task.title ?? taskId);
        const ag = assignee ? (await ctx.fns.procs.db.select({ sql: 'SELECT archived_at FROM agents WHERE id = ?', params: [assignee] }) as Row[])[0] : undefined;
        archived = !ag || ag.archived_at != null;
    }
    const already = await ctx.fns.team.accepted({ agentIds: [agentId] });
    const isClosed = agentId ? (already.keys.includes(agentId + ':' + taskId) && !/^manager:/.test(String(already.by?.[agentId + ':' + taskId] ?? ''))) : task?.status === 'done';
    await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.rating (agent_id, task_id, assignee_agent_id, stars, comment, rated_by, rated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (agent_id, task_id) DO UPDATE SET stars = EXCLUDED.stars, comment = EXCLUDED.comment, rated_by = EXCLUDED.rated_by, rated_at = EXCLUDED.rated_at', params: [agentId, taskId, assignee, stars, comment, actor.id, at] });
    // The owner does not close the task: the executor decides (team.close after reflecting, or team.rework).
    // Its session is gone (archived / none) and the task is still open → nobody would close it: close it now on the owner's
    // behalf and queue the feedback for the next brief. A comment that asks for more work then goes through «Доделать» (team.reopen → new session of the persona).
    const closeNow = async () => {
        if (agentId) {
            await ctx.fns.procs.db.run({ sql: 'CREATE TABLE IF NOT EXISTS team.accept (agent_id text NOT NULL, task_id text NOT NULL, accepted_by text NOT NULL, accepted_at bigint NOT NULL, PRIMARY KEY (agent_id, task_id))' });
            await ctx.fns.procs.db.run({ sql: "INSERT INTO team.accept (agent_id, task_id, accepted_by, accepted_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, task_id) DO UPDATE SET accepted_by = EXCLUDED.accepted_by, accepted_at = EXCLUDED.accepted_at WHERE team.accept.accepted_by LIKE 'manager:%'", params: [agentId, taskId, actor.id, at] });
        } else if (task && team && task.status === 'review' && task.current_submission_id) {
            await ctx.fns.team.executeCommand({ teamId: String(team.team.id), requestKey: 'team-rate:' + Bun.randomUUIDv7(), expectedVersion: Number(task.version), command: { action: 'taskTransition', taskId, transition: { action: 'approve', submissionId: String(task.current_submission_id), reason: 'Оценка ★' + stars + ' — сессии исполнителя нет, закрыто по оценке' } } });
            await ctx.fns.procs.db.run({ sql: "INSERT INTO team.accept (agent_id, task_id, accepted_by, accepted_at) VALUES ('', ?, ?, ?) ON CONFLICT (agent_id, task_id) DO UPDATE SET accepted_by = EXCLUDED.accepted_by, accepted_at = EXCLUDED.accepted_at", params: [taskId, actor.id, at] });
        }
        closed = true;
    };
    if (!isClosed && archived) await closeNow();
    // the executor persona gets the rating and comment as one message (live), or in its next brief (archived)
    let reflect: unknown = null;
    try { reflect = await ctx.fns.team.reflect({ kind: 'rating', taskId, agentId, assigneeAgentId: assignee, title, stars, comment, decide: !isClosed && !closed }); } catch (e) { reflect = { error: String((e as Error)?.message ?? e).slice(0, 200) }; }
    // nobody got it to decide (not a persona session, or it could not be reached): the task must not hang open — close it on the owner's behalf
    const rs = String((reflect as Row | null)?.status ?? 'error');
    if (!isClosed && !closed && !['sent', 'duplicate'].includes(rs)) await closeNow();
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { stars, comment, assigneeAgentId: assignee, at, closed, reflect };
}

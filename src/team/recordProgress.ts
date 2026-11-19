/**
 * Store an estimate or a progress report on a team task or on the caller's own plan task
 *
 * Shared body of team.estimate and team.progress. A team.task (found by taskId, optionally narrowed by teamId) keeps the latest values in its columns and gets a public 'estimate' or 'progress' timeline event; only the assignee agent or the owner may write. Otherwise taskId must be a task of the calling agent's own plan (delegated child) and the values go to scratchpad.plan.tasks[i].estimate / .progress. Does not change task status or versions. Refreshes topic "team".
 * @param opts.kind What is reported: estimate or progress.
 * @param opts.taskId Team task id, or plan task id in the caller's own plan.
 * @param opts.teamId Team id when the task id is ambiguous.
 * @param opts.values Already validated values: estimate {size, minutes?, steps?, note?}; progress {stage?, percent?, etaMinutes?, note?}.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** What is reported: estimate or progress. */
        kind: 'estimate' | 'progress';
        /** Team task id, or plan task id in the caller's own plan. */
        taskId: string;
        /** Team id when the task id is ambiguous. */
        teamId?: string;
        /** Already validated values: estimate {size, minutes?, steps?, note?}; progress {stage?, percent?, etaMinutes?, note?}. */
        values: { size?: 'S' | 'M' | 'L'; minutes?: number; steps?: number; percent?: number; stage?: string; etaMinutes?: number; note?: string };
    },
): Promise<{ scope: 'team' | 'plan'; taskId: string; teamId: string | null; agentId: string | null; eventId: string | null; values: Record<string, unknown>; at: number }> {
    const taskId = String(opts.taskId ?? '').trim();
    if (!taskId) throw new Error(opts.kind + ': taskId required');
    const v = opts.values; const now = Date.now();
    const rows = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id=?' + (opts.teamId ? ' AND team_id=?' : ''), params: opts.teamId ? [taskId, opts.teamId] : [taskId] });
    if (rows.length > 1) throw new Error(opts.kind + ': task id exists in several teams, pass teamId');
    if (rows.length === 1) {
        const teamId = String(rows[0].team_id);
        const actor = await ctx.fns.team.resolveActor({});
        const eventId = Bun.randomUUIDv7();
        const text = opts.kind === 'estimate'
            ? `Estimate: ${v.size}${v.steps != null ? `, ${v.steps} steps` : ''}${v.note ? ' — ' + v.note : ''}`
            : `Progress: ${[v.percent != null ? v.percent + '%' : '', v.stage ?? ''].filter(Boolean).join(' · ')}${v.etaMinutes != null ? ` · ~${v.etaMinutes} min left` : ''}${v.note ? ' — ' + v.note : ''}`;
        await ctx.fns.procs.db.transaction({ fn: async () => {
            const team = (await ctx.fns.procs.db.select({ sql: 'SELECT owner_user_id,status FROM team.team WHERE id=? FOR UPDATE', params: [teamId] }))[0];
            if (!team) throw new Error('Team not found');
            const t = (await ctx.fns.procs.db.select({ sql: 'SELECT assignee_agent_id,status FROM team.task WHERE team_id=? AND id=? FOR UPDATE', params: [teamId, taskId] }))[0];
            const owner = actor.kind === 'user' && actor.id === team.owner_user_id;
            const assignee = actor.kind === 'agent' && actor.id === t.assignee_agent_id;
            if (!owner && !assignee) throw new Error(opts.kind + ': only the assignee or the owner may report on this task');
            if (['done', 'cancelled'].includes(String(t.status))) throw new Error(opts.kind + ': task is ' + t.status);
            if (opts.kind === 'estimate') await ctx.fns.procs.db.run({ sql: 'UPDATE team.task SET estimate_size=?,estimate_min=?,estimate_steps=?,estimated_at=? WHERE team_id=? AND id=?', params: [v.size ?? null, v.minutes ?? null, v.steps ?? null, now, teamId, taskId] });
            else await ctx.fns.procs.db.run({ sql: 'UPDATE team.task SET progress_percent=?,progress_stage=?,progress_eta_min=?,progress_note=?,progress_at=?,last_progress_at=? WHERE team_id=? AND id=?', params: [v.percent ?? null, v.stage ?? null, v.etaMinutes ?? null, v.note ?? null, now, now, teamId, taskId] });
            const s = await ctx.fns.procs.db.select({ sql: 'UPDATE team.team SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq', params: [teamId] });
            await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.event(id,team_id,seq,task_id,actor_kind,actor_id,kind,text,payload,causation_id,command_key,timestamp) VALUES(?,?,?,?,?,?,?,?,?::jsonb,?,?,?)', params: [eventId, teamId, Number(s[0].next_seq), taskId, actor.kind, actor.id, opts.kind, text, JSON.stringify(v), null, null, now] });
        } });
        try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
        return { scope: 'team', taskId, teamId, agentId: actor.kind === 'agent' ? actor.id : null, eventId, values: v, at: now };
    }
    const self = (session as any)?.agent?.id ?? (await ctx.fns.agent.current({}))?.id;
    if (!self) throw new Error(opts.kind + ': no team task ' + taskId + ' and no agent session for a plan task');
    const out: any = await ctx.fns.session.mutateScratchpad({ id: String(self), mutate: (sp: Record<string, any>) => {
        const task = Array.isArray(sp?.plan?.tasks) ? sp.plan.tasks.find((x: any) => x?.id === taskId) : null;
        if (!task) throw new Error(opts.kind + ': no team task and no own plan task ' + taskId);
        task[opts.kind] = { ...v, at: now };
        return true;
    } });
    const live = (session as any)?.agent;
    if (live && live.id === self) live.scratchpad = out.scratchpad;
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { scope: 'plan', taskId, teamId: null, agentId: String(self), eventId: null, values: v, at: now };
}

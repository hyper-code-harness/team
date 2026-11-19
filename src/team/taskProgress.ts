/**
 * Read estimate, progress, ETA and overdue flag for board cards
 *
 * Read-only. Pass teamId (all tasks of a team), taskId (one team task), or agentId (plan tasks of that agent; with taskId just one). Team tasks: owner or roster member only. Percent comes from the latest team.progress report; if none, from the assignee's (or agentId's) agent plan as closed/total tasks; done tasks are 100. size is the S|M|L estimate (old minute estimates are mapped: ≤15 → S, ≤60 → M, else L); estimateMin is kept for old data only. etaMin is the reported value, else estimate minutes minus elapsed. elapsedMin runs from the first start to now, or to the last task event for review/done/cancelled. overdue = elapsedMin > 1.5 × (estimateMin, else 15 for S / 60 for M; never for L).
 * @param opts.teamId Team whose tasks to read.
 * @param opts.taskId One team task id, or a plan task id together with agentId.
 * @param opts.agentId Agent whose plan tasks to read (delegated child).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team whose tasks to read. */
        teamId?: string;
        /** One team task id, or a plan task id together with agentId. */
        taskId?: string;
        /** Agent whose plan tasks to read (delegated child). */
        agentId?: string;
    },
): Promise<Array<{ scope: 'team' | 'plan'; taskId: string; teamId: string | null; agentId: string | null; status: string; size: 'S' | 'M' | 'L' | null; estimateMin: number | null; estimateSteps: number | null; percent: number | null; percentSource: 'reported' | 'plan' | 'status' | null; stage: string | null; etaMin: number | null; etaSource: 'reported' | 'estimate' | null; note: string | null; progressAt: number | null; startedAt: number | null; elapsedMin: number | null; overdue: boolean }>> {
    const now = Date.now();
    const num = (x: unknown) => x == null ? null : Number(x);
    const sizeOf = (sz: unknown, min: unknown): 'S' | 'M' | 'L' | null => { const v = String(sz ?? '').toUpperCase(); if (v === 'S' || v === 'M' || v === 'L') return v; const m = num(min); return m == null || !Number.isFinite(m) ? null : m <= 15 ? 'S' : m <= 60 ? 'M' : 'L'; };
    const parse = (sp: unknown): Record<string, any> => { try { return typeof sp === 'string' ? JSON.parse(sp) : (sp as any) ?? {}; } catch { return {}; } };
    const planOf = async (id: string | null) => {
        if (!id) return null;
        const r = await ctx.fns.procs.db.select({ sql: 'SELECT scratchpad FROM agents WHERE id=?', params: [id] });
        const tasks = parse(r[0]?.scratchpad)?.plan?.tasks;
        return Array.isArray(tasks) && tasks.length ? tasks as any[] : null;
    };
    const finish = (base: { estimateMin: number | null; size?: 'S' | 'M' | 'L' | null; startedAt: number | null; endAt: number | null; etaReported: number | null }) => {
        const elapsedMin = base.startedAt == null ? null : Math.max(0, Math.round(((base.endAt ?? now) - base.startedAt) / 60000));
        let etaMin = base.etaReported; let etaSource: 'reported' | 'estimate' | null = etaMin == null ? null : 'reported';
        if (etaMin == null && base.estimateMin != null && base.endAt == null) { etaMin = Math.max(0, base.estimateMin - (elapsedMin ?? 0)); etaSource = 'estimate'; }
        if (base.endAt != null) { etaMin = 0; etaSource = etaSource ?? null; }
        return { elapsedMin, etaMin, etaSource, overdue: (() => { const cap = base.estimateMin ?? (base.size === 'S' ? 15 : base.size === 'M' ? 60 : null); return cap != null && elapsedMin != null && elapsedMin > cap * 1.5; })() };
    };
    const out: any[] = [];
    if (opts.agentId && !opts.teamId) {
        const tasks = await planOf(opts.agentId) ?? [];
        for (const t of tasks) {
            if (opts.taskId && t.id !== opts.taskId) continue;
            const est = t.estimate ?? {}; const pr = t.progress ?? {};
            const done = t.status === 'done';
            const percent = done ? 100 : pr.percent ?? (t.status === 'pending' ? 0 : null);
            const percentSource = done ? 'status' : pr.percent != null ? 'reported' : t.status === 'pending' ? 'status' : null;
            const startedAt = num(t.startedAt);
            out.push({ scope: 'plan', taskId: String(t.id), teamId: null, agentId: opts.agentId, status: String(t.status ?? ''), size: sizeOf(est.size, est.minutes), estimateMin: num(est.minutes), estimateSteps: num(est.steps), percent, percentSource, stage: pr.stage ?? null, note: pr.note ?? null, progressAt: num(pr.at), startedAt,
                ...finish({ estimateMin: num(est.minutes), size: sizeOf(est.size, est.minutes), startedAt, endAt: done ? num(t.completedAt) : null, etaReported: done ? 0 : num(pr.etaMinutes) }) });
        }
        return out;
    }
    if (!opts.teamId && !opts.taskId) throw new Error('taskProgress: pass teamId, taskId or agentId');
    const actor = await ctx.fns.team.resolveActor({});
    const where: string[] = []; const params: unknown[] = [];
    if (opts.teamId) { where.push('k.team_id=?'); params.push(opts.teamId); }
    if (opts.taskId) { where.push('k.id=?'); params.push(opts.taskId); }
    const rows = await ctx.fns.procs.db.select({ sql: `SELECT k.*, (SELECT MAX(e.timestamp) FROM team.event e WHERE e.team_id=k.team_id AND e.task_id=k.id) AS last_event_at FROM team.task k JOIN team.team t ON t.id=k.team_id
        WHERE ${where.join(' AND ')} AND ((?='user' AND t.owner_user_id=?) OR (?='agent' AND EXISTS (SELECT 1 FROM team.member m WHERE m.team_id=t.id AND m.agent_id=?))) ORDER BY k.team_id, k.assignee_agent_id NULLS FIRST, k.rank NULLS LAST, k.id`, params: [...params, actor.kind, actor.id, actor.kind, actor.id] });
    const plans = new Map<string, any[] | null>();
    for (const r of rows) {
        const status = String(r.status); const closed = ['review', 'done', 'cancelled'].includes(status);
        let percent = num(r.progress_percent); let percentSource: string | null = percent == null ? null : 'reported';
        if (status === 'done') { percent = 100; percentSource = 'status'; }
        else if (percent == null) {
            const who = opts.agentId ?? (r.assignee_agent_id == null ? null : String(r.assignee_agent_id));
            if (who && ['working', 'blocked', 'paused', 'review'].includes(status)) {
                if (!plans.has(who)) plans.set(who, await planOf(who));
                const plan = plans.get(who);
                if (plan) { percent = Math.round(100 * plan.filter(p => p.status === 'done').length / plan.length); percentSource = 'plan'; }
            } else if (['todo', 'assigned'].includes(status)) { percent = 0; percentSource = 'status'; }
        }
        const startedAt = num(r.ever_started_at);
        out.push({ scope: 'team', taskId: String(r.id), teamId: String(r.team_id), agentId: r.assignee_agent_id == null ? null : String(r.assignee_agent_id), status,
            size: sizeOf(r.estimate_size, r.estimate_min), estimateMin: num(r.estimate_min), estimateSteps: num(r.estimate_steps), percent, percentSource, stage: r.progress_stage ?? null, note: r.progress_note ?? null, progressAt: num(r.progress_at), startedAt,
            ...finish({ estimateMin: num(r.estimate_min), size: sizeOf(r.estimate_size, r.estimate_min), startedAt, endAt: closed ? num(r.last_event_at) : null, etaReported: num(r.progress_eta_min) }) });
    }
    return out;
}

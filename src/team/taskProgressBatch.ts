/**
 * Read estimate, progress, ETA and overdue flag for a whole board in one go
 *
 * Batch version of team.taskProgress for boards: all tasks of several teams plus plan tasks of several delegated agents, with one SQL read for team tasks and one for agent plans. Same row shape and semantics as team.taskProgress (team tasks: owner or roster member only; inaccessible teams yield no rows). Read-only.
 * @param opts.teamIds Teams whose tasks to read.
 * @param opts.agentIds Agents (delegated children) whose plan tasks to read.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Teams whose tasks to read. */
        teamIds?: string[];
        /** Agents (delegated children) whose plan tasks to read. */
        agentIds?: string[];
    },
): Promise<Array<{ scope: 'team' | 'plan'; taskId: string; teamId: string | null; agentId: string | null; status: string; size: 'S' | 'M' | 'L' | null; estimateMin: number | null; estimateSteps: number | null; percent: number | null; percentSource: 'reported' | 'plan' | 'status' | null; stage: string | null; etaMin: number | null; etaSource: 'reported' | 'estimate' | null; note: string | null; progressAt: number | null; startedAt: number | null; elapsedMin: number | null; overdue: boolean }>> {
    type Out = { scope: 'team' | 'plan'; taskId: string; teamId: string | null; agentId: string | null; status: string; size: 'S' | 'M' | 'L' | null; estimateMin: number | null; estimateSteps: number | null; percent: number | null; percentSource: 'reported' | 'plan' | 'status' | null; stage: string | null; etaMin: number | null; etaSource: 'reported' | 'estimate' | null; note: string | null; progressAt: number | null; startedAt: number | null; elapsedMin: number | null; overdue: boolean };
        const now = Date.now();
        const num = (x: unknown) => x == null ? null : Number(x);
    const sizeOf = (sz: unknown, min: unknown): 'S' | 'M' | 'L' | null => { const v = String(sz ?? '').toUpperCase(); if (v === 'S' || v === 'M' || v === 'L') return v; const m = num(min); return m == null || !Number.isFinite(m) ? null : m <= 15 ? 'S' : m <= 60 ? 'M' : 'L'; };
        const parse = (sp: unknown): Record<string, any> => { try { return typeof sp === 'string' ? JSON.parse(sp) : (sp as any) ?? {}; } catch { return {}; } };
        const finish = (b: { estimateMin: number | null; size?: 'S' | 'M' | 'L' | null; startedAt: number | null; endAt: number | null; etaReported: number | null }) => {
            const elapsedMin = b.startedAt == null ? null : Math.max(0, Math.round(((b.endAt ?? now) - b.startedAt) / 60000));
            let etaMin = b.etaReported; let etaSource: 'reported' | 'estimate' | null = etaMin == null ? null : 'reported';
            if (etaMin == null && b.estimateMin != null && b.endAt == null) { etaMin = Math.max(0, b.estimateMin - (elapsedMin ?? 0)); etaSource = 'estimate'; }
            if (b.endAt != null) etaMin = 0;
            return { elapsedMin, etaMin, etaSource, overdue: (() => { const cap = b.estimateMin ?? (b.size === 'S' ? 15 : b.size === 'M' ? 60 : null); return cap != null && elapsedMin != null && elapsedMin > cap * 1.5; })() };
        };
        const teamIds = [...new Set((opts.teamIds ?? []).map(String).filter(Boolean))];
        const agentIds = [...new Set((opts.agentIds ?? []).map(String).filter(Boolean))];
        const out: Out[] = [];
        let rows: Array<Record<string, any>> = [];
        if (teamIds.length) {
            const actor = await ctx.fns.team.resolveActor({});
            rows = await ctx.fns.procs.db.select({ sql: `SELECT k.*, (SELECT MAX(e.timestamp) FROM team.event e WHERE e.team_id=k.team_id AND e.task_id=k.id) AS last_event_at FROM team.task k JOIN team.team t ON t.id=k.team_id
                WHERE k.team_id = ANY(?::text[]) AND ((?='user' AND t.owner_user_id=?) OR (?='agent' AND EXISTS (SELECT 1 FROM team.member m WHERE m.team_id=t.id AND m.agent_id=?))) ORDER BY k.team_id, k.rank NULLS LAST, k.id`, params: [teamIds, actor.kind, actor.id, actor.kind, actor.id] });
        }
        // One read for every plan needed: requested agents plus assignees of team tasks without a reported percent.
        const need = new Set(agentIds);
        for (const r of rows) if (r.progress_percent == null && r.assignee_agent_id != null && ['working', 'blocked', 'paused', 'review'].includes(String(r.status))) need.add(String(r.assignee_agent_id));
        const plans = new Map<string, any[]>();
        if (need.size) {
            const ar = await ctx.fns.procs.db.select({ sql: 'SELECT id, scratchpad FROM agents WHERE id = ANY(?::text[])', params: [[...need]] });
            for (const a of ar) { const t = parse(a.scratchpad)?.plan?.tasks; if (Array.isArray(t) && t.length) plans.set(String(a.id), t); }
        }
        for (const r of rows) {
            const status = String(r.status); const closed = ['review', 'done', 'cancelled'].includes(status);
            let percent = num(r.progress_percent); let percentSource: Out['percentSource'] = percent == null ? null : 'reported';
            if (status === 'done') { percent = 100; percentSource = 'status'; }
            else if (percent == null) {
                const plan = r.assignee_agent_id == null ? null : plans.get(String(r.assignee_agent_id));
                if (plan && ['working', 'blocked', 'paused', 'review'].includes(status)) { percent = Math.round(100 * plan.filter(p => p.status === 'done').length / plan.length); percentSource = 'plan'; }
                else if (['todo', 'assigned'].includes(status)) { percent = 0; percentSource = 'status'; }
            }
            const startedAt = num(r.ever_started_at);
            out.push({ scope: 'team', taskId: String(r.id), teamId: String(r.team_id), agentId: r.assignee_agent_id == null ? null : String(r.assignee_agent_id), status,
                size: sizeOf(r.estimate_size, r.estimate_min), estimateMin: num(r.estimate_min), estimateSteps: num(r.estimate_steps), percent, percentSource, stage: r.progress_stage ?? null, note: r.progress_note ?? null, progressAt: num(r.progress_at), startedAt,
                ...finish({ estimateMin: num(r.estimate_min), size: sizeOf(r.estimate_size, r.estimate_min), startedAt, endAt: closed ? num(r.last_event_at) : null, etaReported: num(r.progress_eta_min) }) });
        }
        for (const id of agentIds) {
            for (const t of plans.get(id) ?? []) {
                const est = t.estimate ?? {}; const pr = t.progress ?? {}; const done = t.status === 'done';
                const percent = done ? 100 : pr.percent ?? (t.status === 'pending' ? 0 : null);
                const percentSource: Out['percentSource'] = done ? 'status' : pr.percent != null ? 'reported' : t.status === 'pending' ? 'status' : null;
                const startedAt = num(t.startedAt);
                out.push({ scope: 'plan', taskId: String(t.id), teamId: null, agentId: id, status: String(t.status ?? ''), size: sizeOf(est.size, est.minutes), estimateMin: num(est.minutes), estimateSteps: num(est.steps), percent, percentSource, stage: pr.stage ?? null, note: pr.note ?? null, progressAt: num(pr.at), startedAt,
                    ...finish({ estimateMin: num(est.minutes), size: sizeOf(est.size, est.minutes), startedAt, endAt: done ? num(t.completedAt) : null, etaReported: done ? 0 : num(pr.etaMinutes) }) });
            }
        }
        return out;
}

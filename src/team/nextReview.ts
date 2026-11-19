/**
 * Lists tasks waiting for the person in Review, manager-checked first
 *
 * Owner's review queue of a team — the second pass of the two-pass review. Tasks the manager already accepted (team.accept by 'manager:<id>' — «проверил Миша ✓») come first: they are ready for the final look; then the rest; inside each group the oldest hand-in first. Covers finished delegated child plan tasks of the manager not yet accepted by a person, and team-plugin tasks in status review. `next` is the first item (null when Review is empty). The person finishes a task with team.accept (+ team.rate) or returns it with team.reopen / team.feedback. Read only.
 * @param opts.managerAgentId Manager whose delegated children form the team. Default: the caller's parent agent, else the caller; a person without an agent session gets only team-plugin tasks.
 * @param opts.limit Max items, 1–200 (default 20). @minimum 1 @maximum 200
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Manager whose delegated children form the team. Default: the caller's parent agent, else the caller. */
        managerAgentId?: string;
        /** Max items, 1–200 (default 20). @minimum 1 @maximum 200 */
        limit?: number;
    },
): Promise<{next:{taskId:string;agentId?:string;title:string;checkedBy:string;handedInAt:number}|null; items:Array<{taskId:string;agentId?:string;title:string;checkedBy:string;handedInAt:number}>; checked:number; total:number}> {
    type Row = Record<string, any>;
    type Item = { taskId: string; agentId?: string; title: string; checkedBy: string; handedInAt: number };
    const limit = opts.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('team.nextReview: limit must be an integer from 1 to 200');
    const num = (v: unknown) => (Number(v) > 0 ? Number(v) : 0);
    const json = (v: unknown): Row => { if (!v) return {}; if (typeof v === 'object') return v as Row; try { return JSON.parse(String(v)); } catch { return {}; } };

    // whose team: explicit manager, else caller's parent, else caller (same rule as team.feed)
    let managerId = opts.managerAgentId?.trim() || '';
    const meId = (session?.agent || session?.agentId) ? String((await ctx.fns.agent.current({})).id ?? '') : '';
    if (!managerId && meId) {
        const r = await ctx.fns.procs.db.select({ sql: 'SELECT parent_id FROM agents WHERE id = ?', params: [meId] }) as Row[];
        managerId = String(r[0]?.parent_id ?? '') || meId;
    }
    const children: Row[] = managerId ? await ctx.fns.procs.db.select({ sql: "SELECT id, scratchpad FROM agents WHERE parent_id = ? AND visibility = 'team' ORDER BY created_at ASC", params: [managerId] }) as Row[] : [];
    const acc = await ctx.fns.team.accepted({ agentIds: [...children.map(c => String(c.id)), ''] });
    const keys = new Set(acc.keys);
    // a manager mark older than the latest hand-in (returned and handed in again) does not count
    const mgr = (k: string, after: number) => /^manager:/.test(acc.by?.[k] ?? '') && num(acc.at[k]) >= after ? String(acc.by[k]).slice(8) : '';
    const items: Item[] = [];
    for (const c of children) {
        for (const t of (json(c.scratchpad).plan?.tasks ?? []) as Row[]) {
            const k = String(c.id) + ':' + String(t?.id ?? '');
            if (t?.status !== 'done' || num(t.completedAt) < acc.since || keys.has(k)) continue;
            items.push({ taskId: String(t.id), agentId: String(c.id), title: String(t.title ?? t.id), checkedBy: mgr(k, num(t.completedAt)), handedInAt: num(t.completedAt) });
        }
    }
    for (const team of (await ctx.fns.team.list({})).filter(t => t.status !== 'archived')) {
        let tasks: Row[] = [];
        try { tasks = (await ctx.fns.team.get({ teamId: String(team.id) })).tasks as Row[]; } catch { continue; }
        for (const t of tasks) if (t.status === 'review') items.push({ taskId: String(t.id), title: String(t.title ?? t.id), checkedBy: mgr(':' + String(t.id), 0), handedInAt: num(t.last_progress_at ?? t.lastProgressAt) });
    }
    items.sort((a, b) => Number(!!b.checkedBy) - Number(!!a.checkedBy) || a.handedInAt - b.handedInAt);
    const out = items.slice(0, limit);
    return { next: out[0] ?? null, items: out, checked: items.filter(i => i.checkedBy).length, total: items.length };
}

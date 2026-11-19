/**
 * Shows a team room: goal, supervisor, roster with current tasks, per-assignee queues, backlog and recent timeline.
 *
 * Read-only canvas page. Access is inherited from team.get (owner or roster member). Columns rank, group_key,
 * depends_on, paused and paused_note are used only when present on team.task.
 * @view
 * @live team
 * Without teamId shows an index of every team visible to the caller (owner's teams, or the agent's memberships).
 * Tasks with a timeline event in the last 60 seconds are highlighted. Refresh is push-only (procs.events.refresh
 * topic "team"); there is no timer fallback because none is documented without a script.
 * @param opts.teamId Persistent team identifier; omit for the index of all visible teams.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persistent team identifier; omit for the index of all visible teams. */
        teamId?: string;
    },
): Promise<string> {
    const esc = (v: unknown): string => ctx.fns.procs.ui.escape({ text: v === null || v === undefined ? '' : String(v) });
    if (!opts.teamId?.trim()) {
        const teams = (await ctx.fns.team.list({})).filter(t => t.status !== 'archived');
        if (!teams.length) return '<article class="team-room"><h2>Teams</h2><p><small>no active or draft teams</small></p></article>';
        const ids = teams.map(t => t.id);
        const stats = await ctx.fns.procs.db.select({ sql: "SELECT team_id, count(*) FILTER (WHERE status NOT IN ('done','cancelled'))::int AS open, count(*) FILTER (WHERE status='blocked')::int AS blocked, count(*) FILTER (WHERE status='review')::int AS review, count(*) FILTER (WHERE assignee_agent_id IS NULL AND status NOT IN ('done','cancelled'))::int AS backlog FROM team.task WHERE team_id = ANY(?::text[]) GROUP BY team_id", params: [ids] });
        const recent = await ctx.fns.procs.db.select({ sql: 'SELECT team_id, max(timestamp) AS last FROM team.event WHERE team_id = ANY(?::text[]) GROUP BY team_id', params: [ids] });
        const st = new Map(stats.map((r: Record<string, unknown>) => [String(r.team_id), r]));
        const last = new Map(recent.map((r: Record<string, unknown>) => [String(r.team_id), Number(r.last)]));
        const now = Date.now();
        const rows = teams.map(t => { const s = (st.get(t.id) ?? {}) as Record<string, unknown>; const l = last.get(t.id); const hot = l !== undefined && now - l < 60000;
            return `<tr><td><a href="${esc(ctx.fns.rpc.url({ fn: 'team.room', params: { teamId: t.id } }))}">${hot ? '<mark>' : ''}${esc(t.title)}${hot ? '</mark>' : ''}</a></td><td><code>${esc(t.status)}</code></td><td>${esc(t.supervisor_agent_id)}</td><td>${esc(s.open ?? 0)}</td><td>${esc(s.backlog ?? 0)}</td><td>${esc(s.blocked ?? 0)}</td><td>${esc(s.review ?? 0)}</td><td><small>${l ? esc(new Date(l).toISOString().replace('T', ' ').slice(0, 19)) : '—'}</small></td></tr>`; }).join('');
        return `<article class="team-room"><h2>Teams <small>${teams.length}</small></h2><table><thead><tr><th>Team</th><th>Status</th><th>Supervisor</th><th>Open</th><th>Backlog</th><th>Blocked</th><th>Review</th><th>Last event</th></tr></thead><tbody>${rows}</tbody></table></article>`;
    }
    const board = await ctx.fns.team.get({ teamId: opts.teamId });
    const team = board.team as Record<string, unknown>;
    const members = board.members as Record<string, unknown>[];
    const tasks = board.tasks as Record<string, unknown>[];
    const cols = new Set((await ctx.fns.procs.db.select({ sql: "SELECT column_name FROM information_schema.columns WHERE table_schema='team' AND table_name='task'", params: [] })).map((r: Record<string, unknown>) => String(r.column_name)));
    const has = (c: string) => cols.has(c);
    const nextSeq = Number(team.next_seq ?? 0);
    const events = await ctx.fns.team.timeline({ teamId: opts.teamId, afterSeq: Math.max(0, nextSeq - 30), limit: 30 });

    const now = Date.now();
    const recentRows = await ctx.fns.procs.db.select({ sql: 'SELECT DISTINCT task_id FROM team.event WHERE team_id=? AND task_id IS NOT NULL AND timestamp >= ?', params: [opts.teamId, now - 60000] });
    const recent = new Set(recentRows.map((r: Record<string, unknown>) => String(r.task_id)));
    const open = (t: Record<string, unknown>) => t.status !== 'done' && t.status !== 'cancelled';
    const rankOf = (t: Record<string, unknown>) => (has('rank') && t.rank !== null && t.rank !== undefined ? Number(t.rank) : Number.MAX_SAFE_INTEGER);
    const byRank = (a: Record<string, unknown>, b: Record<string, unknown>) => rankOf(a) - rankOf(b) || String(a.id).localeCompare(String(b.id));
    const isPaused = (t: Record<string, unknown>) => has('paused') && Boolean(t.paused);
    const statusOrder: Record<string, number> = { working: 0, blocked: 1, review: 2, assigned: 3, todo: 4 };
    const currentOf = (agentId: string) => tasks.filter(t => t.assignee_agent_id === agentId && open(t) && !isPaused(t))
        .sort((a, b) => (statusOrder[String(a.status)] ?? 9) - (statusOrder[String(b.status)] ?? 9) || byRank(a, b))[0];

    const badge = (s: unknown) => `<code>${esc(s)}</code>`;
    const taskLine = (t: Record<string, unknown>) => {
        const bits = [`${badge(t.status)} <b>${esc(t.title)}</b> <small>${esc(t.id)} · v${esc(t.version)}</small>`];
        if (has('rank') && t.rank !== null && t.rank !== undefined) bits.push(`<small>rank ${esc(t.rank)}</small>`);
        if (has('depends_on')) { const d = Array.isArray(t.depends_on) ? t.depends_on : (t.depends_on ? [t.depends_on] : []); if (d.length) bits.push(`<small>after ${d.map(esc).join(', ')}</small>`); }
        if (isPaused(t)) bits.push(`<mark>paused${has('paused_note') && t.paused_note ? ': ' + esc(t.paused_note) : ''}</mark>`);
        if (t.status === 'blocked' && t.blocked_reason) bits.push(`<small>blocked: ${esc(t.blocked_reason)}</small>`);
        return recent.has(String(t.id)) ? `<li><mark>●</mark> ${bits.join(' ')} <small>changed &lt;60s</small></li>` : `<li>${bits.join(' ')}</li>`;
    };

    const roster = members.map(m => {
        const cur = currentOf(String(m.agent_id));
        return `<tr><td>${esc(m.agent_id)}${m.agent_id === team.supervisor_agent_id ? ' <small>(supervisor)</small>' : ''}</td><td>${esc(m.role)}</td><td>${m.active ? 'active' : 'inactive'}</td><td>${cur && recent.has(String(cur.id)) ? '<mark>●</mark> ' : ''}${cur ? `${badge(cur.status)} ${esc(cur.title)}` : '<small>—</small>'}</td></tr>`;
    }).join('');

    const queues = members.map(m => {
        const q = tasks.filter(t => t.assignee_agent_id === m.agent_id && open(t)).sort(byRank);
        return `<section><h4>${esc(m.agent_id)} <small>${esc(m.role)} · ${q.length}</small></h4>${q.length ? `<ol>${q.map(taskLine).join('')}</ol>` : '<p><small>empty</small></p>'}</section>`;
    }).join('');

    const backlog = tasks.filter(t => !t.assignee_agent_id && open(t)).sort(byRank);
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const t of backlog) { const k = has('group_key') && t.group_key ? String(t.group_key) : ''; groups.set(k, [...(groups.get(k) ?? []), t]); }
    const backlogHtml = backlog.length ? [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
        .map(([k, ts]) => `<h4>${k ? esc(k) : '<small>ungrouped</small>'}</h4><ul>${ts.map(taskLine).join('')}</ul>`).join('') : '<p><small>no unassigned tasks</small></p>';

    const done = tasks.filter(t => !open(t)).length;
    const timeline = [...events].reverse().map(e => `<tr${now - Number(e.timestamp) < 60000 ? ' style="font-weight:bold"' : ''}><td><small>#${esc(e.seq)}</small></td><td><small>${esc(new Date(Number(e.timestamp)).toISOString().replace('T', ' ').slice(0, 19))}</small></td><td>${esc(e.actor_kind)}:${esc(e.actor_id)}</td><td>${badge(e.kind)}</td><td>${esc(e.task_id ?? '')}</td><td>${esc(String(e.text ?? '').slice(0, 300))}</td></tr>`).join('');

    return `<article class="team-room">
<p><small><a href="${esc(ctx.fns.rpc.url({ fn: 'team.room', params: {} }))}">← all teams</a></small></p>
<h2>${esc(team.title)} <small>${badge(team.status)} v${esc(team.version)}</small></h2>
<p><b>Goal:</b> ${esc(team.goal)}</p>
<p><b>Supervisor:</b> ${esc(team.supervisor_agent_id)} · <small>${tasks.length} tasks, ${done} closed</small></p>
<h3>Roster</h3>
<table><thead><tr><th>Agent</th><th>Role</th><th>State</th><th>Current task</th></tr></thead><tbody>${roster}</tbody></table>
<h3>Queues</h3>${queues || '<p><small>no members</small></p>'}
<h3>Backlog</h3>${backlogHtml}
<h3>Timeline <small>last ${events.length}</small></h3>
<table><thead><tr><th>Seq</th><th>Time</th><th>Actor</th><th>Kind</th><th>Task</th><th>Text</th></tr></thead><tbody>${timeline || '<tr><td colspan="6"><small>no events</small></td></tr>'}</tbody></table>
</article>`;
}

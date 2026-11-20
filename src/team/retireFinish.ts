/**
 * Finish a pending team.retire: archive the session once it saved its persona or the time ran out
 *
 * Runs from the cron task team-retire:<agentId> that team.retire registers; every argument except agentId is read from that task row, never from the caller. Archives (session.archive, ends team.persona_session) when the session wrote a persona revision after the retire started and is idle (args.quiet — team.close after reflecting: as soon as it is idle), or when the deadline passed; otherwise does nothing and waits for the next tick. On archive removes the cron task, marks the owner's rating that triggered the leave (args.inboxId, team.feedback_inbox) reflected when the session saved something (else queues it for the next session's brief), and writes one team.post note naming that rating (args.stars) with the short diff of what the session changed (or that it left without updating its memory). No pending retire: returns status 'none'.
 * @param opts.agentId Session whose retire is pending.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Session whose retire is pending. */
        agentId: string;
    },
): Promise<{ agentId: string; status: 'none' | 'waiting' | 'archived'; saved: boolean; timedOut: boolean; summary: string }> {
    type Row = Record<string, any>;
    const agentId = String(opts.agentId ?? '').trim();
    const task = 'team-retire:' + agentId;
    const t = (await ctx.fns.procs.db.select({ sql: 'SELECT args FROM cron_tasks WHERE name = ? AND enabled', params: [task] }) as Row[])[0];
    if (!agentId || !t) return { agentId, status: 'none', saved: false, timedOut: false, summary: '' };
    const a: Row = (typeof t.args === 'string' ? JSON.parse(t.args) : t.args) ?? {};
    const startedAt = Number(a.startedAt ?? 0), deadlineAt = Number(a.deadlineAt ?? 0), persona = String(a.persona ?? '');
    const revs = await ctx.fns.procs.db.select({ sql: "SELECT field, summary FROM team.persona_rev WHERE persona_name = ? AND author_kind = 'agent' AND author_id = ? AND at >= ? ORDER BY at", params: [persona, agentId, startedAt] }) as Row[];
    const ag = (await ctx.fns.procs.db.select({ sql: 'SELECT run_state, archived_at FROM agents WHERE id = ?', params: [agentId] }) as Row[])[0];
    const now = Date.now();
    const saved = revs.length > 0;
    const idle = !ag || ag.archived_at != null || String(ag.run_state ?? 'idle') === 'idle';
    const timedOut = now >= deadlineAt;
    if (!timedOut && !((saved || a.quiet) && idle)) return { agentId, status: 'waiting', saved, timedOut, summary: '' };

    // Claim the finish atomically: only the caller that removes the cron row archives and posts (cron tick and a manual call can race).
    const claimed = await ctx.fns.procs.db.select({ sql: 'DELETE FROM cron_tasks WHERE name = ? RETURNING name', params: [task] }) as Row[];
    if (!claimed.length) return { agentId, status: 'none', saved, timedOut, summary: '' };
    if (ag && ag.archived_at == null) { try { await ctx.fns.session.archive({ id: agentId }); } catch {} }
    await ctx.fns.procs.db.run({ sql: 'UPDATE team.persona_session SET ended_at = ? WHERE agent_id = ? AND ended_at IS NULL', params: [now, agentId] });
    // the rating that triggered the leave: reflected when the session saved something, else back to the queue for the next session's brief
    if (a.inboxId) { try { await ctx.fns.procs.db.run({ sql: saved ? "UPDATE team.feedback_inbox SET status = 'reflected', reflected_at = ? WHERE id = ?" : "UPDATE team.feedback_inbox SET status = 'queued', to_agent_id = NULL WHERE id = ? AND status = 'sent'", params: saved ? [now, String(a.inboxId)] : [String(a.inboxId)] }); } catch {} }
    const diff = revs.map(r => String(r.summary ?? '').trim() || String(r.field)).join('; ');
    const summary = (saved || a.quiet) ? `${persona}: сессия ${agentId} в архиве (${a.reason}${a.stars ? ', оценка ★' + a.stars : ''}); ${saved ? 'память обновлена — ' + diff : 'выводы записаны до закрытия задачи'}` : `${persona}: сессия ${agentId} в архиве (${a.reason}${a.stars ? ', оценка ★' + a.stars : ''}) без обновления памяти${timedOut ? ' — истекло время' : ''}`;
    const text = summary.replace(/\s+/g, ' ').slice(0, 280);
    try {
        const teamRow = (await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.persona_session WHERE agent_id = ?', params: [agentId] }) as Row[])[0];
        await ctx.fns.procs.db.run({ sql: "INSERT INTO team.post (id, author_kind, author_id, team_id, task_id, kind, text, created_at) VALUES (?, 'agent', ?, ?, NULL, 'note', ?, ?)", params: [Bun.randomUUIDv7(), agentId, teamRow?.team_id ?? null, text, now] });
    } catch {}
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { agentId, status: 'archived', saved, timedOut, summary: text };
}

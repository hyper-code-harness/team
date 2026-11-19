/**
 * Send a persona session into the archive after its last turn: update the persona memory first
 *
 * Use instead of session.archive for any session of a persona (team.fire, after the owner accepts the session's last task, when a new session replaces the old one). Finds the persona by agentId (team.persona_session or persona.current_agent_id). Not a persona, or already archived: archives at once (archived sessions are left alone). Persona: gives the session one last turn — «обнови персону: мемо памяти (team.memoSave, одна тема — одно мемо, ≤2500 символов) и промпт (team.personaSave field prompt)» — and registers a durable cron task team-retire:<agentId> that runs team.retireFinish every 15 s; retireFinish archives as soon as the session saved its persona and went idle, or at the timeout (default 180 s) without it. No polling inside this call: it returns right away with status 'waiting'. A repeated call while a retire is pending returns 'pending' and changes nothing.
 * @param opts.agentId Session to retire.
 * @param opts.reason Why the session leaves (fire, last task accepted, replaced by a new session); shown to the session and in the timeline.
 * @param opts.timeoutSec How long the session gets for its last turn before it is archived anyway. @default 180 @minimum 20 @maximum 900
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Session to retire. */
        agentId: string;
        /** Why the session leaves (fire, last task accepted, replaced by a new session); shown to the session and in the timeline. */
        reason: string;
        /** How long the session gets for its last turn before it is archived anyway. @default 180 @minimum 20 @maximum 900 */
        timeoutSec?: number;
    },
): Promise<{ agentId: string; persona: string | null; status: 'archived' | 'waiting' | 'pending' | 'already-archived'; archived: boolean; deadlineAt: number | null; task: string | null }> {
    type Row = Record<string, any>;
    const agentId = String(opts.agentId ?? '').trim();
    const reason = String(opts.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'сессия завершена';
    if (!agentId) throw new Error('team.retire: agentId required');
    if (!(await ctx.fns.jobs.canSee({ agentId }))) throw new Error('team.retire: not your agent');
    const rows = await ctx.fns.procs.db.select({ sql: 'SELECT id, archived_at FROM agents WHERE id = ?', params: [agentId] }) as Row[];
    if (!rows[0]) throw new Error('team.retire: agent not found');
    if (rows[0].archived_at != null) return { agentId, persona: null, status: 'already-archived', archived: false, deadlineAt: null, task: null };

    const p = await ctx.fns.team.personaGet({ agentId, revisions: 0 });
    if (!p) {
        const ok = (await ctx.fns.session.archive({ id: agentId })).ok;
        return { agentId, persona: null, status: 'archived', archived: ok, deadlineAt: null, task: null };
    }
    const task = 'team-retire:' + agentId;
    const pending = await ctx.fns.procs.db.select({ sql: 'SELECT args FROM cron_tasks WHERE name = ? AND enabled', params: [task] }) as Row[];
    if (pending[0]) {
        const a = typeof pending[0].args === 'string' ? JSON.parse(pending[0].args) : pending[0].args;
        return { agentId, persona: p.name, status: 'pending', archived: false, deadlineAt: Number(a?.deadlineAt ?? 0) || null, task };
    }

    const timeoutSec = Math.max(20, Math.min(900, Math.floor(Number(opts.timeoutSec ?? 180))));
    const startedAt = Date.now();
    const deadlineAt = startedAt + timeoutSec * 1000;
    const prompt = [
        `Твоя сессия уходит в архив (${reason}). Это последний ход: обнови свою персону «${p.name}», больше ничего не делай.`,
        `1) Память — мемо: team.memoSave({ path, title, description, content | ops, reason }) — что следующей сессии нужно знать о работе, команде, файлах, ловушках. Одна тема — одно мемо (code/<файлы>.md, howto/<приём>.md, user/<предпочтения>.md), ≤2500 символов каждое; обновляй существующие, сжимай и удаляй устаревшее (team.memoDelete), а не плоди копии. Оглавление: team.memoSearch({}).`,
        `2) Промпт — team.personaSave({ name: ${JSON.stringify(p.name)}, field: 'prompt', ops, reason }): как тебе лучше работать (привычки, порядок шагов, чего избегать). Раздел <!-- owner --> не трогай. Нечего менять — пропусти.`,
        `Время — ${Math.round(timeoutSec / 60) || 1} мин, потом архив.`,
    ].join('\n');

    if (session?.agent && session.agent.id !== agentId) await ctx.fns.agent.message({ agent: session.agent, to: agentId, text: prompt });
    else await ctx.fns.agent.wake({ id: agentId, inMs: 1000, prompt });
    await ctx.fns.cron.add({ name: task, fn: 'team.retireFinish', every: 15, args: { agentId, persona: p.name, reason, startedAt, deadlineAt, version: p.version } });
    return { agentId, persona: p.name, status: 'waiting', archived: false, deadlineAt, task };
}

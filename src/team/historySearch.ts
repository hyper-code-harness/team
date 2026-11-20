/**
 * Search a persona's past tasks: title, instructions, report, owner's stars and comments
 *
 * Looks through every task the persona's sessions ever had (team.persona_session → plan tasks on agents.scratchpad.plan with their report, team.task rows assigned to those sessions), the owner's ratings (team.rating: stars and comment) and «return to work» comments (team.reopen). Matching is by query words (≥3 letters, case-insensitive; words of 5+ letters also match by stem — the last letter cut, two from 7+ — so «шапку» finds «шапка»): a hit in the title weighs 3, anywhere else 1; tasks with score 0 are dropped. Empty query lists the latest tasks. Rows are compact: ids, title, persona, status, stars, when, which field matched and a fragment of ≤300 characters around the match. persona defaults to the caller session's persona; '*' searches all personas; a colleague's name works the same (read-only), every row names its persona. Read-only; the caller must be a team agent or the signed-in owner. Read a session further with team.sessionSearch / team.sessionRead.
 * @param opts.query Words to look for, e.g. «шапка попапа»; empty lists the latest tasks.
 * @param opts.persona Persona name; default: the persona of the calling session; '*' = all personas.
 * @param opts.status Only tasks with this status: done, active, pending, review, accepted, todo, working… (plan or team status).
 * @param opts.limit Maximum rows. @default 10 @minimum 1 @maximum 50
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Words to look for, e.g. «шапка попапа»; empty lists the latest tasks. */
        query?: string;
        /** Persona name; default: the persona of the calling session; '*' = all personas. */
        persona?: string;
        /** Only tasks with this status: done, active, pending, review, accepted, todo, working… (plan or team status). */
        status?: string;
        /** Maximum rows. @default 10 @minimum 1 @maximum 50 */
        limit?: number;
    },
): Promise<{ persona: string; total: number; rows: Array<{ agentId: string; taskId: string; title: string; persona: string; status: string; stars: number | null; at: number; field: string; fragment: string; score: number }> }> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    let persona = String(opts.persona ?? '').trim();
    if (!persona && actor.kind === 'agent') persona = String(((await ctx.fns.procs.db.select({ sql: 'SELECT name FROM team.persona WHERE current_agent_id=? UNION ALL SELECT persona_name FROM team.persona_session WHERE agent_id=? LIMIT 1', params: [actor.id, actor.id] })) as Row[])[0]?.name ?? '');
    if (!persona) persona = '*';
    const limit = Math.max(1, Math.min(50, Number(opts.limit ?? 10) || 10));
    const status = String(opts.status ?? '').trim().toLowerCase();
    const words = [...new Set(String(opts.query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3))].map(w => (w.length >= 7 ? w.slice(0, -2) : w.length >= 5 ? w.slice(0, -1) : w));

    const sess = await ctx.fns.procs.db.select({ sql: 'SELECT agent_id, persona_name FROM team.persona_session' + (persona === '*' ? '' : ' WHERE persona_name=?') + ' UNION SELECT current_agent_id, name FROM team.persona WHERE current_agent_id IS NOT NULL' + (persona === '*' ? '' : ' AND name=?'), params: persona === '*' ? [] : [persona, persona] }) as Row[];
    const who = new Map<string, string>(sess.map(r => [String(r.agent_id), String(r.persona_name)]));
    const ids = [...who.keys()];
    if (!ids.length) return { persona, total: 0, rows: [] };
    const [agents, rates, reopens, accepts, teamTasks] = await Promise.all([
        ctx.fns.procs.db.select({ sql: 'SELECT id, scratchpad, created_at FROM agents WHERE id = ANY(?::text[])', params: [ids] }) as Promise<Row[]>,
        ctx.fns.procs.db.select({ sql: 'SELECT agent_id, task_id, assignee_agent_id, stars, comment FROM team.rating WHERE agent_id = ANY(?::text[]) OR assignee_agent_id = ANY(?::text[])', params: [ids, ids] }).catch(() => []) as Promise<Row[]>,
        ctx.fns.procs.db.select({ sql: 'SELECT agent_id, task_id, comment FROM team.reopen WHERE agent_id = ANY(?::text[]) OR to_agent_id = ANY(?::text[]) ORDER BY at', params: [ids, ids] }).catch(() => []) as Promise<Row[]>,
        ctx.fns.procs.db.select({ sql: 'SELECT agent_id, task_id FROM team.accept WHERE agent_id = ANY(?::text[])', params: [ids] }).catch(() => []) as Promise<Row[]>,
        ctx.fns.procs.db.select({ sql: 'SELECT id, title, instructions, acceptance_criteria, status, assignee_agent_id, last_progress_at FROM team.task WHERE assignee_agent_id = ANY(?::text[])', params: [ids] }).catch(() => []) as Promise<Row[]>,
    ]);
    const arr = (v: any) => (Array.isArray(v) ? v : []);
    const txt = (v: any) => arr(v).map((x: any) => (typeof x === 'string' ? x : [x?.what, x?.why, x?.title, x?.question, x?.text].filter(Boolean).join(' — '))).join('\n');
    type Item = { agentId: string; taskId: string; title: string; persona: string; status: string; stars: number | null; at: number; fields: Array<[string, string]> };
    const items: Item[] = [];
    // instructions of delegated tasks carry the whole brief (persona block, rules, feed): search only the task text itself
    const own = (s: string) => s.split(/\n(?:Персона: |Team rules|Сейчас работают:|Последнее в ленте:|Feed cursor:)/)[0]!;
    const acc = new Set(accepts.map(r => r.agent_id + '|' + r.task_id));
    for (const a of agents) {
        let sp: Row = {}; try { sp = typeof a.scratchpad === 'string' ? JSON.parse(a.scratchpad || '{}') : (a.scratchpad ?? {}); } catch {}
        for (const t of arr(sp.plan?.tasks)) {
            const id = String(a.id), tid = String(t?.id ?? '');
            const rep = t.report ?? t.result ?? {};
            const rate = rates.find(r => String(r.task_id) === tid && String(r.agent_id) === id);
            const rc = reopens.filter(r => String(r.task_id) === tid && String(r.agent_id) === id).map(r => String(r.comment ?? '')).join('\n');
            items.push({
                agentId: id, taskId: tid, title: String(t.title ?? tid), persona: who.get(id) ?? '', status: acc.has(id + '|' + tid) ? 'accepted' : String(t.status ?? ''),
                stars: rate ? Number(rate.stars) : null, at: Number(t.completedAt ?? rep.at ?? t.startedAt ?? a.created_at ?? 0),
                fields: [['title', String(t.title ?? '')], ['instructions', own(String(t.instructions ?? ''))], ['summary', String(rep.summary ?? t.resultSummary ?? '')], ['decisions', txt(rep.decisions)], ['questions', txt(rep.questions)], ['notDone', txt(rep.notDone)], ['rating', String(rate?.comment ?? '')], ['reopen', rc]],
            });
        }
    }
    for (const t of teamTasks) {
        const id = String(t.assignee_agent_id), tid = String(t.id);
        const rate = rates.find(r => String(r.task_id) === tid && String(r.agent_id) === '');
        const rc = reopens.filter(r => String(r.task_id) === tid).map(r => String(r.comment ?? '')).join('\n');
        items.push({ agentId: id, taskId: tid, title: String(t.title), persona: who.get(id) ?? '', status: String(t.status), stars: rate ? Number(rate.stars) : null, at: Number(t.last_progress_at ?? 0), fields: [['title', String(t.title)], ['instructions', own(String(t.instructions ?? '')) + '\n' + String(t.acceptance_criteria ?? '')], ['rating', String(rate?.comment ?? '')], ['reopen', rc]] });
    }
    const pool = status ? items.filter(i => i.status.toLowerCase() === status) : items;
    const frag = (s: string, w: string) => {
        const flat = s.replace(/\s+/g, ' ').trim(), i = w ? flat.toLowerCase().indexOf(w) : 0;
        const from = Math.max(0, i - 100), out = flat.slice(from, from + 300);
        return (from > 0 ? '…' : '') + (out.length < flat.length - from ? out.slice(0, 299) + '…' : out);
    };
    const scored = pool.map(it => {
        let score = 0, field = '', w0 = '';
        for (const w of words) for (const [name, val] of it.fields) if (val.toLowerCase().includes(w)) { score += name === 'title' ? 3 : 1; if (!field || (field === 'title' && name !== 'title')) { field = name; w0 = w; } }
        if (!words.length) field = it.fields.find(([n, v]) => n === 'summary' && v)?.[0] ?? 'title';
        const val = it.fields.find(([n]) => n === field)?.[1] ?? '';
        return { agentId: it.agentId, taskId: it.taskId, title: it.title.slice(0, 120), persona: it.persona, status: it.status, stars: it.stars, at: it.at, field, fragment: frag(field === 'summary' && !w0 ? val.split('\n---')[0]! || val : val, w0), score };
    });
    const hits = (words.length ? scored.filter(x => x.score > 0) : scored).sort((a, b) => b.score - a.score || b.at - a.at);
    return { persona, total: hits.length, rows: hits.slice(0, limit) };
}

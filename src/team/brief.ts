/**
 * Short text with the team rules every agent must follow, plus who works on what right now
 *
 * The rules come from one place: the block between <!-- brief --> and <!-- /brief --> in the team plugin SKILL.md (estimate/progress, two-layer summary, result fields checked/notCovered/notDone/next/visuals, team.feed, team.post). Below them goes the current context from team.feed (read with all: true, so nobody's read cursor moves): «Сейчас работают», the last 5 entries and the feed cursor — the agent's first team.feed({ after: cursor }) then returns only what appeared after the brief, and later team.feed({}) calls go on from there. team.delegate appends this text to every task it hands out; an agent can also call it itself at the start of a task.
 *
 * Persona: when the agent is a session of a persona (team.persona_session / persona.current_agent_id), or opts.persona names one (team.delegate before the child exists), the brief starts with the persona block, capped at ~6000 characters: passport (name, role, responsibilities, model), persona prompt, the memory — table of contents of the persona's memos (team.memoSearch: path, title, description) and the full text of up to 3 memos most relevant to opts.query (the task title/text; ≤3500 characters together), the last 5 finished tasks of its sessions with the gist of the result and ★ rating, its plugins (2–3 lines from each SKILL.md and a plugins.read hint) and the rule that a hand-in (team.reportTask) needs at least one memo created or updated; then a line --- and the rules and feed as before.
 * @param opts.persona Persona name to brief as, when the session does not exist yet.
 * @param opts.agentId Agent the brief is for; its parent is taken as the team manager for the feed. Default: the caller.
 * @param opts.taskId Task id the agent is about to work on; named in the brief so estimate/progress/post use it.
 * @param opts.managerAgentId Manager whose team feed to show. Default: parent of agentId, else agentId, else the caller's team.
 * @param opts.query Task title and text; picks which persona memos go into the brief in full.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Agent the brief is for; its parent is taken as the team manager for the feed. Default: the caller. */
        agentId?: string;
        /** Persona name to brief as, when the session does not exist yet. */
        persona?: string;
        /** Task id the agent is about to work on; named in the brief so estimate/progress/post use it. */
        taskId?: string;
        /** Manager whose team feed to show. Default: parent of agentId, else agentId, else the caller's team. */
        managerAgentId?: string;
        /** Task title and text; picks which persona memos go into the brief in full. */
        query?: string;
    },
): Promise<string> {
    const skillPath = import.meta.dir + '/../../SKILL.md';
    let rules = '';
    try {
        const md = await Bun.file(skillPath).text();
        const m = md.match(/<!--\s*brief\s*-->([\s\S]*?)<!--\s*\/brief\s*-->/);
        rules = (m?.[1] ?? '').trim();
    } catch {}
    if (!rules) throw new Error('team.brief: no <!-- brief --> block in ' + skillPath);

    let managerId = opts.managerAgentId?.trim() || '';
    const agentId = opts.agentId?.trim() || '';
    if (!managerId && agentId) {
        const r = await ctx.fns.procs.db.select({ sql: 'SELECT parent_id FROM agents WHERE id = ?', params: [agentId] }) as Array<Record<string, unknown>>;
        managerId = String(r[0]?.parent_id ?? '') || agentId;
    }
    const lines: string[] = [];
    if (agentId || opts.persona?.trim()) { try { const pb = await personaBlock(ctx, agentId, opts.persona?.trim() || '', String(opts.query ?? '')); if (pb) lines.push(pb, '', '---', ''); } catch (e) { lines.push(`(persona unavailable: ${String((e as Error)?.message ?? e).slice(0, 120)})`, ''); } }
    lines.push(rules);
    if (opts.taskId?.trim()) lines.push('', `Your task id: ${opts.taskId.trim()} — use it in team.estimate / team.progress / team.post / team.reportTask.`);
    try {
        const feed = await ctx.fns.team.feed({ ...(managerId ? { managerAgentId: managerId } : {}), limit: 5, all: true });
        const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
        const ago = (ts: number) => { const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`; };
        if (feed.working.length) {
            lines.push('', 'Сейчас работают:');
            for (const w of feed.working.slice(0, 8)) lines.push(`- ${w.agentName}: ${cut(w.title, 60)} (${w.taskId}${w.percent != null ? ', ' + w.percent + '%' : ''}${w.stage ? ', ' + cut(w.stage, 40) : ''})`);
        }
        if (feed.entries.length) {
            lines.push('', 'Последнее в ленте:');
            for (const e of feed.entries.slice(0, 5)) lines.push(`- ${ago(e.ts)} ${e.actorName} [${e.kind}]: ${cut(e.text.replace(/\s+/g, ' '), 140)}`);
        }
        if (feed.cursor) lines.push('', `Feed cursor: ${feed.cursor} — first read: team.feed({ after: '${feed.cursor}' }) gives only what is new since this brief; after that plain team.feed({}) goes on from where you stopped.`);
    } catch (e) {
        lines.push('', `(team.feed unavailable: ${String((e as Error)?.message ?? e).slice(0, 120)})`);
    }
    return lines.join('\n');
}

/** Persona part of the brief, capped at ~6000 characters: passport, prompt, notes, last 5 tasks with result and stars, plugins. */
async function personaBlock(ctx: Context, agentId: string, name: string, query: string): Promise<string> {
    type Row = Record<string, any>;
    const p = (agentId ? await ctx.fns.team.personaGet({ agentId, revisions: 0 }) : null) ?? (name ? await ctx.fns.team.personaGet({ name, revisions: 0 }) : null);
    if (!p) return '';
    const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const out: string[] = [`Персона: ${p.name}${p.role ? ' — ' + p.role : ''} (версия ${p.version})`];
    if (p.responsibilities.trim()) out.push(`Отвечает за: ${cut(p.responsibilities.trim(), 400)}`);
    if (p.model) out.push(`Модель: ${p.model}`);
    out.push('', 'Промпт персоны (как ей лучше работать):', p.prompt.trim() ? cut(p.prompt.trim(), 2000) : '(пусто)');
    // memory: table of contents of all memos + full text of the few most relevant to the task
    const toc = await ctx.fns.team.memoSearch({ name: p.name, limit: 60 });
    out.push('', `Память персоны — мемо (${toc.total}); прочитать: team.memoRead({ path }), найти: team.memoSearch({ query }):`);
    if (!toc.memos.length) out.push('(пусто — заведи первое мемо)');
    for (const m of toc.memos.slice(0, 40)) out.push(`- ${m.path} — ${cut(m.title, 80)}${m.description ? ': ' + cut(m.description, 140) : ''}`);
    if (toc.memos.length > 40) out.push(`- … ещё ${toc.memos.length - 40}`);
    const hits = query.trim() ? (await ctx.fns.team.memoSearch({ name: p.name, query, limit: 3, withContent: true })).memos : [];
    const full = hits.length ? hits : (await ctx.fns.team.memoSearch({ name: p.name, limit: 1, withContent: true })).memos;
    let budget = 3500;
    for (const m of full) {
        if (budget <= 200) break;
        const text = cut(String(m.content ?? '').trim(), budget);
        budget -= text.length;
        out.push('', `Мемо ${m.path} (${m.title}):`, text);
    }

    // last 5 finished tasks of any session of the persona: plan tasks of the sessions + team tasks assigned to them
    const ids = [...new Set([...(p.currentAgentId ? [p.currentAgentId] : []), ...p.sessions.map(s => s.agentId)])];
    type T = { at: number; title: string; gist: string; stars: number | null };
    const done: T[] = [];
    if (ids.length) {
        const ag = await ctx.fns.procs.db.select({ sql: 'SELECT id, scratchpad FROM agents WHERE id = ANY(?::text[])', params: [ids] }) as Row[];
        const rates = await ctx.fns.procs.db.select({ sql: "SELECT agent_id, task_id, stars FROM team.rating WHERE agent_id = ANY(?::text[]) OR (agent_id = '' AND assignee_agent_id = ANY(?::text[]))", params: [ids, ids] }).catch(() => []) as Row[];
        const star = (a: string, t: string) => { const r = rates.find(x => String(x.task_id) === t && (String(x.agent_id) === a || String(x.agent_id) === '')); return r ? Number(r.stars) : null; };
        for (const r of ag) {
            let sp: Row = {}; try { sp = typeof r.scratchpad === 'string' ? JSON.parse(r.scratchpad || '{}') : (r.scratchpad ?? {}); } catch {}
            for (const t of sp.plan?.tasks ?? []) if (t?.status === 'done') {
                const res = t.report ?? t.result ?? {};
                done.push({ at: Number(res.at ?? t.doneAt ?? t.updatedAt ?? 0), title: String(t.title ?? t.id), gist: String(res.summary ?? t.summary ?? '').split('\n---')[0]!, stars: star(String(r.id), String(t.id)) });
            }
        }
        const tt = await ctx.fns.procs.db.select({ sql: "SELECT id, title, status, last_progress_at FROM team.task WHERE assignee_agent_id = ANY(?::text[]) AND status IN ('review','done') ORDER BY last_progress_at DESC NULLS LAST LIMIT 10", params: [ids] }).catch(() => []) as Row[];
        const linked = new Set((await ctx.fns.procs.db.select({ sql: 'SELECT task_id FROM team.task_link WHERE agent_id = ANY(?::text[])', params: [ids] }).catch(() => []) as Row[]).map(x => String(x.task_id)));
        for (const t of tt) if (!linked.has(String(t.id))) done.push({ at: Number(t.last_progress_at ?? 0), title: String(t.title), gist: t.status === 'review' ? 'на ревью' : 'принято', stars: star('', String(t.id)) });
    }
    done.sort((a, b) => b.at - a.at);
    if (done.length) {
        out.push('', 'Последние задачи персоны:');
        for (const t of done.slice(0, 5)) out.push(`- ${cut(t.title, 80)}${t.stars ? ' ' + '★'.repeat(t.stars) : ''}${t.gist ? ' — ' + cut(t.gist.replace(/\s+/g, ' '), 160) : ''}`);
    }

    if (p.plugins.length) {
        out.push('', 'Плагины персоны (подробно — plugins.read({ name })):');
        for (const name of p.plugins.slice(0, 8)) {
            let gist = '';
            try {
                const s = await ctx.fns.plugins.readSkill({ name, maxChars: 3000 });
                const fm = s.text.match(/^---[\s\S]*?\bdescription:\s*"?([^\n"]+)/);
                const body = s.text.replace(/^---[\s\S]*?\n---\n/, '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('```'));
                gist = [fm?.[1] ?? '', ...body.slice(0, 2)].filter(Boolean).join(' ');
            } catch { gist = '(SKILL.md не найден)'; }
            out.push(`- ${name}: ${cut(gist, 300)} → plugins.read({ name: '${name}' })`);
        }
    }
    out.push('', 'Сдача без памяти не принимается: team.reportTask требует, чтобы за задачу ты создал или обновил хотя бы одно мемо — передай memo: { path, title, description, content | ops } прям в reportTask или вызови team.memoSave({ path, title, description, content | ops, reason }) раньше. Одна тема — одно мемо (code/<файлы>.md, howto/<приём>.md, user/<предпочтения>.md), ≤2500 символов: переросло — ужми или раздели.');
    return cut(out.join('\n'), 8000);
}

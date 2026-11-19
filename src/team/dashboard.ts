/**
 * Shows one team dashboard on one screen as a dense list (review, in progress, queue, backlog, collapsed history) with a collapsible full-width timeline under it; a click on any task opens its card (team.taskPopup) in the app popup.
 *
 * Read-only canvas page. Team-plugin data comes from team.list/team.get (access inherited); delegated children of
 * managerAgentId are read from the agents table the same way agent.team does, including archived children. Kanban
 * cards are team.task rows plus every plan task of every delegated child. Anything updated in the last 60 seconds
 * glows. Refresh: topic "team" plus a 10s watchdog (ui.live every). Styles live in one scoped <style> block under the root class .tdash.
 * @view
 * @live team
 * @param opts.managerAgentId Agent whose delegated children (active and archived) are shown as members.
 * @param opts.variant Ignored; kept so old links with a view name still open the list.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Agent whose delegated children (active and archived) are shown as members. */
        managerAgentId?: string;
        /** Ignored; kept so old links with a view name still open the list. */
        variant?: string;
    },
): Promise<string> {
    type Row = Record<string, any>;
    const esc = (v: unknown): string => ctx.fns.procs.ui.escape({ text: v === null || v === undefined ? '' : String(v) });
    const now = Date.now();
    const num = (v: unknown) => (Number(v) > 0 ? Number(v) : 0);
    const fresh = (ts: unknown) => num(ts) > 0 && now - num(ts) <= 60000;
    const cut = (s: unknown, n = 140) => { const t = s === null || s === undefined ? '' : String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
    const ago = (ts: unknown) => {
        const t = num(ts); if (!t) return '';
        const s = Math.max(0, Math.round((now - t) / 1000));
        if (s < 45) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)}m ago`;
        if (s < 86400) return `${Math.round(s / 3600)}h ago`;
        return `${Math.round(s / 86400)}d ago`;
    };
    const clock = (ts: unknown) => (num(ts) ? new Date(num(ts)).toISOString().slice(11, 16) : '');
    const initials = (s: unknown) => { const w = String(s ?? '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/); return ((w[0]?.[0] ?? '?') + (w[1]?.[0] ?? '')).toUpperCase(); };
    const open = (s: unknown) => s !== 'done' && s !== 'cancelled';

    // ---- data: team-plugin teams
    const teams = (await ctx.fns.team.list({})).filter(t => t.status !== 'archived');
    const details: Array<{ team: Row; members: Row[]; tasks: Row[] }> = [];
    for (const t of teams) {
        try { const g = await ctx.fns.team.get({ teamId: t.id }); details.push({ team: g.team, members: g.members, tasks: g.tasks }); }
        catch { /* not accessible: skip */ }
    }
    const teamIds = details.map(d => String(d.team.id));
    const taskTs = new Map<string, number>();
    let events: Row[] = [];
    if (teamIds.length) {
        const ts = await ctx.fns.procs.db.select({ sql: 'SELECT task_id, max(timestamp) AS last FROM team.event WHERE team_id = ANY(?::text[]) AND task_id IS NOT NULL GROUP BY task_id', params: [teamIds] });
        for (const r of ts as Row[]) taskTs.set(String(r.task_id), Number(r.last));
        events = await ctx.fns.procs.db.select({ sql: 'SELECT team_id, seq, task_id, actor_kind, actor_id, kind, text, payload, timestamp FROM team.event WHERE team_id = ANY(?::text[]) ORDER BY timestamp DESC, seq DESC LIMIT 80', params: [teamIds] });
    }
    const allTasks: Row[] = details.flatMap(d => d.tasks.map((t): Row => ({ ...t, teamTitle: d.team.title })));
    // Chronicle entries (one source for the board and agents): team.feed.
    const feed = await ctx.fns.team.feed({ ...(opts.managerAgentId?.trim() ? { managerAgentId: opts.managerAgentId.trim() } : {}), limit: 40, all: true });

    // ---- data: delegated children of the manager (same storage as agent.team, active + archived)
    let manager: Row | null = null;
    const children: Row[] = [];
    const managerId = opts.managerAgentId?.trim();
    if (managerId) {
        const m = await ctx.fns.procs.db.select({ sql: 'SELECT id, title, run_state, updated_at, icon, meta FROM agents WHERE id = ?', params: [managerId] });
        manager = (m as Row[])[0] ?? null;
        const rows = await ctx.fns.procs.db.select({ sql: "SELECT id, title, run_state, scratchpad, created_at, updated_at, archived_at, icon, meta FROM agents WHERE parent_id = ? AND visibility = 'team' ORDER BY created_at ASC", params: [managerId] });
        for (const row of rows as Row[]) {
            let sp: Row = {};
            try { sp = typeof row.scratchpad === 'string' ? JSON.parse(row.scratchpad) : (row.scratchpad ?? {}); } catch { sp = {}; }
            // The live in-memory agent can be ahead of (or behind) the stored row: take the newer plan.
            const live: Row | undefined = (ctx.state as Row).agent?.[String(row.id)];
            const lsp: Row = live?.scratchpad ?? {};
            if (lsp.plan && num(lsp.plan.updatedAt) > num(sp.plan?.updatedAt)) sp = { ...sp, plan: lsp.plan };
            const ld = lsp.delegation ?? lsp.delegateTask, dd = sp.delegation ?? sp.delegateTask;
            if (ld && ld.status === 'ready' && dd?.status !== 'ready') sp = { ...sp, delegation: ld };
            const del = sp.delegation ?? sp.delegateTask ?? {};
            const planTasks: Row[] = Array.isArray(sp.plan?.tasks) ? sp.plan.tasks : [];
            const allDone = planTasks.length > 0 && planTasks.every(t => t.status === 'done');
            children.push({ id: String(row.id), title: String(row.title ?? ''), runState: String(row.run_state ?? 'idle'), status: String(del.status ?? (allDone ? 'ready' : 'working')), planTasks, planTitle: String(sp.plan?.title ?? del.title ?? ''), createdAt: num(row.created_at), summary: del.summary ?? del.result?.summary ?? null, finishedAt: num(del.result?.finishedAt), updatedAt: Number(row.updated_at ?? 0), archivedAt: row.archived_at == null ? null : Number(row.archived_at), allDone });
        }
    }

    // ---- kanban cards
    type Col = 'backlog' | 'assigned' | 'working' | 'paused' | 'review' | 'done' | 'cancelled';
    type Card = { col: Col; title: string; owner: string; ownerLabel: string; group: string; ts: number; note: string; id: string; status: string; pkey?: string; /** Manager agent that accepted the task (team.accept by 'manager:<id>'); absent = a person or not accepted. */ acceptedBy?: string };
    type Prog = { percent: number | null; percentSource?: string | null; stage: string | null; etaMin: number | null; overdue: boolean; estimateMin?: number | null; elapsedMin?: number | null };
    const teamCol: Record<string, Col> = { todo: 'backlog', assigned: 'assigned', working: 'working', paused: 'paused', blocked: 'paused', review: 'review', done: 'done', cancelled: 'cancelled' };
    const planCol: Record<string, Col> = { pending: 'assigned', todo: 'assigned', active: 'working', working: 'working', in_progress: 'working', paused: 'paused', blocked: 'paused', review: 'review', done: 'done', cancelled: 'cancelled' };
    const cards: Card[] = [];
    for (const t of allTasks) {
        const col = teamCol[String(t.status)] ?? 'backlog';
        const ts = taskTs.get(String(t.id)) ?? 0;
        cards.push({ col, id: String(t.id), status: String(t.status), title: String(t.title ?? t.id), owner: String(t.assignee_agent_id ?? ''), ownerLabel: String(t.assignee_agent_id ?? 'unassigned'), group: String(t.group_key ?? t.teamTitle ?? ''), ts, pkey: 't:' + String(t.id), note: col === 'done' ? cut(t.summary ?? t.result ?? '') : (t.blocked_reason ? cut(t.blocked_reason) : (t.paused_note ? cut(t.paused_note) : '')) });
    }
    const shortTitle = (s: string) => s.replace(/^team:\s*/i, '');
    // Finished child plan tasks wait in Review until the owner accepts them (team.accept); older completions are history.
    const acc = await ctx.fns.team.accepted({ agentIds: [...children.map(c => c.id), ''] });
    const accKeys = new Set(acc.keys);
    // Two-pass review: a manager's accept (first pass) leaves the task in Review with the manager's face; the person decides.
    // a mark older than the latest hand-in (task returned and handed in again) does not count
    const mgrOf = (key: string, after = 0) => /^manager:/.test(acc.by?.[key] ?? '') && num(acc.at[key]) >= after ? String(acc.by[key]).slice(8) : '';
    for (const c of cards) if (c.pkey === 't:' + c.id && c.col === 'review' && mgrOf(':' + c.id)) c.acceptedBy = mgrOf(':' + c.id);
    // Plan task ↔ team task (team.task_link): with an active team the Backlog/Queue show the team task, a session's plan
    // task linked to it is not repeated there; once started, the plan card (progress, review, accept) stands for both.
    const teamTaskIds = new Set(allTasks.map(t => String(t.id)));
    const link = new Map<string, string>();
    if (children.length && teamIds.length) {
        try { for (const l of await ctx.fns.procs.db.select({ sql: 'SELECT agent_id, plan_task_id, task_id FROM team.task_link WHERE agent_id = ANY(?::text[]) AND team_id = ANY(?::text[])', params: [children.map(c => c.id), teamIds] }) as Row[]) if (teamTaskIds.has(String(l.task_id))) link.set(String(l.agent_id) + ':' + String(l.plan_task_id), String(l.task_id)); }
        catch (e) { if (!/task_link|does not exist/.test(String(e))) throw e; }
    }
    const hideTeam = new Set<string>();
    for (const c of children) {
        for (const t of c.planTasks) {
            let col = planCol[String(t.status)] ?? 'backlog';
            if (col === 'done' && num(t.completedAt) >= acc.since && !accKeys.has(c.id + ':' + String(t.id ?? ''))) col = 'review';
            const linked = link.get(c.id + ':' + String(t.id ?? ''));
            if (linked && (col === 'backlog' || col === 'assigned')) continue;
            if (linked) hideTeam.add(linked);
            const ts = num(t.completedAt) || num(t.activeSince) || num(t.startedAt) || c.updatedAt;
            cards.push({ col, id: String(t.id ?? ''), status: String(t.status ?? 'pending'), title: String(t.title ?? t.id), owner: c.id, ownerLabel: c.id, group: shortTitle(c.title), ts, pkey: c.id + ':' + String(t.id ?? ''), note: col === 'done' ? cut(t.resultSummary ?? t.result?.summary ?? '') : '', ...(mgrOf(c.id + ':' + String(t.id ?? ''), num(t.completedAt)) ? { acceptedBy: mgrOf(c.id + ':' + String(t.id ?? ''), num(t.completedAt)) } : {}) });
        }
    }
    if (hideTeam.size) for (let i = cards.length - 1; i >= 0; i--) { const c = cards[i]!; if (c.pkey === 't:' + c.id && hideTeam.has(c.id)) cards.splice(i, 1); }
    const columns: Array<{ key: Col; label: string }> = [
        { key: 'backlog', label: 'Backlog' }, { key: 'assigned', label: 'Assigned' }, { key: 'working', label: 'In progress' },
        { key: 'paused', label: 'Paused / Blocked' }, { key: 'review', label: 'Review' }, { key: 'done', label: 'Done' },
    ];
    const count = (k: Col) => cards.filter(c => c.col === k).length;

    // ---- members list (manager + children + team-plugin rosters)
    type Member = { id: string; title: string; role: 'manager' | 'worker'; state: string; done: number; total: number; current: string; ts: number };
    const members: Member[] = [];
    if (manager) {
        const total = cards.length, done = count('done');
        members.push({ id: String(manager.id), title: String(manager.title ?? ''), role: 'manager', state: String(manager.run_state ?? 'idle'), done, total, current: `${children.length} delegated agents`, ts: num(manager.updated_at) });
    }
    for (const c of children) {
        const done = c.planTasks.filter((t: Row) => t.status === 'done').length;
        const cur = c.planTasks.find((t: Row) => t.status === 'active') ?? c.planTasks.find((t: Row) => open(t.status));
        members.push({ id: c.id, title: shortTitle(c.title), role: 'worker', state: c.archivedAt ? 'archived' : c.runState, done, total: c.planTasks.length, current: cur ? String(cur.title ?? cur.id) : (c.allDone ? 'all tasks done' : ''), ts: c.updatedAt });
    }
    for (const d of details) for (const m of d.members) {
        const mine = d.tasks.filter(t => t.assignee_agent_id === m.agent_id && t.status !== 'cancelled');
        const cur = mine.find(t => t.status === 'working') ?? mine.find(t => open(t.status) && t.status !== 'paused');
        members.push({ id: String(m.agent_id), title: `${d.team.title} · ${m.role ?? ''}`, role: m.agent_id === d.team.supervisor_agent_id ? 'manager' : 'worker', state: m.active ? 'active' : 'inactive', done: mine.filter(t => t.status === 'done').length, total: mine.length, current: cur ? String(cur.title) : '', ts: cur ? taskTs.get(String(cur.id)) ?? 0 : 0 });
    }
    // ---- faces: agents.icon + meta.persona for everyone shown
    const ids = new Set<string>([...(manager ? [String(manager.id)] : []), ...children.map(c => c.id)]);
    for (const d of details) for (const m of d.members) ids.add(String(m.agent_id));
    for (const t of allTasks) if (t.assignee_agent_id) ids.add(String(t.assignee_agent_id));
    for (const e of events) if (e.actor_kind === 'agent' && e.actor_id) ids.add(String(e.actor_id));
    for (const e of feed.entries) { if (e.actor && !e.byUser) ids.add(e.actor); if (e.to) ids.add(e.to); }
    for (const c of cards) if (c.acceptedBy) ids.add(c.acceptedBy);
    // Personas (team.persona): a session id → its persona (current_agent_id or any past session); the face opens team.persona.
    const personaOf = new Map<string, { name: string; role: string; icon: string | null }>();
    const personaByName = new Map<string, { name: string; role: string; icon: string | null }>();
    try {
        const pr = await ctx.fns.procs.db.select({ sql: `SELECT p.name, p.role, p.icon, p.current_agent_id, s.agent_id FROM team.persona p LEFT JOIN team.persona_session s ON s.persona_name = p.name`, params: [] }) as Row[];
        for (const r of pr) {
            const v = { name: String(r.name), role: String(r.role ?? ''), icon: r.icon ?? null };
            personaByName.set(v.name, v);
            if (r.current_agent_id) personaOf.set(String(r.current_agent_id), v);
            if (r.agent_id) personaOf.set(String(r.agent_id), v);
        }
    } catch (e) { if (!/persona|does not exist/.test(String(e))) throw e; }
    const faceRows = ids.size ? await ctx.fns.procs.db.select({ sql: 'SELECT id, icon, meta, run_state, archived_at FROM agents WHERE id = ANY(?::text[])', params: [[...ids]] }) as Row[] : [];
    const who = new Map<string, { icon: string | null; name: string; role: string; run: string; arch: boolean }>();
    for (const r of faceRows) {
        let meta: Row = {}; try { meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta ?? {}); } catch { meta = {}; }
        const pp = personaOf.get(String(r.id));
        who.set(String(r.id), { icon: r.icon ?? pp?.icon ?? null, name: pp?.name ?? String(meta?.persona?.name ?? r.id), role: pp?.role || String(meta?.persona?.role ?? ''), run: String(r.run_state ?? 'idle'), arch: r.archived_at != null });
    }
    const nameOf = (id: string) => who.get(id)?.name ?? (id || '—');
    // A face of a known persona is a popup trigger (team.persona) — a span, so it can sit inside row buttons and links;
    // the click handler takes the closest [hx-popup], so the face wins over the row. Unknown persona: a plain face.
    const personaAttrs = (name: string, tip: string) => personaByName.has(name)
        ? ` role="button" tabindex="0" hx-popup="team.persona" hx-popup-params="${esc(JSON.stringify({ name }))}" title="${esc(name)}" aria-label="${esc('Персона ' + name + (tip && tip !== name ? ' — ' + tip : ''))}" data-tip="${esc(tip)}"`
        : ` title="${esc(tip)}"`;
    const personTipOf = (id: string) => { const w = who.get(id); return w ? `${w.name}${w.role ? ' · ' + w.role : ''}` : id; };
    const face = (id: string, tip?: string) => `<span class="fc${personaByName.has(nameOf(id)) ? ' pf' : ''}"${personaAttrs(nameOf(id), tip ?? nameOf(id))}>${ctx.fns.w.chatIcon({ icon: who.get(id)?.icon ?? null, size: 'sm' })}</span>`;
    const short = (ts: unknown) => {
        const t = num(ts); if (!t) return '';
        const s = Math.max(0, Math.round((now - t) / 1000));
        return s < 60 ? `${s}с` : s < 3600 ? `${Math.round(s / 60)}м` : s < 86400 ? `${Math.round(s / 3600)}ч` : `${Math.round(s / 86400)}д`;
    };

    // ---- intermediate steps: last assistant replies per agent (bounded)
    const agentIds = [...(manager ? [String(manager.id)] : []), ...children.map(c => c.id)];
    const steps = agentIds.length ? await ctx.fns.procs.db.select({
        sql: `SELECT e.agent_id, e.ts, left(e.payload::jsonb->>'text', 400) AS text FROM unnest(?::text[]) AS a(id)
              CROSS JOIN LATERAL (SELECT agent_id, ts, payload FROM events WHERE agent_id = a.id AND type = 'assistant' ORDER BY idx DESC LIMIT 8) e`,
        params: [agentIds] }) as Row[] : [];

    // ---- corner strip: counters + team, one line
    const rankOf = new Map(allTasks.map(t => [String(t.id), num(t.rank)]));
    const queue = cards.filter(c => c.col === 'backlog' || c.col === 'assigned')
        .sort((a, b) => (rankOf.get(a.id) ?? 1e15) - (rankOf.get(b.id) ?? 1e15) || a.ts - b.ts);
    const working = cards.filter(c => c.col === 'working').sort((a, b) => b.ts - a.ts);
    const done = cards.filter(c => c.col === 'done' || c.col === 'paused' || c.col === 'review' || c.col === 'cancelled').sort((a, b) => b.ts - a.ts);
    // One face per person: group sessions by persona name, show the freshest (a running session wins).
    const byPerson = new Map<string, Member>();
    for (const m of members) {
        const k = nameOf(m.id), prev = byPerson.get(k);
        const score = (x: Member) => (who.get(x.id)?.run === 'running' ? 1e15 : 0) + (x.state === 'archived' ? 0 : 1e14) + num(x.ts);
        if (!prev || score(m) > score(prev)) byPerson.set(k, m);
    }
    const crew = [...byPerson.values()].map(m => {
        const w = who.get(m.id);
        return `<a class="mb${m.state === 'archived' ? ' dim' : ''}" href="/agent/${esc(m.id)}" title="${esc(`${nameOf(m.id)} · ${w?.role || m.role} · ${m.state}${who.get(m.id)?.run === 'running' ? ' · работает' : ''}${m.current ? ' — ' + m.current : ''}`)}" aria-label="${esc(nameOf(m.id))}">${face(m.id)}${who.get(m.id)?.run === 'running' ? '<i class="mdot"></i>' : ''}</a>`;
    }).join('');
    const counters = `в бэклоге ${queue.length}, в работе ${working.length}, готово ${done.length}`;

    // ---- cards with <details>
    const stepsFor = (c: Card) => {
        if (!c.owner) return [] as Row[];
        const t0 = c.col === 'done' ? 0 : c.ts;
        return steps.filter(s => String(s.agent_id) === c.owner && (!t0 || num(s.ts) >= t0)).sort((a, b) => num(b.ts) - num(a.ts)).slice(0, 3);
    };
    const planTask = (c: Card): Row | undefined => children.find(ch => ch.id === c.owner)?.planTasks.find((t: Row) => String(t.id) === c.id);
    const teamTask = (c: Card): Row | undefined => allTasks.find(t => String(t.id) === c.id);
    const resultOf = (c: Card) => {
        const pt = planTask(c), tt = teamTask(c);
        return String(pt ? (pt.resultSummary ?? pt.result?.summary ?? (typeof pt.result === 'string' ? pt.result : '')) : (tt?.summary ?? tt?.result ?? tt?.blocked_reason ?? tt?.paused_note ?? '') || '');
    };
    // «принял Миша»: the manager's face + name on a done card it accepted; a person's accept shows nothing extra.
    const accBadge = (c: Card) => !c.acceptedBy ? '' : c.col === 'review'
        ? ` <span class="mck" role="img" title="${esc('Проверил ' + nameOf(c.acceptedBy) + ' — ждёт вашей оценки')}" aria-label="${esc('Проверил ' + nameOf(c.acceptedBy) + ' — ждёт вашей оценки')}">${ctx.fns.w.chatIcon({ icon: who.get(c.acceptedBy)?.icon ?? null, size: 'sm' })}<i aria-hidden="true">✓</i></span>`
        : ` <em class="am" title="${esc('Принял менеджер ' + nameOf(c.acceptedBy) + ' — вы можете вернуть в работу')}">${face(c.acceptedBy)}принял ${esc(nameOf(c.acceptedBy))}</em>`;
    const stWord = (c: Card) => c.col === 'review' ? 'на ревью' : c.col === 'cancelled' ? 'отменено' : c.status === 'blocked' ? 'блок' : c.col === 'paused' ? 'пауза' : '';
    // ---- one click opens the task card (team.taskView) in the app popup — team.taskPopup owns the dialog
    const pop = (c: Card) => {
        const p: Row = planTask(c) ? { taskId: c.id, agentId: c.owner, title: c.title } : { taskId: c.id, title: c.title };
        return `type="button" hx-popup="team.taskPopup" hx-popup-params="${esc(JSON.stringify(p))}" title="Открыть карточку задачи"`;
    };
    const gist = (c: Card, n = 110) => { const r = resultOf(c); return r ? esc(cut(r, n)) : ''; };
    const byline = (c: Card) => [c.owner ? `<b>${esc(nameOf(c.owner))}</b>` : 'без исполнителя', c.ts ? esc(short(c.ts) + ' назад') : '', stWord(c) ? `<em>${esc(stWord(c))}</em>` : ''].filter(Boolean).join(' · ');
    const fr = (c: Card) => (fresh(c.ts) ? ' fresh' : '');
    const empty = '<p class="mu">Пусто.</p>';

    // linear: dense rows grouped by status, mono ids
    // linear: dense rows — face (opens the persona) · title · grey gist/stage · fixed progress column · time; the id is in the row title.
    // Status is a thin tone on the face (working = live ring, done = muted) plus a small word for review / pause / block.
    const row = (c: Card) => { const m = progModel(c); const st = stWord(c); const sub = c.col === 'working' && m?.stage ? esc(cut(m.stage, 80)) : gist(c, 80);
        // status ring around the face (no percent): live while working, red when overdue; size S/M/L as a small badge
        const ring = c.col === 'working' || m?.od ? `rk${m?.od ? ' od' : ''}` : '';
        const ringTip = m?.od ? 'просрочено' : '';
        const fc = c.owner ? face(c.owner, personTipOf(c.owner)) : '<span class="fc nf" title="без исполнителя">—</span>';
        const title = c.title.replace(/^[\p{L}-]{2,20}:\s*/u, '') || c.title;
        return `<button class="it rw${fr(c)} s-${c.col}" ${pop(c).replace('title="Открыть карточку задачи"', `title="${esc(`${c.id} — ${c.title}${c.owner ? ' · ' + nameOf(c.owner) : ''}${ringTip ? ' · ' + ringTip : ''}`)}"`)}><span class="ro">${ring ? `<span class="${ring}">${fc}</span>` : fc}</span><span class="rt"><span class="rtx">${esc(title)}${st ? ` <em class="sw">${esc(st)}</em>` : ''}</span>${accBadge(c)}</span><span class="rg">${sub}</span><span class="rp">${sizeBadge(c)}</span><time>${esc(short(c.ts))}</time></button>`; };
    // Progress of the whole board in one read (team.taskProgressBatch); rows without data draw nothing.
    const prog = new Map<string, Prog>();
    try {
        const pr = await ctx.fns.team.taskProgressBatch({ teamIds, agentIds: children.map(c => String(c.id)) });
        for (const p of pr) prog.set(p.scope === 'team' ? 't:' + p.taskId : String(p.agentId) + ':' + p.taskId, p);
    } catch { /* progress is optional decoration */ }
    // Progress model for rows and "Сейчас работают": only stage and overdue flag — no percent, no minutes on the board.
    const progModel = (c: Card) => {
        const p = c.pkey ? prog.get(c.pkey) : undefined; if (!p) return null;
        const est = p.estimateMin ?? null; const el = p.elapsedMin ?? null;
        const od = (est != null && el != null && el > est) || p.overdue;
        if (!p.stage && !od) return null;
        return { od, stage: p.stage ?? '' };
    };
    // Task size S/M/L. SIZE_FIELD — the progress field Ян adds (pending); until it exists the badge stays hidden.
    const SIZE_FIELD = 'size';
    const sizeBadge = (c: Card) => {
        const p = c.pkey ? prog.get(c.pkey) as Record<string, unknown> | undefined : undefined;
        const v = String(p?.[SIZE_FIELD] ?? '').trim().toUpperCase();
        return /^(S|M|L)$/.test(v) ? `<span class="sz sz-${v}" title="${esc('Размер задачи: ' + v)}">${v}</span>` : '';
    };
    const activeRow = row;
    const group = (label: string, list: Card[], r: (c: Card) => string = row) => `<section class="gp"><h3>${esc(label)} <span class="nn">${list.length}</span></h3>${list.map(r).join('')}</section>`;

    // ---- timeline: who (face), what, with which task, what result — entries come from team.feed (noise dropped, runs merged)
    type Act = { ts: number; actor: string; user?: boolean; kind: string; subj?: string; text: string; to?: string; pop?: Row; persona?: string };
    const acts: Act[] = feed.entries.map(e => ({
        // board shows no minutes or percent: drop the estimate text and the leading "N% · " of a stage
        ts: e.ts, actor: e.actor, user: e.byUser, kind: e.kind, to: e.to, persona: e.persona,
        text: e.kind === 'estimate' ? '' : e.kind === 'progress' ? String(e.text ?? '').replace(/^\s*\d{1,3}\s*%\s*(·\s*)?/, '') : e.text,
        subj: e.kind.startsWith('post:') ? undefined : e.subject,
        pop: e.taskId && e.scope === 'plan' && e.agentId ? { taskId: e.taskId, agentId: e.agentId, title: e.subject ?? e.taskId }
            : e.taskId && e.scope === 'team' ? { taskId: e.taskId, title: e.subject ?? e.taskId } : undefined,
    }));
    const verbOf = (a: Act) => {
        const v: Record<string, string> = { assigned: 'поручает', started: 'берёт', done: 'сдаёт', tookDone: 'берёт и сдаёт', finished: 'завершает', message: 'пишет', ask: 'спрашивает', accepted: 'принято', feedback: 'не согласен', reopen: 'вернул в работу', blocked: 'застрял(а)', progress: 'этап', estimate: 'оценка', note: 'отмечает', 'heads-up': 'внимание', 'post:note': 'заметка', 'post:heads-up': 'внимание', 'post:question': 'спрашивает', 'post:done': 'готово', persona: 'правит персону', hire: 'нанимает', fire: 'отпускает' };
        return v[a.kind] ?? a.kind;
    };
    const actIcon: Record<string, [string, types.w.Tone?]> = { assigned: ['arrow-right'], started: ['play'], done: ['paper-plane-tilt'], tookDone: ['paper-plane-tilt'], finished: ['flag', 'success'], message: ['chat-circle'], ask: ['chat-circle-dots'], accepted: ['check-circle', 'success'], feedback: ['arrow-u-up-left', 'warning'], reopen: ['arrow-u-up-left', 'warning'], blocked: ['prohibit', 'danger'], progress: ['steps'], estimate: ['timer'], note: ['note'], 'heads-up': ['warning', 'warning'], 'post:note': ['note-pencil'], 'post:heads-up': ['megaphone', 'warning'], 'post:question': ['question', 'info'], 'post:done': ['check', 'success'], persona: ['identification-card', 'info'], hire: ['user-plus', 'success'], fire: ['user-minus', 'warning'] };
    const personTip = (id: string) => { const w = who.get(id); return w ? `${w.name}${w.role ? ' · ' + w.role : ''}` : id; };
    const actFace = (id: string, user?: boolean) => user && !who.has(id)
        ? `<span class="fc" title="Владелец">${ctx.fns.w.icon({ name: 'user-circle', size: 20, label: 'Владелец' })}</span>`
        : face(id, personTip(id));
    const actLi = (a: Act) => {
        const ic = actIcon[a.kind] ?? ['dot'];
        const faces = a.to ? `${actFace(a.actor, a.user)}<span class="ar">→</span>${actFace(a.to)}` : actFace(a.actor, a.user);
        const full = String(a.text ?? '').replace(/\s+/g, ' ').trim(), long = full.length > 120;
        const subj = a.subj ? ` «${esc(cut(a.subj, 60))}»` : '';
        const body = `<span class="vb">${ctx.fns.w.icon({ name: ic[0], size: 12, tone: ic[1] })}${esc(verbOf(a))}</span>${subj}${full ? `${subj ? ':' : ''} ${esc(cut(full, 120))}` : ''}${long && a.pop ? ' <em class="mo">ещё</em>' : ''}`;
        const tip = esc(`${personTip(a.actor)}${a.to ? ' → ' + personTip(a.to) : ''}${long ? ' — ' + full.slice(0, 600) : ''}`);
        const ppop = !a.pop && a.persona && personaByName.has(a.persona) ? a.persona : '';
        const main = ppop
            ? `<button class="it ab" type="button" hx-popup="team.persona" hx-popup-params="${esc(JSON.stringify({ name: ppop }))}" title="${esc(ppop)}"><p>${body}</p></button>`
            : a.pop
            ? `<button class="it ab" type="button" hx-popup="team.taskPopup" hx-popup-params="${esc(JSON.stringify(a.pop))}" title="${tip}"><p>${body}</p></button>`
            : `<p title="${tip}">${body}</p>`;
        return `<li class="ac k-${esc(a.kind.replace(/[^a-zA-Z-]/g, '-'))}${fresh(a.ts) ? ' fresh' : ''}"><span class="fs">${faces}</span>${main}<time>${esc(clock(a.ts))}</time></li>`;
    };
    // "Сейчас работают": face, task, % and stage (taskProgressBatch via prog), at most 3
    const nowRows = working.slice(0, 3).map(c => {
        const m = progModel(c);
        const st = m?.stage ? cut(m.stage, 50) : '';
        const pg = m?.od || sizeBadge(c) ? `<span class="np">${sizeBadge(c)}${m?.od ? '<span class="pe od">просрочено</span>' : ''}</span>` : '';
        return `<li class="nw"><span class="fs">${c.owner ? actFace(c.owner) : ''}</span><button class="it ab" ${pop(c)}><p><b>${esc(cut(c.title, 70))}</b>${st ? ` <span class="mu">${esc(st)}</span>` : ''}</p>${pg}</button><i class="on">•</i></li>`;
    }).join('');
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    const bucket = (ts: number) => now - ts < 10 * 60000 ? 'Сейчас' : now - ts < 3600000 ? 'Последний час' : ts >= startToday.getTime() ? 'Раньше сегодня' : 'Раньше';
    let lastBucket = '';
    // "Сейчас работают" is not repeated in the chronicle: the «В работе» section already shows who is working.
    void nowRows;
    const actHtml = acts.map(a => {
        const b = bucket(a.ts); const head = b !== lastBucket ? `<li class="gh">${esc(b)}</li>` : ''; lastBucket = b;
        return head + actLi(a);
    }).join('');

    const lastTs = Math.max(0, ...cards.map(c => c.ts), ...members.map(m => m.ts), ...acts.map(a => a.ts));
    const anyRunning = [...who.values()].some(w => w.run === 'running' && !w.arch);
    const title = manager ? String(manager.title ?? manager.id) : details[0]?.team.title ?? 'Team';
    const css = `
.tdash{display:flex;flex-direction:column;height:100vh;min-height:0;overflow:hidden;box-sizing:border-box;padding:var(--w-s6) var(--w-s6) 0;
  background:var(--w-surface-document);color:var(--w-ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:var(--w-text-ui);line-height:var(--w-line-ui)}
.tdash *{box-sizing:border-box}
.tdash a{color:inherit;text-decoration:none}
.tdash .hd{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:var(--w-s2) var(--w-s5, 20px);padding-bottom:var(--w-s3);border-bottom:var(--w-rule)}
.tdash .mast{flex:1 1 12rem;min-width:0;display:flex;align-items:center;gap:var(--w-s3)}
.tdash h1{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--w-text-read);font-weight:600;line-height:var(--w-line-ui)}
.tdash .hst{flex:none;display:inline-flex;align-items:center;gap:var(--w-s1);white-space:nowrap;font-size:var(--w-text-small);color:var(--w-ink-faint);cursor:default}
.tdash .hst.on{color:var(--w-live)}
.tdash .hdot{width:7px;height:7px;border-radius:999px;background:currentColor;opacity:.8}
.tdash .on{color:var(--w-live)}
.tdash .crew{flex:none;display:flex;align-items:center;gap:var(--w-s1);color:var(--w-ink-muted)}
.tdash .mb{position:relative;display:inline-flex;align-items:center}
.tdash .mb .mdot{position:absolute;right:-1px;bottom:-1px;width:8px;height:8px;border-radius:999px;background:var(--w-live);box-shadow:0 0 0 1.5px var(--w-surface-document, #fff);pointer-events:none}
.tdash .mb:hover{color:var(--w-ink)}
.tdash .mb.dim{color:var(--w-ink-faint)}
.tdash .mb.dim .fc{filter:grayscale(1);opacity:var(--w-disabled-opacity)}
.tdash .fc{display:inline-flex}
.tdash .fc.pf{cursor:pointer;border-radius:999px}.tdash .fc.pf:hover,.tdash .fc.pf:focus-visible{box-shadow:0 0 0 2px var(--w-focus, var(--w-live))}
.tdash .fc.nf{width:20px;justify-content:center;color:var(--w-ink-faint)}
.tdash .tl{min-height:0;display:flex;flex-direction:column;padding:var(--w-s4) var(--w-s6) 0}
.tdash .tl{padding-right:0;border-left:var(--w-rule)}
.tdash h3{flex:none;margin:0;padding-bottom:var(--w-s2);font-size:var(--w-text-small);font-weight:500;line-height:var(--w-line-small);text-transform:uppercase;letter-spacing:var(--w-caps-spacing);color:var(--w-ink-faint)}
.tdash h3 .nn{margin-left:var(--w-s1)}
.tdash .cb{flex:1;min-height:0;overflow:auto;padding-bottom:var(--w-s6)}
.tdash .rk{color:var(--w-ink-faint);font-weight:400}
.tdash .ld{margin:2px 0 0;font-size:var(--w-text-small);line-height:var(--w-line-small);color:var(--w-ink-faint);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tdash .ld b{font-weight:500;color:var(--w-ink-muted)}
.tdash .ld em{font-style:normal;color:var(--w-ink-muted)}
.tdash .mu{color:var(--w-ink-faint)}
.tdash .tl ul{list-style:none;margin:0;padding:0}
.tdash .tl li{padding:var(--w-s2) 0;border-top:var(--w-rule)}
.tdash .tl li.ac,.tdash .tl li.nw{display:grid;grid-template-columns:auto 1fr auto;gap:var(--w-s2);align-items:start}
.tdash .tl li.gh{border-top:0;padding:var(--w-s3) 0 var(--w-s1);font-size:var(--w-text-small);color:var(--w-ink-faint);text-transform:uppercase;letter-spacing:.04em}
.tdash .tl li.nw p b{font-weight:500;color:var(--w-ink)}
.tdash .tl .fs{display:inline-flex;align-items:center;gap:2px}
.tdash .tl .ar{color:var(--w-ink-faint);font-size:var(--w-text-small)}
.tdash .tl li.ac time{display:inline;white-space:nowrap}
.tdash .tl .ab{all:unset;cursor:pointer;min-width:0}
.tdash .tl .ab:hover p{color:var(--w-ink)}
.tdash .tl .vb{display:inline-flex;align-items:center;gap:3px;font-weight:500;color:var(--w-ink)}
.tdash .tl .mo{font-style:normal;color:var(--w-ink-faint);text-decoration:underline}
.tdash .tl li.k-post-heads-up,.tdash .tl li.k-blocked,.tdash .tl li.k-feedback{box-shadow:inset 2px 0 0 var(--w-tone-warning, #c80);padding-left:var(--w-s2)}
.tdash .tl time{display:block;font-size:var(--w-text-small);line-height:var(--w-line-small);color:var(--w-ink-faint);font-variant-numeric:tabular-nums}
.tdash .tl p{margin:0;color:var(--w-ink-muted);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tdash .tl p b{font-weight:500;color:var(--w-ink)}
@media (max-width:1000px){.tdash{height:auto;overflow:visible;padding:var(--w-s4)}}
.tdash .tdx-h{display:flex;align-items:center;gap:var(--w-s1)}
.tdash .tdx-b{all:unset;flex:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:5px;color:var(--w-ink-faint)}
.tdash .tdx-b:hover{background:var(--w-hover);color:var(--w-ink)}.tdash .tdx-b:focus-visible{outline:var(--w-focus-width, 2px) solid var(--w-link)}
.tdash .tdx-b .w-icon{transition:transform .15s}
html[data-tdx-tl=shut] .tdash .tdx-b .w-icon{transform:rotate(180deg)}
html[data-tdx-tl=shut] .tdash .tdx-tl .cb{display:none}
/* side timeline; collapsed = one narrow column: chevron on top, vertical label under it, left-aligned */
.tdash .lr{transition:grid-template-columns .15s}
html[data-tdx-tl=shut] .tdash .lr{grid-template-columns:minmax(0,1fr) 2rem}
html[data-tdx-tl=shut] .tdash .tdx-tl{padding:var(--w-s4) 0 0 var(--w-s1)}
html[data-tdx-tl=shut] .tdash .tdx-tl .tdx-h{flex-direction:column;align-items:flex-start;gap:var(--w-s2)}
html[data-tdx-tl=shut] .tdash .tdx-tl .tdx-h span{writing-mode:vertical-rl;padding-left:3px}
@media (max-width:1000px){.tdash div.lr,html[data-tdx-tl=shut] .tdash .lr{grid-template-columns:1fr}.tdash .tdx-tl{border-left:0;padding:var(--w-s4) 0 0}html[data-tdx-tl=shut] .tdash .tdx-tl .tdx-h{flex-direction:row;align-items:center}html[data-tdx-tl=shut] .tdash .tdx-tl .tdx-h span{writing-mode:horizontal-tb;padding-left:0}.tdash .tdx-b .w-icon{transform:rotate(90deg)}html[data-tdx-tl=shut] .tdash .tdx-b .w-icon{transform:none}}
@media (max-width:700px){.tdash .hd{gap:var(--w-s2) var(--w-s3)}.tdash .mast{flex-basis:100%}}
.tdash .it{all:unset;box-sizing:border-box;display:block;width:100%;cursor:pointer;text-align:left}
.tdash .it:focus-visible{outline:var(--w-focus-width) solid var(--w-link);outline-offset:2px}
.tdash .rbtn{all:unset;flex:none;cursor:pointer;display:flex;align-items:center;gap:var(--w-s2);font-size:var(--w-text-small);color:var(--w-ink-muted);padding:2px var(--w-s2);border-radius:6px}
.tdash .rbtn:hover{background:var(--w-hover);color:var(--w-ink)}
.tdash .rbtn .stk{display:flex}.tdash .rbtn .stk>*{margin-left:-6px;border-radius:50%;box-shadow:0 0 0 2px var(--w-bg, #fff)}.tdash .rbtn .stk>*:first-child{margin-left:0}
/* linear */
.tdash .lr{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 22rem}
.tdash .lst{min-height:0;overflow:auto;padding:var(--w-s2) var(--w-s6) var(--w-s4) 0}
.tdash .gp h3{padding:var(--w-s3) var(--w-s2) var(--w-s1)}
.tdash .gp h3 small{font-weight:normal}
.tdash .hs>summary{cursor:pointer;list-style:none}.tdash .hs>summary::-webkit-details-marker{display:none}
.tdash .hs>summary h3::before{content:'▸ ';color:var(--w-ink-faint)}.tdash .hs[open]>summary h3::before{content:'▾ '}
.tdash .rw{display:grid;grid-template-columns:1.75rem minmax(10rem,auto) minmax(0,1fr) 1.5rem 2.5rem;align-items:center;gap:var(--w-s3);height:30px;padding:0 var(--w-s2);border-radius:var(--w-radius-item);white-space:nowrap}
.tdash .rw:hover,.tdash .rw:focus-visible{background:var(--w-hover)}
.tdash .rw .rk{--rc:var(--w-live);display:inline-flex;padding:2.5px;border-radius:999px;background:var(--rc)}.tdash .rw .rk.od{--rc:var(--w-danger)}.tdash .rw .rk .fc{border-radius:999px;background:var(--w-surface-document)}
.tdash .rw.s-done .fc,.tdash .rw.s-cancelled .fc{filter:grayscale(1);opacity:.6}
.tdash .am{display:inline-flex;align-items:center;gap:var(--w-s1);font-style:normal;font-size:var(--w-text-small);color:var(--w-success, var(--w-ink-muted));margin-left:var(--w-s2);vertical-align:middle}
.tdash .am .fc{transform:scale(.8)}
.tdash .mck{position:relative;display:inline-flex;width:18px;height:18px;flex:none;margin-left:var(--w-s2);vertical-align:middle}.tdash .mck>*{pointer-events:none}.tdash .mck>:first-child{width:18px;height:18px;border-radius:999px;overflow:hidden}.tdash .mck svg,.tdash .mck img{width:18px;height:18px}.tdash .mck i{position:absolute;right:-3px;bottom:-3px;width:9px;height:9px;border-radius:999px;background:var(--w-success, #1f9d55);color:#fff;font:700 7px/9px var(--w-font, sans-serif);font-style:normal;text-align:center;box-shadow:0 0 0 1.5px var(--w-surface-document, #fff)}
.tdash .rw .sw{font-style:normal;font-size:var(--w-text-small);color:var(--w-warning, var(--w-ink-muted));margin-left:var(--w-s1)}
.tdash .rw .rp{display:flex;align-items:center;justify-content:flex-end;gap:var(--w-s2);font-size:var(--w-text-small);min-width:0}
.tdash .rw .rt{display:flex;align-items:center;min-width:0;overflow:hidden}.tdash .rw .rtx{min-width:0;overflow:hidden;text-overflow:ellipsis}
.tdash .rw .rg{overflow:hidden;text-overflow:ellipsis;font-size:var(--w-text-small);color:var(--w-ink-faint)}
.tdash .rw .ro{display:flex;align-items:center;justify-content:center}
.tdash .rw time{font-size:var(--w-text-small);color:var(--w-ink-faint);text-align:right;font-variant-numeric:tabular-nums}
.tdash .rw.s-done .rt{color:var(--w-ink-muted)}
.tdash .rw.fresh .rt{color:var(--w-live)}
.tdash .rw .pg{display:flex;align-items:center;gap:var(--w-s2);overflow:hidden}
.tdash .pb{flex:0 0 4rem;width:4rem;height:4px;border-radius:2px;background:var(--w-hover);overflow:hidden}
.tdash .pb i{display:block;height:100%;background:var(--w-live)}
.tdash .pb.tm i{background:var(--w-ink-faint)}
.tdash .pb.od i{background:var(--w-danger)}
.tdash .rw .pg{white-space:nowrap;min-width:0}
.tdash .rw .pp{flex:0 0 2.25rem;text-align:right}
.tdash .rw .ps{flex:1 1 auto;min-width:0}
.tdash .np{display:flex;align-items:center;gap:var(--w-s2);margin-top:2px;font-size:var(--w-text-small);color:var(--w-ink-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.tdash .np .pb{flex-basis:3rem;width:3rem;height:3px}
.tdash .np .pe.od{color:var(--w-danger)}
.tdash .rw .pp{padding:0;overflow:visible;flex:0 0 2.25rem;text-align:right;font-variant-numeric:tabular-nums;color:var(--w-ink-muted)}
.tdash .rw .pe{flex:0 0 3.5rem;text-align:right;color:var(--w-ink-muted);font-variant-numeric:tabular-nums}
.tdash .rw .ps{overflow:hidden;text-overflow:ellipsis;color:var(--w-ink-faint)}
.tdash .rw .pe.od{color:var(--w-danger)}
.tdash .sz{display:inline-flex;align-items:center;justify-content:center;min-width:1.1rem;height:1.1rem;padding:0 3px;box-sizing:border-box;border:1px solid var(--w-border);border-radius:4px;font-size:10px;font-weight:600;line-height:1;color:var(--w-ink-muted);font-variant-numeric:tabular-nums}
`;

    const rootId = `tdash-${managerId || 'all'}`;
    // One look only (the dense list); an old `variant` in the URL is ignored.
    const selfUrl = `/rpc/team.dashboard?${encodeURIComponent(JSON.stringify(managerId ? { managerAgentId: managerId } : {}))}`;
    const timeline = `<h3 class="tdx-h"><button type="button" class="tdx-b" data-tdx-tl aria-label="Свернуть или развернуть хронику" title="Свернуть или развернуть хронику">${ctx.fns.w.icon({ name: 'caret-right', size: 14 })}</button><span>Хроника</span></h3><div class="cb">${actHtml ? `<ul>${actHtml}</ul>` : '<p class="mu">Пока тихо.</p>'}</div>`;
    let body: string;
    {
        // manager-checked first: they are ready for the person's final look
        const review = cards.filter(c => c.col === 'review').sort((a, b) => Number(!!b.acceptedBy) - Number(!!a.acceptedBy) || b.ts - a.ts);
        const active = cards.filter(c => c.col === 'working' || c.col === 'paused').sort((a, b) => Number(a.col === 'paused') - Number(b.col === 'paused') || b.ts - a.ts);
        const history = cards.filter(c => c.col === 'done' || c.col === 'cancelled').sort((a, b) => b.ts - a.ts);
        const reviewHtml = review.length ? `<section class="gp rv"><h3>Ревью <span class="nn">${review.length}</span> <small class="mu">— открой задачу, чтобы принять или ответить «Не согласен»</small></h3>${review.map(row).join('')}</section>` : group('Ревью', review);
        const historyHtml = `<details class="gp hs"><summary><h3>История <span class="nn">${history.length}</span></h3></summary>${history.map(row).join('')}</details>`;
        body = `<div class="lr"><div class="lst">${reviewHtml}${group('В работе', active, activeRow)}${group('Очередь', queue.filter(c => c.col === 'assigned'))}${group('Бэклог', queue.filter(c => c.col === 'backlog'))}${historyHtml}</div><aside class="tl tdx-tl" aria-label="Хроника">${timeline}</aside></div>`;
    }
    // «Команда» in the header: a stack of persona faces opening team.roster in the popup (roster, goal, or the «Создать команду» form).
    const rosterFaces = await ctx.fns.procs.db.select({ sql: `SELECT p.name, COALESCE(p.icon, a.icon) AS icon FROM team.team t JOIN team.team_persona tp ON tp.team_id = t.id AND tp.active JOIN team.persona p ON p.name = tp.persona_name LEFT JOIN agents a ON a.id = p.current_agent_id
        WHERE t.status IN ('draft','active') ${managerId ? 'AND t.supervisor_agent_id = ?' : ''} ORDER BY t.created_at DESC, tp.joined_at LIMIT 5`, params: managerId ? [managerId] : [] }) as Row[];
    const rosterBtn = `<button type="button" class="rbtn" hx-popup="team.roster" hx-popup-params="${esc(JSON.stringify({ ...(managerId ? { managerAgentId: managerId } : {}), back: selfUrl }))}" data-popup-title="Команда" aria-label="Команда" title="${esc(rosterFaces.length ? 'Команда: ' + rosterFaces.map(f => f.name).join(', ') : 'Команды пока нет — открыть и создать')}">${ctx.fns.w.icon({ name: 'users-three', size: 16 })}</button>`;
    // Header: one line — title + short status (details in its title), view tabs, team icon, bare faces.
    const statusTip = `обновлено ${lastTs ? clock(lastTs) + ' UTC, ' + short(lastTs) + ' назад' : '—'} · ${counters}`;
    const status = `<span class="hst${anyRunning ? ' on' : ''}" title="${esc(statusTip)}"><i class="hdot"></i>${anyRunning ? 'идёт работа' : 'тихо'}</span>`;
    // Side timeline collapse: state on <html data-tdx-tl>, kept in localStorage, so the 10s live swap does not reset it; narrow screens start collapsed.
    const tlScript = `<script>(function(){var d=document.documentElement,k='team.dashboard.timeline';function apply(){var v=null;try{v=localStorage.getItem(k)}catch(e){}if(v!=='open'&&v!=='shut')v=matchMedia('(max-width:700px)').matches?'shut':'open';d.dataset.tdxTl=v}apply();if(window.__tdxTl)return;window.__tdxTl=1;document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('[data-tdx-tl]');if(!b)return;var v=d.dataset.tdxTl==='shut'?'open':'shut';d.dataset.tdxTl=v;try{localStorage.setItem(k,v)}catch(_){}})})()</script>`;
    const inner = `<style>${css}</style>${tlScript}
<header class="hd"><div class="mast"><h1 title="${esc(title)}">${esc(title)}</h1>${status}</div>${rosterBtn}<div class="crew">${crew}</div></header>
${body}`;
    return ctx.fns.ui.live({ id: rootId, url: selfUrl, topic: 'team', every: 10, attrs: `class="tdash" hx-select="#${rootId}"`, html: inner });
}

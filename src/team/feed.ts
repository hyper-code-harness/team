/**
 * Reads the team chronicle — the same feed the person sees on the board: who works on what now, what was handed in, accepted, rated or sent back, next steps taken from reports, messages between team agents and shared notes (team.post)
 *
 * Call it when you take a task and before you edit a shared file, so you do not redo what someone already did or is doing. Without parameters a delegated child reads its own team: the manager defaults to the caller's parent agent (or the caller itself when it has no parent). Noise is dropped and runs are merged (one person taking and handing in a task becomes one "tookDone" entry, progress only when the stage changes). Sources: team.event of the team-plugin teams the caller can read, plan tasks of the manager's delegated children (start, done, estimate, progress stage, owner acceptance and feedback), agent.message between team agents (delegation briefs excluded) team.post notes, persona edits (team.persona_rev → kind 'persona': who changed whose prompt/notes/card, short diff) and hiring/firing (kind 'hire' / 'fire'). Entries about a persona carry `persona`. `working` lists tasks in progress right now with percent and stage. team.dashboard renders exactly this feed (all: true).
 *
 * Reading only what is new: every result carries `cursor` ("<ts>:<n>" — timestamp of the newest returned entry and its rank among entries with that timestamp). Called by an agent without `after`/`all` (mode 'unread'), the feed starts from the cursor stored for this agent and manager in team.feed_read, returns only newer entries oldest first and moves the stored cursor to the last returned one; the first call (no stored cursor) returns the last `limit` entries. `after: cursor` reads from that cursor (and stores the result for an agent caller). `all: true` / `unread: false`, a `sinceMs` or `kind` filter, or a caller without an agent (a person, the board) give the whole feed newest first as before and never move the stored cursor. `unreadCount` = entries newer than the start cursor at call time; `more` = how many of them did not fit into `limit`.
 * @param opts.managerAgentId Manager whose delegated children form the team. Default: the caller's parent agent, else the caller.
 * @param opts.sinceMs Only entries at or after this epoch-ms timestamp.
 * @param opts.limit Maximum number of entries. @default 30 @minimum 1 @maximum 200
 * @param opts.kind Only entries of this kind; a prefix before ':' also matches (kind 'post' matches 'post:note', 'post:heads-up'…).
 * @param opts.after Cursor from a previous result (or team.brief): only entries after it, oldest first.
 * @param opts.unread true: only entries after the stored cursor (default for an agent caller); false: the whole feed.
 * @param opts.all The whole feed newest first, the stored cursor is not moved (the board reads this way).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Manager whose delegated children form the team. Default: the caller's parent agent, else the caller. */
        managerAgentId?: string;
        /** Only entries at or after this epoch-ms timestamp. */
        sinceMs?: number;
        /** Maximum number of entries. @default 30 @minimum 1 @maximum 200 */
        limit?: number;
        /** Only entries of this kind; a prefix before ':' also matches (kind 'post' matches 'post:note', 'post:heads-up'…). */
        kind?: string;
        /** Cursor from a previous result (or team.brief): only entries after it, oldest first. */
        after?: string;
        /** true: only entries after the stored cursor (default for an agent caller); false: the whole feed. */
        unread?: boolean;
        /** The whole feed newest first, the stored cursor is not moved (the board reads this way). */
        all?: boolean;
    },
): Promise<{
    managerAgentId: string | null;
    /** 'unread': only new entries, oldest first; 'all': the whole feed, newest first. */
    mode: 'unread' | 'all';
    /** Position of the newest returned entry ("<ts>:<n>"); pass as after to read on. Null when the feed is empty. */
    cursor: string | null;
    /** Entries newer than the start cursor at call time (in 'all' mode: newer than the caller's stored cursor). */
    unreadCount: number;
    /** Unread entries that did not fit into limit; call again to read them. */
    more: number;
    working: Array<{ agentId: string; agentName: string; taskId: string; title: string; scope: 'team' | 'plan'; percent: number | null; stage: string | null; since: number }>;
    entries: Array<{ ts: number; actor: string; actorName: string; byUser: boolean; kind: string; taskId?: string; agentId?: string; scope?: 'team' | 'plan'; subject?: string; to?: string; toName?: string; /** Persona the entry is about (kind persona / hire / fire). */ persona?: string; text: string }>;
}> {
    type Row = Record<string, any>;
    const num = (v: unknown) => (Number(v) > 0 ? Number(v) : 0);
    const limit = opts.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('team.feed: limit must be an integer from 1 to 200');

    // ---- whose team: explicit manager, else caller's parent, else caller
    let managerId = opts.managerAgentId?.trim() || '';
    const meId = (session?.agent || session?.agentId) ? String((await ctx.fns.agent.current({})).id ?? '') : '';
    if (!managerId && meId) {
        const r = await ctx.fns.procs.db.select({ sql: 'SELECT parent_id FROM agents WHERE id = ?', params: [meId] }) as Row[];
        managerId = String(r[0]?.parent_id ?? '') || meId;
    }

    // ---- team-plugin teams the caller can read
    const teams = (await ctx.fns.team.list({})).filter(t => t.status !== 'archived');
    const allTasks: Row[] = []; const teamIds: string[] = [];
    for (const t of teams) {
        try { const g = await ctx.fns.team.get({ teamId: t.id }); teamIds.push(String(g.team.id)); allTasks.push(...g.tasks); }
        catch { /* not accessible: skip */ }
    }
    const events: Row[] = teamIds.length ? await ctx.fns.procs.db.select({ sql: 'SELECT team_id, seq, task_id, actor_kind, actor_id, kind, text, payload, timestamp FROM team.event WHERE team_id = ANY(?::text[]) ORDER BY timestamp DESC, seq DESC LIMIT 80', params: [teamIds] }) as Row[] : [];

    // ---- delegated children of the manager (same storage as agent.team, active + archived)
    const children: Row[] = [];
    if (managerId) {
        const rows = await ctx.fns.procs.db.select({ sql: "SELECT id, title, scratchpad, created_at, updated_at FROM agents WHERE parent_id = ? AND visibility = 'team' ORDER BY created_at ASC", params: [managerId] }) as Row[];
        for (const row of rows) {
            let sp: Row = {};
            try { sp = typeof row.scratchpad === 'string' ? JSON.parse(row.scratchpad) : (row.scratchpad ?? {}); } catch { sp = {}; }
            // The live in-memory agent can be ahead of the stored row: take the newer plan.
            const lsp: Row = (ctx.state as Row).agent?.[String(row.id)]?.scratchpad ?? {};
            if (lsp.plan && num(lsp.plan.updatedAt) > num(sp.plan?.updatedAt)) sp = { ...sp, plan: lsp.plan };
            const ld = lsp.delegation ?? lsp.delegateTask, dd = sp.delegation ?? sp.delegateTask;
            if (ld && ld.status === 'ready' && dd?.status !== 'ready') sp = { ...sp, delegation: ld };
            const del = sp.delegation ?? sp.delegateTask ?? {};
            children.push({ id: String(row.id), title: String(row.title ?? ''), planTasks: Array.isArray(sp.plan?.tasks) ? sp.plan.tasks : [], planTitle: String(sp.plan?.title ?? del.title ?? ''), createdAt: num(row.created_at), summary: del.summary ?? del.result?.summary ?? null, finishedAt: num(del.result?.finishedAt), updatedAt: num(row.updated_at) });
        }
    }
    const agentIds = [...(managerId ? [managerId] : []), ...children.map(c => String(c.id))];
    const acc = await ctx.fns.team.accepted({ agentIds: children.map(c => String(c.id)) });

    // ---- shared notes: authored by the team, tied to its teams, or by a person; missing table = no posts yet
    let posts: Row[] = [];
    const anyScope = agentIds.length > 0 || teamIds.length > 0; // no team at all: every post (person's board without a manager)
    try { posts = await ctx.fns.procs.db.select({ sql: `SELECT id, author_kind, author_id, team_id, task_id, kind, text, created_at FROM team.post${anyScope ? " WHERE author_kind <> 'agent' OR author_id = ANY(?::text[]) OR team_id = ANY(?::text[])" : ''} ORDER BY created_at DESC LIMIT 30`, params: anyScope ? [agentIds, teamIds] : [] }) as Row[]; }
    catch (e) { if (!/team\.post|does not exist/.test(String(e))) throw e; }

    // ---- messages between team agents (agent.message envelopes); delegation briefs dropped
    const teamSet = new Set(agentIds);
    const msgRows = agentIds.length ? await ctx.fns.procs.db.select({
        sql: `SELECT agent_id, ts, payload::jsonb->'agentMessage'->>'from' AS sender, left(payload::jsonb->'agentMessage'->>'body', 300) AS body
              FROM events WHERE agent_id = ANY(?::text[]) AND type = 'user' AND jsonb_exists(payload::jsonb, 'agentMessage') ORDER BY idx DESC LIMIT 40`,
        params: [agentIds] }) as Row[] : [];
    const msgs = msgRows.filter(m => teamSet.has(String(m.sender ?? '')) && !/^\s*You are a delegated (sub)?agent/i.test(String(m.body ?? '')) && !/\(askId [0-9a-f-]{8,}\)/.test(String(m.body ?? ''))); // team.ask/answer: their posts already tell it

    // ---- persona edits (team.persona_rev): prompt / notes / card of personas whose sessions are in this team, or of personas on its teams; missing table = none yet
    let revs: Row[] = [];
    try {
        revs = await ctx.fns.procs.db.select({ sql: `SELECT r.persona_name, r.field, r.author_kind, r.author_id, r.summary, r.revert_of, r.at FROM team.persona_rev r
              WHERE ${anyScope ? `r.persona_name IN (SELECT persona_name FROM team.persona_session WHERE agent_id = ANY(?::text[]) UNION SELECT name FROM team.persona WHERE current_agent_id = ANY(?::text[]) UNION SELECT persona_name FROM team.team_persona WHERE team_id = ANY(?::text[]))` : 'true'}
              ORDER BY r.at DESC LIMIT 30`, params: anyScope ? [agentIds, agentIds, teamIds] : [] }) as Row[];
    } catch (e) { if (!/persona|does not exist/.test(String(e))) throw e; }

    // ---- names (meta.persona.name, else id)
    const ids = new Set<string>(agentIds);
    for (const t of allTasks) if (t.assignee_agent_id) ids.add(String(t.assignee_agent_id));
    for (const e of events) if (e.actor_kind === 'agent' && e.actor_id) ids.add(String(e.actor_id));
    for (const p of posts) if (p.author_kind === 'agent' && p.author_id) ids.add(String(p.author_id));
    for (const r of revs) if (r.author_kind === 'agent' && r.author_id) ids.add(String(r.author_id));
    const names = new Map<string, string>();
    if (ids.size) for (const r of await ctx.fns.procs.db.select({ sql: 'SELECT id, meta FROM agents WHERE id = ANY(?::text[])', params: [[...ids]] }) as Row[]) {
        let meta: Row = {}; try { meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta ?? {}); } catch { meta = {}; }
        names.set(String(r.id), String(meta?.persona?.name ?? r.id));
    }
    const nameOf = (id: string) => names.get(id) ?? (id || '—');

    // ---- raw entries
    type Act = { ts: number; actor: string; user?: boolean; kind: string; subj?: string; text: string; to?: string; key?: string; taskId?: string; agentId?: string; scope?: 'team' | 'plan'; stage?: string; persona?: string };
    const shortTitle = (s: string) => s.replace(/^team:\s*/i, '');
    const taskTitle = new Map(allTasks.map(t => [String(t.id), String(t.title ?? t.id)]));
    // gist of a result: first layer of a two-layer summary (split by ---), no markdown
    const gistOf = (s: unknown) => (String(s ?? '').split(/\n\s*---+\s*\n|\s---\s/)[0] ?? '').replace(/[#*`>_]+/g, '').replace(/\s+/g, ' ').trim();
    const hum = (s: unknown) => gistOf(String(s ?? '').replace(/^(Progress|Estimate):\s*/i, ''));
    const sizeTxt = (v: Row) => { const z = String(v.size ?? '').toUpperCase(); if (['S', 'M', 'L'].includes(z)) return z; const m = num(v.minutes); return m ? (m <= 15 ? 'S' : m <= 60 ? 'M' : 'L') : '?'; };
    const estText = (v: Row) => `размер ${sizeTxt(v)}${num(v.steps) ? `, ${num(v.steps)} шаг.` : ''}${v.note ? ' — ' + String(v.note) : ''}`;
    // team.event kinds → feed kinds; anything not listed is noise (deliveries, heartbeats, passports, reorders…)
    const teamKind: Record<string, string> = { claim: 'started', start: 'started', resume: 'started', submit: 'done', done: 'done', result: 'done', approve: 'accepted', changes: 'feedback', feedback: 'feedback', block: 'blocked', deadline: 'blocked', say: 'message', taskAssign: 'assigned', progress: 'progress', 'report.progress': 'progress', estimate: 'estimate', 'report.milestone': 'note', 'report.finding': 'note', 'report.risk': 'heads-up', 'report.decision': 'note', memberHire: 'hire', memberFire: 'fire', personaJoin: 'hire', personaLeave: 'fire' };
    const raw: Act[] = [];
    for (const e of events) {
        const k = teamKind[String(e.kind ?? '')]; if (!k) continue;
        if ((e.kind === 'changes' || e.kind === 'say') && /^Владелец вернул в работу:/.test(String(e.text ?? ''))) continue; // shown as 'reopen' from team.reopen
        const tid = e.task_id ? String(e.task_id) : '';
        let p: Row = {}; try { p = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload ?? {}); } catch { p = {}; }
        const text = k === 'estimate' ? estText(p) : k === 'progress' ? String(p.stage ?? hum(e.text)) : ['started', 'accepted', 'assigned'].includes(k) ? '' : hum(e.text);
        const hf = k === 'hire' || k === 'fire';
        const pname = hf ? String(p.persona?.name ?? p.command?.persona?.name ?? p.command?.name ?? p.personaName ?? p.command?.personaName ?? '') : '';
        raw.push({ ts: num(e.timestamp), actor: String(e.actor_id ?? ''), user: e.actor_kind !== 'agent', kind: k, subj: tid ? taskTitle.get(tid) ?? tid : (pname || ''), text: hf ? String(e.text ?? '').replace(/\s+/g, ' ').trim() : text, key: tid ? 't:' + tid : undefined, taskId: tid || undefined, scope: tid ? 'team' : undefined, stage: k === 'progress' ? String(p.stage ?? '') : undefined, to: k === 'assigned' && p.assigneeAgentId ? String(p.assigneeAgentId) : hf && p.command?.agentId ? String(p.command.agentId) : undefined, persona: pname || undefined });
    }
    // persona edits: who changed which part of whose persona, short diff summary
    const fieldRu: Record<string, string> = { prompt: 'промпт', notes: 'заметки', card: 'карточку' };
    for (const r of revs) {
        const what = `${r.revert_of ? 'откатил(а) ' : ''}${fieldRu[String(r.field)] ?? String(r.field)}`;
        raw.push({ ts: num(r.at), actor: String(r.author_id ?? ''), user: r.author_kind !== 'agent', kind: 'persona', subj: String(r.persona_name), text: `${what}${r.summary ? ': ' + String(r.summary).replace(/^(prompt|notes|card):\s*/i, '') : ''}`, key: 'p:' + String(r.persona_name) + ':' + String(r.field), persona: String(r.persona_name) });
    }
    for (const c of children) {
        if ((c.planTitle || c.title) && c.createdAt && managerId) raw.push({ ts: c.createdAt, actor: managerId, kind: 'assigned', subj: shortTitle(String(c.planTitle || c.title)).replace(/^[\p{L}-]{2,20}:\s*/u, ''), text: '', to: c.id });
        if (c.summary && c.finishedAt && !(c.planTasks as Row[]).some(t => gistOf(t.resultSummary ?? t.result?.summary ?? '') === gistOf(c.summary))) raw.push({ ts: c.finishedAt, actor: c.id, kind: 'finished', subj: shortTitle(String(c.planTitle || c.title)), text: gistOf(c.summary) });
        for (const t of c.planTasks as Row[]) {
            const tid = String(t.id ?? ''), key = c.id + ':' + tid, subj = String(t.title ?? t.id);
            const ref = { key, taskId: tid, agentId: String(c.id), scope: 'plan' as const };
            if (num(t.startedAt)) raw.push({ ts: num(t.startedAt), actor: c.id, kind: 'started', subj, text: '', ...ref });
            if (num(t.completedAt)) raw.push({ ts: num(t.completedAt), actor: c.id, kind: 'done', subj, text: gistOf(t.resultSummary ?? t.result?.summary ?? ''), ...ref });
            if (t.estimate && num(t.estimate.at)) raw.push({ ts: num(t.estimate.at), actor: c.id, kind: 'estimate', subj, text: estText(t.estimate), ...ref });
            if (t.progress?.stage && num(t.progress.at) && t.status !== 'done') raw.push({ ts: num(t.progress.at), actor: c.id, kind: 'progress', subj, text: `${num(t.progress.percent) ? num(t.progress.percent) + '% · ' : ''}${String(t.progress.stage)}`, stage: String(t.progress.stage), ...ref });
            if (acc.at[key]) { const mgr = /^manager:/.test(acc.by?.[key] ?? '') ? String(acc.by[key]).slice(8) : ''; raw.push({ ts: acc.at[key], actor: mgr || String(acc.by?.[key] ?? ''), user: !mgr, kind: 'accepted', subj, text: mgr ? 'первый проход — ждёт человека' : '', ...ref }); }
            for (const f of (Array.isArray(t.feedback) ? t.feedback : []) as Row[]) if (num(f.at)) raw.push({ ts: num(f.at), actor: String(f.by ?? ''), user: true, kind: 'feedback', subj, text: String(f.text ?? ''), ...ref });
        }
    }
    for (const m of msgs) { const b = gistOf(m.body).replace(/^[\p{Lu}][\p{L}-]{1,20},\s*/u, ''); raw.push({ ts: num(m.ts), actor: String(m.sender), kind: /\?/.test(b) ? 'ask' : 'message', text: b, to: String(m.agent_id) }); }
    for (const p of posts) {
        const tid = p.task_id ? String(p.task_id) : '';
        const child = tid ? children.find(c => c.id === String(p.author_id) && (c.planTasks as Row[]).some(t => String(t.id) === tid)) : undefined;
        const pt = child ? (child.planTasks as Row[]).find(t => String(t.id) === tid) : undefined;
        const ref = child && pt ? { taskId: tid, agentId: String(child.id), scope: 'plan' as const, subj: String(pt.title ?? tid) } : tid && taskTitle.has(tid) ? { taskId: tid, scope: 'team' as const, subj: taskTitle.get(tid) } : tid ? { taskId: tid } : {};
        // the subject stays out of the board line (posts show only their text); agents get it as `subject`
        raw.push({ ts: num(p.created_at), actor: String(p.author_id ?? ''), user: p.author_kind !== 'agent', kind: 'post:' + String(p.kind ?? 'note'), text: String(p.text ?? ''), ...ref, subj: undefined, stage: (ref as Row).subj });
    }
    // ---- owner actions on report «Дальше» items (team.next) and star ratings (team.rating); missing tables = none yet
    const childIds = children.map(c => String(c.id)); const teamTaskIds = allTasks.map(t => String(t.id));
    const refOf = (aid: string, tid: string): Row => { const c = aid ? children.find(x => x.id === aid) : undefined; const pt = c ? (c.planTasks as Row[]).find(t => String(t.id) === tid) : undefined; return c ? { taskId: tid, agentId: aid, scope: 'plan', subj: String(pt?.title ?? tid) } : { taskId: tid, scope: 'team', subj: taskTitle.get(tid) ?? tid }; };
    if (childIds.length || teamTaskIds.length) {
        try { for (const n of await ctx.fns.procs.db.select({ sql: "SELECT agent_id, task_id, kind, title, action, by_user, at, result->>'reopenId' AS rid FROM team.next WHERE (agent_id <> '' AND agent_id = ANY(?::text[])) OR (agent_id = '' AND task_id = ANY(?::text[])) ORDER BY at DESC LIMIT 30", params: [childIds, teamTaskIds] }) as Row[])
            if (!n.rid) raw.push({ ts: num(n.at), actor: String(n.by_user ?? ''), user: true, kind: 'next', text: (n.kind === 'continue' ? 'вернул в работу: ' : 'в бэклог: ') + String(n.title ?? ''), ...refOf(String(n.agent_id ?? ''), String(n.task_id)) } as Act); }
        catch (e) { if (!/team\.next|does not exist/.test(String(e))) throw e; }
        try { for (const r of await ctx.fns.procs.db.select({ sql: "SELECT agent_id, task_id, stars, comment, rated_by, rated_at FROM team.rating WHERE (agent_id <> '' AND agent_id = ANY(?::text[])) OR (agent_id = '' AND task_id = ANY(?::text[])) ORDER BY rated_at DESC LIMIT 30", params: [childIds, teamTaskIds] }) as Row[])
            raw.push({ ts: num(r.rated_at), actor: String(r.rated_by ?? ''), user: true, kind: 'rating', text: '★' + num(r.stars) + (r.comment ? ' — ' + String(r.comment) : ''), ...refOf(String(r.agent_id ?? ''), String(r.task_id)) } as Act); }
        catch (e) { if (!/team\.rating|does not exist/.test(String(e))) throw e; }
        // returns to work with a comment (team.reopen); a «Дальше» item returned to work shows here, not as 'next'
        try { for (const r of await ctx.fns.procs.db.select({ sql: "SELECT agent_id, task_id, comment, action, to_agent_id, new_agent_id, by_actor, at FROM team.reopen WHERE (agent_id <> '' AND agent_id = ANY(?::text[])) OR (agent_id = '' AND task_id = ANY(?::text[])) ORDER BY at DESC LIMIT 30", params: [childIds, teamTaskIds] }) as Row[]) {
            const mgr = /^manager:/.test(String(r.by_actor ?? '')) ? String(r.by_actor).slice(8) : '';
            raw.push({ ts: num(r.at), actor: mgr || String(r.by_actor ?? ''), user: !mgr, kind: 'reopen', text: String(r.comment ?? ''), to: String(r.to_agent_id || r.agent_id || '') || undefined, ...refOf(String(r.agent_id ?? ''), String(r.task_id)) } as Act);
        } }
        catch (e) { if (!/team\.reopen|does not exist/.test(String(e))) throw e; }
    }

    // ---- oldest first: progress only when the stage changes; drop "started" right after being assigned;
    // merge one person's run on one task (берёт → сдаёт), repeated identical events collapse to the last
    raw.sort((a, b) => a.ts - b.ts);
    const lastStage = new Map<string, string>(), assignedAt = new Map<string, number>();
    const acts: Act[] = [];
    for (const a of raw) {
        if (a.kind === 'progress') { const k = a.key ?? a.subj ?? ''; if (!a.stage || lastStage.get(k) === a.stage) continue; lastStage.set(k, a.stage); }
        if (a.kind === 'assigned' && a.to) assignedAt.set(a.to, a.ts);
        if (a.kind === 'started' && a.ts - (assignedAt.get(a.actor) ?? -1e15) < 5 * 60000 && !acts.some(x => x.kind === 'started' && x.actor === a.actor)) continue;
        const prev = acts[acts.length - 1];
        const same = prev && a.key && prev.key === a.key && nameOf(prev.actor) === nameOf(a.actor) && !prev.user && !a.user;
        if (same && a.kind === 'done' && ['started', 'progress', 'estimate'].includes(prev.kind)) { acts[acts.length - 1] = { ...a, kind: 'tookDone' }; continue; }
        if (prev && a.kind === 'accepted' && prev.kind === 'accepted' && a.ts - prev.ts < 3 * 60000) { const list = [prev.text || `«${prev.subj}»`, `«${a.subj}»`].join(', '); acts[acts.length - 1] = { ...a, subj: '', text: list, taskId: undefined, agentId: undefined, scope: undefined }; continue; }
        if (same && a.kind === prev.kind) { acts[acts.length - 1] = a; continue; }
        if (prev && prev.kind === a.kind && prev.actor === a.actor && prev.to === a.to && prev.text === a.text && prev.subj === a.subj) { acts[acts.length - 1] = a; continue; }
        acts.push(a);
    }
    // ---- cursor: "<ts>:<n>" = n-th entry (1-based) with timestamp ts in the oldest-first list
    const rank: number[] = [];
    for (let i = 0; i < acts.length; i++) rank.push(i > 0 && acts[i - 1]!.ts === acts[i]!.ts ? rank[i - 1]! + 1 : 1);
    const parseCursor = (c: string | null | undefined): [number, number] | null => {
        const m = /^(\d+):(\d+)$/.exec(String(c ?? '').trim());
        return m ? [Number(m[1]), Number(m[2])] : null;
    };
    const isAfter = (i: number, c: [number, number]) => acts[i]!.ts > c[0] || (acts[i]!.ts === c[0] && rank[i]! > c[1]);
    const cursorAt = (i: number) => `${acts[i]!.ts}:${rank[i]}`;
    if (opts.after !== undefined && !parseCursor(opts.after)) throw new Error('team.feed: after must be a cursor "<ts>:<n>" from a previous result');
    const since = num(opts.sinceMs), kind = opts.kind?.trim();
    const filtered = opts.sinceMs !== undefined || !!kind;
    const mode: 'unread' | 'all' = opts.all || opts.unread === false ? 'all'
        : opts.after !== undefined || opts.unread === true ? 'unread'
        : meId && !filtered ? 'unread' : 'all';
    if (mode === 'unread' && !meId && opts.after === undefined) throw new Error('team.feed: unread needs an agent caller or an after cursor');

    // stored read position of this agent in this manager's feed
    const readKey = managerId || meId;
    let stored: [number, number] | null = null;
    if (meId) {
        try { stored = parseCursor(String(((await ctx.fns.procs.db.select({ sql: 'SELECT cursor FROM team.feed_read WHERE agent_id = ? AND manager_id = ?', params: [meId, readKey] })) as Row[])[0]?.cursor ?? '')); }
        catch (e) { if (!/feed_read|does not exist/.test(String(e))) throw e; }
    }
    const keep = (i: number) => { const a = acts[i]!; return (!since || a.ts >= since) && (!kind || a.kind === kind || a.kind.split(':')[0] === kind); };
    let idx: number[] = []; let unreadCount = 0, more = 0; let cursor: string | null = null;
    if (mode === 'unread') {
        const start = opts.after !== undefined ? parseCursor(opts.after) : stored;
        const fresh = acts.map((_, i) => i).filter(i => (!start || isAfter(i, start)) && keep(i));
        // no cursor yet: the last `limit` entries; with a cursor: the oldest unread first, rest via `more`
        idx = start ? fresh.slice(0, limit) : fresh.slice(-limit);
        unreadCount = fresh.length; more = start ? fresh.length - idx.length : 0;
        cursor = idx.length ? cursorAt(idx[idx.length - 1]!) : start ? `${start[0]}:${start[1]}` : null;
        if (meId && cursor) {
            // self-heal DDL, same as $migration_20291220000100_team_feed_read
            await ctx.fns.procs.db.run({ sql: 'CREATE TABLE IF NOT EXISTS team.feed_read (agent_id text NOT NULL, manager_id text NOT NULL, cursor text NOT NULL, read_at bigint NOT NULL, PRIMARY KEY (agent_id, manager_id))' });
            await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.feed_read (agent_id, manager_id, cursor, read_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, manager_id) DO UPDATE SET cursor = EXCLUDED.cursor, read_at = EXCLUDED.read_at', params: [meId, readKey, cursor, Date.now()] });
        }
    } else {
        idx = acts.map((_, i) => i).filter(keep).reverse().slice(0, limit);
        cursor = acts.length ? cursorAt(acts.length - 1) : null;
        unreadCount = stored ? acts.filter((_, i) => isAfter(i, stored!)).length : 0;
    }
    const entries = idx.map(i => acts[i]!)
        .map(a => {
            const e: Row = { ts: a.ts, actor: a.actor, actorName: a.user && !names.has(a.actor) ? 'человек' : nameOf(a.actor), byUser: !!a.user, kind: a.kind, text: String(a.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600) };
            if (a.taskId) e.taskId = a.taskId;
            if (a.agentId) e.agentId = a.agentId;
            if (a.scope) e.scope = a.scope;
            const subject = a.subj || (a.kind.startsWith('post:') ? a.stage : '');
            if (subject) e.subject = subject;
            if (a.to) { e.to = a.to; e.toName = nameOf(a.to); }
            if (a.persona) e.persona = a.persona;
            return e as { ts: number; actor: string; actorName: string; byUser: boolean; kind: string; taskId?: string; agentId?: string; scope?: 'team' | 'plan'; subject?: string; to?: string; toName?: string; persona?: string; text: string };
        });

    // ---- working now: team tasks in 'working' and active plan tasks, newest first, with percent and stage
    const prog = new Map<string, { percent: number | null; stage: string | null }>();
    try {
        for (const p of await ctx.fns.team.taskProgressBatch({ teamIds, agentIds: children.map(c => String(c.id)) })) prog.set(p.scope === 'team' ? 't:' + p.taskId : String(p.agentId) + ':' + p.taskId, p);
    } catch { /* progress is optional */ }
    const working: Array<{ agentId: string; agentName: string; taskId: string; title: string; scope: 'team' | 'plan'; percent: number | null; stage: string | null; since: number }> = [];
    const taskTs = new Map<string, number>();
    for (const e of events) if (e.task_id) taskTs.set(String(e.task_id), Math.max(taskTs.get(String(e.task_id)) ?? 0, num(e.timestamp)));
    for (const t of allTasks) if (t.status === 'working') { const p = prog.get('t:' + t.id); working.push({ agentId: String(t.assignee_agent_id ?? ''), agentName: nameOf(String(t.assignee_agent_id ?? '')), taskId: String(t.id), title: String(t.title ?? t.id), scope: 'team', percent: p?.percent ?? null, stage: p?.stage ?? null, since: taskTs.get(String(t.id)) ?? 0 }); }
    for (const c of children) for (const t of c.planTasks as Row[]) if (['active', 'working', 'in_progress'].includes(String(t.status))) {
        const p = prog.get(c.id + ':' + String(t.id ?? ''));
        working.push({ agentId: String(c.id), agentName: nameOf(String(c.id)), taskId: String(t.id ?? ''), title: String(t.title ?? t.id), scope: 'plan', percent: p?.percent ?? null, stage: p?.stage ?? null, since: num(t.activeSince) || num(t.startedAt) || num(c.updatedAt) });
    }
    working.sort((a, b) => b.since - a.since);
    return { managerAgentId: managerId || null, mode, cursor, unreadCount, more, working, entries };
}

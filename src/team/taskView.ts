/**
 * Renders one task as a full card: status, assignee face, report, brief, history and a feedback form
 *
 * Read-only @view page of a single task. Without agentId it is a team.task row (access via team.get, report from the latest submit event); with agentId it is a plan task of that delegated child (report from plan task .report or result). Shows, top to bottom: title, coloured status, assignee; the brief (human part before "---", agent details folded); "Что сделано" (short summary before "---", visuals grid with a large view on click, a one-line checks note, «Не сделано» and «Дальше» items with «Вернуть в работу»/«В бэклог» buttons posting to /team/next); folded "Подробный отчёт" (rest of summary, steps, decisions, full checks, notCovered, files, raw result); folded history; and last a decision bar sticky at the bottom: 1–5 star rating posting to /team/rate, a comment with «Не согласен» (secondary) posting to /team/feedback and «Принять» (primary, right) posting to /team/accept. Opened full-screen in the app popup by team.taskPopup.
 * @view
 * @live team
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child agent whose plan holds the task; omit for a team.task.
 * @param opts.notice Quiet line shown next to the send button (result of the last feedback).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child agent whose plan holds the task; omit for a team.task. */
        agentId?: string;
        /** Quiet line shown next to the send button (result of the last feedback). */
        notice?: string;
    },
): Promise<string> {
    type Row = Record<string, any>;
        const w = ctx.fns.w;
        const esc = (v: unknown) => w.escape({ text: v === null || v === undefined ? '' : String(v) });
        const taskId = String(opts.taskId ?? '').trim();
        const agentId = String(opts.agentId ?? '').trim();
        if (!taskId) return w.empty({ title: 'No task', icon: 'question', hint: 'taskId is required.' });
        const json = (v: unknown): Row => { if (!v) return {}; if (typeof v === 'object') return v as Row; try { return JSON.parse(String(v)); } catch { return {}; } };
        const tone: Record<string, types.w.Tone> = { todo: 'neutral', pending: 'neutral', assigned: 'info', working: 'info', active: 'info', blocked: 'danger', paused: 'warning', review: 'accent', done: 'success', cancelled: 'neutral', archived: 'neutral' };
        const label: Record<string, string> = { todo: 'в бэклоге', pending: 'ждёт', assigned: 'назначена', working: 'в работе', active: 'в работе', blocked: 'заблокирована', paused: 'на паузе', review: 'на ревью', done: 'готово', cancelled: 'отменена' };
        const box = (body: string, mix: types.w.Mixin | types.w.Mixin[]) => w.box({ body, mix });
        const caption = (t: string) => box(esc(t), { caption: true });
    
        // ---- load: team task or delegated child plan task
        let kind: 'team' | 'child' = agentId ? 'child' : 'team';
        // set when a manager agent (team.accept by 'manager:<id>') accepted this plan task; a person may still return it
        let acceptedByManager = '', acceptedAt = 0;
        let title = '', status = '', ownerId = '', group = '', instructions = '', acceptance = '';
        let report: Row | null = null; let legacy = ''; let raw: Row | null = null;
        const history: Array<{ ts: number; actor: string; actorKind: string; kind: string; text: string }> = [];
        let note = '';
        if (kind === 'team') {
            const rows = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id = ? LIMIT 5', params: [taskId] }) as Row[];
            if (!rows.length) return w.empty({ title: 'Задача не найдена', icon: 'magnifying-glass', hint: taskId });
            let data: any = null;
            for (const r of rows) { try { data = await ctx.fns.team.get({ teamId: String(r.team_id) }); if (data.tasks.some((t: Row) => t.id === taskId)) break; } catch { data = null; } }
            const t: Row | undefined = data?.tasks.find((x: Row) => x.id === taskId);
            if (!t) return w.empty({ title: 'Нет доступа к задаче', icon: 'lock', tone: 'danger', hint: taskId });
            title = String(t.title); status = String(t.status); ownerId = String(t.assignee_agent_id ?? '');
            // first review pass by the supervisor (team.accept by 'manager:<id>', agent_id '') — still in review, waits for the person
            if (status === 'review') { try { const acc = await ctx.fns.team.accepted({ agentIds: [''] }); const k = ':' + taskId; if (/^manager:/.test(acc.by?.[k] ?? '') && Number(acc.at[k]) >= (Number(t.completedAt) || 0)) { acceptedByManager = String(acc.by[k]).slice(8); acceptedAt = Number(acc.at[k]) || 0; } } catch {} }
            ownerId = String(t.assignee_agent_id ?? ''); group = String(t.group_key ?? data.team.title ?? '');
            instructions = String(t.instructions ?? ''); acceptance = String(t.acceptance_criteria ?? '');
            note = String(t.blocked_reason ?? t.paused_note ?? '');
            const evs = await ctx.fns.procs.db.select({ sql: 'SELECT seq, actor_kind, actor_id, kind, text, payload, timestamp FROM team.event WHERE team_id = ? AND task_id = ? ORDER BY seq', params: [data.team.id, taskId] }) as Row[];
            for (const e of evs) {
                history.push({ ts: Number(e.timestamp), actor: String(e.actor_id), actorKind: String(e.actor_kind), kind: String(e.kind), text: String(e.text ?? '') });
                if (e.kind === 'submit') { const p = json(e.payload); const c = p.command?.transition ?? {}; report = p.report ?? await ctx.fns.team.normalizeReport({ report: c.report ?? null, fallbackSummary: c.summary ?? e.text, fallbackFiles: c.artifacts ?? [], fallbackCheck: c.verification ?? '' }); }
            }
        } else {
            if (!(await ctx.fns.jobs.canSee({ agentId }))) return w.empty({ title: 'Нет доступа к агенту', icon: 'lock', tone: 'danger', hint: agentId });
            const rows = await ctx.fns.procs.db.select({ sql: 'SELECT id, title, scratchpad, archived_at FROM agents WHERE id = ?', params: [agentId] }) as Row[];
            const a = rows[0]; if (!a) return w.empty({ title: 'Агент не найден', icon: 'magnifying-glass', hint: agentId });
            const sp = json(a.scratchpad); const tasks: Row[] = Array.isArray(sp.plan?.tasks) ? sp.plan.tasks : [];
            const t = tasks.find(x => x?.id === taskId);
            if (!t) return w.empty({ title: 'Задача не найдена в плане', icon: 'magnifying-glass', hint: `${agentId} · ${taskId}` });
            title = String(t.title ?? taskId); status = String(t.status ?? 'pending'); ownerId = agentId;
            if (status === 'done') { const acc = await ctx.fns.team.accepted({ agentIds: [agentId] }); const k = agentId + ':' + taskId; if ((Number(t.completedAt) || 0) >= acc.since && !acc.keys.includes(k)) status = 'review'; if (/^manager:/.test(acc.by?.[k] ?? '') && Number(acc.at[k]) >= (Number(t.completedAt) || 0)) { acceptedByManager = String(acc.by[k]).slice(8); acceptedAt = Number(acc.at[k]) || 0; } } group = String(a.title ?? '').replace(/^team:\s*/i, '');
            instructions = String(t.instructions ?? '');
            if (a.archived_at != null) note = 'Агент в архиве: «Вернуть в работу» поручит доделать новой сессии той же персоны.';
            const r = t.result && typeof t.result === 'object' ? t.result as Row : null;
            raw = r;
            const shaped = r && (r.report || r.summary || r.done || r.decisions || r.next || r.notDone || r.visuals);
            if (t.report) report = t.report;
            else if (shaped) report = await ctx.fns.team.normalizeReport({ report: r.report ?? r, fallbackSummary: String(t.resultSummary ?? '') || undefined });
            else if (t.resultSummary) { report = await ctx.fns.team.normalizeReport({ report: { summary: String(t.resultSummary), files: Array.isArray(r?.files) ? r!.files : undefined } }); }
            if (r) legacy = JSON.stringify(r, null, 2).slice(0, 4000);
            const at = (ts: unknown, k: string, text: string, actor = agentId, actorKind = 'agent') => { if (Number(ts) > 0) history.push({ ts: Number(ts), actor, actorKind, kind: k, text }); };
            at(t.startedAt, 'start', 'взял в работу');
            at(t.report?.at, 'report', 'написал отчёт');
            at(t.completedAt, 'done', 'отметил выполненной');
            at(t.resultAt, 'result', String(t.resultSummary ?? 'сдал результат'));
            for (const f of Array.isArray(t.feedback) ? t.feedback : []) at(f.at, 'feedback', String(f.text ?? ''), String(f.by ?? 'owner'), 'user');
            history.sort((x, y) => x.ts - y.ts);
        }

        // ---- owner actions on «Дальше» items (team.next) and the owner's star rating (team.rating); missing tables = none yet
        const nextDone = new Map<number, Row>(); let rating: Row | null = null;
        try { for (const n of await ctx.fns.procs.db.select({ sql: 'SELECT idx, kind, title, action, result, by_user, at FROM team.next WHERE agent_id = ? AND task_id = ?', params: [agentId, taskId] }) as Row[]) { nextDone.set(Number(n.idx), n); if (!json(n.result).reopenId) history.push({ ts: Number(n.at), actor: String(n.by_user), actorKind: 'user', kind: 'next', text: (n.kind === 'continue' ? 'вернул в работу: ' : 'в бэклог: ') + String(n.title) }); } } catch (e) { if (!/team\.next|does not exist/.test(String(e))) throw e; }
        try { rating = ((await ctx.fns.procs.db.select({ sql: 'SELECT stars, comment, rated_by, rated_at FROM team.rating WHERE agent_id = ? AND task_id = ?', params: [agentId, taskId] })) as Row[])[0] ?? null; } catch (e) { if (!/team\.rating|does not exist/.test(String(e))) throw e; }
        if (rating) history.push({ ts: Number(rating.rated_at), actor: String(rating.rated_by), actorKind: 'user', kind: 'rating', text: '★' + Number(rating.stars) + (rating.comment ? ' — ' + String(rating.comment) : '') });
        // ---- returns to work (team.reopen) and the continuation link: old task → «продолжение → …», new task → «продолжение задачи …»; missing table = none yet
        const links: Array<{ dir: 'to' | 'from'; agentId: string; taskId: string; at: number }> = [];
        try {
            for (const r of await ctx.fns.procs.db.select({ sql: 'SELECT agent_id, task_id, comment, action, to_agent_id, new_agent_id, new_task_id, by_actor, at FROM team.reopen WHERE agent_id = ? AND task_id = ? ORDER BY at', params: [agentId, taskId] }) as Row[]) {
                const mgr = /^manager:/.test(String(r.by_actor)) ? String(r.by_actor).slice(8) : '';
                history.push({ ts: Number(r.at), actor: mgr || String(r.by_actor), actorKind: mgr ? 'agent' : 'user', kind: 'reopen', text: 'вернул в работу: ' + String(r.comment) });
                if (r.new_agent_id || r.new_task_id) links.push({ dir: 'to', agentId: String(r.new_agent_id ?? ''), taskId: String(r.new_task_id || 'task'), at: Number(r.at) });
            }
            const back = agentId
                ? await ctx.fns.procs.db.select({ sql: "SELECT agent_id, task_id, at FROM team.reopen WHERE new_agent_id = ? AND new_task_id = ? ORDER BY at DESC LIMIT 1", params: [agentId, taskId] }) as Row[]
                : await ctx.fns.procs.db.select({ sql: "SELECT agent_id, task_id, at FROM team.reopen WHERE agent_id = '' AND new_agent_id = '' AND new_task_id = ? ORDER BY at DESC LIMIT 1", params: [taskId] }) as Row[];
            for (const r of back) links.push({ dir: 'from', agentId: String(r.agent_id ?? ''), taskId: String(r.task_id), at: Number(r.at) });
        } catch (e) { if (!/team\.reopen|does not exist/.test(String(e))) throw e; }
        history.sort((x, y) => x.ts - y.ts);
        const root = 'team-task-' + (agentId ? agentId + '-' : '') + taskId.replace(/[^\w-]/g, '_');
        const req = (session as any)?.req as Request | undefined;
        const csrf = req ? await ctx.fns.auth.csrfField({ req }) : '';
        const vals = { taskId, ...(agentId ? { agentId } : {}) };

        // ---- faces
        const ids = [...new Set([ownerId, acceptedByManager, ...links.map(l => l.agentId), ...history.filter(h => h.actorKind === 'agent').map(h => h.actor)].filter(Boolean))];
        const who = new Map<string, Row>();
        if (ids.length) for (const r of await ctx.fns.procs.db.select({ sql: 'SELECT id, icon, model, meta, title FROM agents WHERE id = ANY(?::text[])', params: [ids] }) as Row[]) {
            const m = json(r.meta); who.set(String(r.id), { icon: r.icon ?? null, model: r.model ?? null, name: String(m?.persona?.name ?? r.title ?? r.id), role: String(m?.persona?.role ?? '') });
        }
        const face = (id: string, size: 'sm' | 'md' | 'lg' = 'sm') => w.chatIcon({ icon: who.get(id)?.icon ?? null, model: who.get(id)?.model ?? null, size });
        const nameOf = (id: string, k = 'agent') => k === 'user' ? 'Вы' : k === 'system' ? 'система' : (who.get(id)?.name ?? id);
    
        // ---- header
        const glyph: Record<string, string> = { working: '◐', active: '◐', todo: '○', pending: '○', assigned: '○', review: '◎', paused: '‖', blocked: '!', done: '✓', cancelled: '×', archived: '×' };
        const st = `<span class="st s-${esc(status)}"><span class="gl">${glyph[status] ?? '○'}</span>${esc(label[status] ?? status)}</span>`;
        // persona of the owner session (team.persona): its face opens team.persona, like on the board; missing table = none
        let persona = '';
        if (ownerId) try { persona = String(((await ctx.fns.procs.db.select({ sql: `SELECT p.name FROM team.persona p LEFT JOIN team.persona_session s ON s.persona_name = p.name WHERE p.current_agent_id = ? OR s.agent_id = ? OR p.name = ? ORDER BY (p.name = ?) LIMIT 1`, params: [ownerId, ownerId, nameOf(ownerId), nameOf(ownerId)] })) as Row[])[0]?.name ?? ''); } catch (e) { if (!/persona|does not exist/.test(String(e))) throw e; }
        const ownerName = ownerId ? (persona || nameOf(ownerId)) : '';
        const role = ownerId ? String(who.get(ownerId)?.role ?? '') : '';
        // the task name without the «Имя: » prefix — the face and name already say who
        const shortTitle = ownerName ? title.replace(new RegExp('^\\s*' + ownerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*', 'i'), '') || title : title;
        const pAttrs = persona ? ` role="button" tabindex="0" hx-popup="team.persona" hx-popup-params="${esc(JSON.stringify({ name: persona }))}" title="${esc('Персона ' + persona)}" aria-label="${esc('Персона ' + persona)}"` : '';
        const ownerHead = ownerId
            ? `<span class="tv-ow${persona ? ' tv-pf' : ''}"${pAttrs}>${face(ownerId, 'sm')}<b>${esc(ownerName)}</b></span>`
            : '<span class="tv-mu">не назначена</span>';
        const accWhen = acceptedAt ? ' · ' + new Date(acceptedAt).toLocaleString('ru-RU') : '';
        const accMark = !acceptedByManager ? '' : status === 'review'
            ? ` · <span class="mck" role="img" title="${esc('Проверил ' + nameOf(acceptedByManager) + ' — ждёт вашей оценки')}" aria-label="${esc('Проверил ' + nameOf(acceptedByManager) + ' — ждёт вашей оценки')}">${face(acceptedByManager, 'sm')}<i aria-hidden="true">✓</i></span>`
            : ` · <span class="am" title="${esc('Принял менеджер ' + nameOf(acceptedByManager) + accWhen + '. Ваше решение главнее: комментарий вернёт задачу в работу.')}"><span class="fc">${face(acceptedByManager, 'sm')}</span>принял ${esc(nameOf(acceptedByManager))}</span>`;
        // Head line (face + name + short title): the app popup moves it into its own header (<template data-popup-head>,
        // ui/$script_popup.js) and hides the inline copy; outside the popup (canvas) the inline copy is the title.
        const headLine = `<span class="tv-head">${ownerHead}<span class="tv-tt" title="${esc(title)}">${esc(shortTitle)}</span></span>`;
        const headStyle = '<style>.tv-head{display:flex;align-items:center;gap:6px;min-width:0}.tv-head .tv-ow{flex:none;display:inline-flex;align-items:center;gap:6px;color:var(--w-ink,inherit)}.tv-head .tv-ow>.w-chat-icon{display:inline-flex;align-self:center}.tv-head .tv-ow b{font-weight:600;line-height:1}.tv-head .tv-pf{cursor:pointer;border-radius:999px;padding:1px 6px 1px 1px}.tv-head .tv-pf:hover{background:var(--w-surface-hover,rgb(0 0 0 / .06))}.tv-head .tv-tt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--w-ink,inherit)}.tv-head .tv-mu{color:var(--w-ink-faint,inherit)}#app-popup-body .tview .hd .tv-head{display:none}</style>';
        const meta = [st + accMark, role ? esc(role) : '', ownerId ? `<code>${esc(ownerId)}</code>` : ''].filter(Boolean).join(' · ');
        const header = `<template data-popup-head>${headStyle}${headLine}</template>${headStyle}<header class="hd"><div class="tt">${headLine}<p class="dl">${meta}</p></div></header>`;
    
        // ---- report
        const listOf = (items: unknown[], render: (x: any) => string) => items.length ? `<ul class="wx-stack wx-gap-s1">${items.map(x => `<li>${render(x)}</li>`).join('')}</ul>` : '';
        const isPath = (s: string) => /^(\/|~\/|\.\.?\/)/.test(s) || /^[\w.-]+\/[\w./$-]+\.\w+$/.test(s);
        const shortPath = (p: string) => { const i = p.lastIndexOf('/src/'); return i >= 0 ? p.slice(i + 1) : p.startsWith('/') ? p.split('/').slice(-2).join('/') : p; };
        const fileRow = (raw0: string) => {
            const m = /^(\S+)(\s+\(.*\))?$/.exec(raw0.trim()); const f = String(m?.[1] ?? raw0); const note0 = m?.[2]?.trim() ?? '';
            const tail = note0 ? ' ' + box(esc(note0), { ink: 'muted', text: 'small' }) : '';
            if (isPath(f)) { const href = (/href="([^"]*)"/.exec(w.fileRef({ path: f }))?.[1]) ?? ''; return `<a href="${href}" title="${esc(f)}" class="wx-mono wx-text-small">${esc(shortPath(f))}</a>${tail}`; }
            return /^https?:\/\//.test(f) ? `<a href="${esc(f)}" target="_blank" rel="noopener">${esc(f)}</a>${tail}` : esc(raw0);
        };
        const shortText = (t: string) => t.replace(/(\/[\w.$~-]+){3,}/g, x => shortPath(x));
        const section = (t: string, _icon: string, body: string, tn?: types.w.Tone) => body ? `<section class="sc${tn === 'warning' ? ' wn' : ''}"><h3>${esc(t)}</h3>${body}</section>` : '';
        const fold = (t: string, body: string) => body ? `<details class="fd"><summary>${esc(t)}</summary><div class="fb">${body}</div></details>` : '';
        // checks: report.checks + any of checked / verified / validate / tests in the raw result
        const flat = (v: unknown, pre = ''): string[] => v == null || v === '' ? [] : Array.isArray(v) ? v.flatMap(x => flat(x, pre)) : typeof v === 'object' ? Object.entries(v as Row).flatMap(([k, x]) => typeof x === 'object' && x ? flat(x, pre + k + ': ') : [pre + k + ': ' + String(x)]) : [pre + String(v)];
        const src: Row = { ...(raw ?? {}), ...((raw?.report && typeof raw.report === 'object') ? raw.report : {}) };
        // two layers: "Что сделано" (short, open) and "Подробный отчёт" (folded)
        const splitDash = (t: string) => { const m = /^[ \t]*---[ \t]*$/m.exec(t); return m ? [t.slice(0, m.index).trim(), t.slice(m.index + m[0].length).trim()] : [t.trim(), '']; };
        const warnLine = (body: string) => `<p class="ck wn"><span class="dot">●</span>${body}</p>`;
        const legacyHtml = legacy ? fold('Результат (как есть)', `<pre class="wx-mono wx-text-small wx-pre">${esc(legacy)}</pre>`) : '';
        let doneHtml = ''; let detailHtml = '';
        if (report) {
            const r = report;
            const [shortSum, longSum] = splitDash(String(r.summary ?? ''));
            const checks = [...new Set([...(Array.isArray(r.checks) ? r.checks.map(String) : []), ...['checked', 'verified', 'validate', 'tests'].flatMap(k => flat(src[k]))])];
            const notCovered = flat(r.notCovered ?? src.notCovered);
            const clip = (t: string, n = 90) => t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t;
            const checkedShort = checks.length ? checks.slice(0, 2).map(x => clip(shortText(x))).join('; ') + (checks.length > 2 ? ` (и ещё ${checks.length - 2})` : '') : 'не указано';
            const checkLine = `<b>Проверено:</b> ${esc(checkedShort)}` + (notCovered.length ? `; <b>не проверено:</b> ${esc(clip(shortText(notCovered.join('; ')), 160))}` : '');
            const questions = listOf(r.questions ?? [], x => esc(x));
            // visuals: screenshots, SVG, mermaid, html and markdown/table inline (sanitized); a tile opens large in a native popover; other links as plain buttons
            const vis: Row[] = Array.isArray(r.visuals) ? r.visuals : [];
            // local pictures are inlined as data: (the /files/raw route needs a browser session, so screenshots and other renderers got a broken img); big ones still go through /files/raw
            const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
            let inlineBudget = 4_000_000;
            const localSrc = async (p: string) => {
                if (/^(https?:|data:)/.test(p)) return p;
                const type = mime[(p.split('.').pop() ?? '').toLowerCase()];
                try {
                    const f = Bun.file(ctx.fns.workspace.resolve({ path: p }));
                    if (type && f.size > 0 && f.size <= 1_500_000 && f.size <= inlineBudget) {
                        inlineBudget -= f.size;
                        return `data:${type};base64,${Buffer.from(await f.arrayBuffer()).toString('base64')}`;
                    }
                } catch { /* fall back to the route */ }
                return '/files/raw?path=' + encodeURIComponent(p);
            };
            const isMd = (p: string) => /\.(md|markdown)$/i.test(p);
            // aspect of an inline svg from its viewBox: wide schemes get a full row and horizontal scroll instead of shrinking
            const aspect = (html: string) => { const m = html.match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/); return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 0; };
            const tiles: string[] = []; const links: string[] = [];
            for (const [i, v] of vis.entries()) {
                const cap = String(v.title ?? '');
                const path = v.path ? String(v.path) : '';
                const mdSrc = typeof v.markdown === 'string' ? v.markdown : (v.kind === 'table' || v.kind === 'markdown') && typeof v.source === 'string' ? v.source : '';
                let inner = ''; let mode: 'pic' | 'wide' | 'doc' = 'pic';
                try {
                    if (mdSrc || ((v.kind === 'canvas' || v.kind === 'table' || v.kind === 'markdown') && path && isMd(path))) {
                        const md = mdSrc || String(await ctx.fns.files.read({ path })).slice(0, 60000);
                        inner = `<div class="vm">${await ctx.fns.w.markdown({ source: md, size: 'compact' })}</div>`; mode = 'doc';
                    } else if (v.kind === 'canvas' || (v.kind !== 'image' && !v.svg && !v.source && !v.html && (v.url || path))) {
                        const href = v.url ? String(v.url) : path ? `/rpc/files.page?${encodeURIComponent(JSON.stringify({ path }))}` : '';
                        if (href) links.push(w.button({ label: cap || 'Открыть', icon: 'square-half', size: 'sm', action: { href } }));
                        continue;
                    }
                    else if (v.kind === 'image' && (path || v.url)) inner = `<img src="${esc(await localSrc(path || String(v.url)))}" alt="${esc(cap)}" loading="lazy">`;
                    else if (v.kind === 'svg' && v.svg) inner = ctx.fns.chat.sanitizeSvg({ svg: String(v.svg), maxBytes: 65536 });
                    else if (v.kind === 'svg' && path) inner = `<img src="${esc(await localSrc(path))}" alt="${esc(cap)}" loading="lazy">`;
                    else if (v.kind === 'mermaid' && v.source) inner = ctx.fns.rpc.cleanHtml({ html: await ctx.fns.mermaid.render({ source: String(v.source) }), scope: '#' + root + ' .vz-' + i });
                    else if (v.kind === 'html' && v.html) { inner = `<div class="vh">${ctx.fns.rpc.cleanHtml({ html: String(v.html), scope: '#' + root + ' .vz-' + i })}</div>`; mode = 'doc'; }
                    if (mode === 'pic' && /<svg/i.test(inner) && aspect(inner) > 2.2) mode = 'wide';
                } catch (e) { inner = `<p class="mu">Не удалось показать: ${esc(e instanceof Error ? e.message : String(e))}</p>`; }
                if (!inner) continue;
                const pid = root + '-vz-' + i;
                const zoom = `<button type="button" class="vo" popovertarget="${esc(pid)}" title="Открыть крупно" aria-label="Открыть крупно">⤢</button>`;
                // a picture is one big button; scrolling tiles (tables, html, wide schemes) keep their scroll and get a corner button
                const tile = mode === 'pic'
                    ? `<button type="button" class="vt" popovertarget="${esc(pid)}" title="Открыть крупно">${inner}</button>`
                    : `<div class="vt vs">${inner}</div>${zoom}`;
                tiles.push(`<figure class="vz vz-${i} m-${mode}">${tile}${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}`
                    + `<div popover id="${esc(pid)}" class="lb vz-${i} m-${mode}"><button type="button" class="lx" popovertarget="${esc(pid)}" popovertargetaction="hide" aria-label="Закрыть">×</button><div class="lbb">${inner}</div>${cap ? `<p>${esc(cap)}</p>` : ''}</div></figure>`);
            }
            const visualsHtml = (tiles.length ? `<div class="vg${tiles.length === 1 ? ' one' : ''}">${tiles.join('')}</div>` : '') + (links.length ? `<div class="vl">${links.join('')}</div>` : '');
            // not done + next steps; each next item fires once (team.next)
            const notDone = flat(r.notDone);
            const nextItems: Row[] = Array.isArray(r.next) ? r.next : [];
            const nextLi = nextItems.map((n, i) => {
                const k = n.kind === 'continue' ? 'continue' : 'new';
                const done0 = nextDone.get(i);
                const btn = done0
                    ? w.button({ label: k === 'continue' ? 'пункт отдан доделать' : 'В бэклоге', icon: 'check', size: 'sm', tone: 'ghost', disabled: true, title: new Date(Number(done0.at)).toLocaleString('ru-RU') })
                    : w.form({ form: 'team-task-next', post: '/team/next', target: '#' + root, swap: 'outerHTML', layout: 'row', vals: { ...vals, idx: i },
                        body: csrf + w.button({ label: k === 'continue' ? 'доделать этот пункт' : 'В бэклог', icon: k === 'continue' ? 'arrow-u-up-left' : 'tray-arrow-down', size: 'sm', tone: 'ghost', submit: true, marks: { action: 'team-next', id: String(i) }, title: k === 'continue' ? 'Вернуть задачу в работу с этим пунктом как комментарием' : 'Поставить пункт отдельной задачей в бэклог' }) });
                return `<li class="nx${done0 ? ' used' : ''}"><div class="nt"><span>${esc(String(n.title ?? ''))}</span>${n.why ? `<small>${esc(String(n.why))}</small>` : ''}</div>${btn}</li>`;
            }).join('');
            const notDoneHtml = notDone.length ? `<div class="nd">${caption('Не сделано')}${listOf(notDone, x => esc(shortText(String(x))))}</div>` : '';
            const nextHtml = nextItems.length ? `<div class="nxs">${caption('Дальше')}<ul class="nxl">${nextLi}</ul></div>` : '';
            doneHtml = section('Что сделано', '', box(
                `<div class="lead">${esc(shortSum || '—')}</div>`
                + visualsHtml
                + (notCovered.length || !checks.length ? warnLine(checkLine) : `<p class="ck"><span class="dot ok">●</span>${checkLine}</p>`)
                + (questions ? box(caption('Открытые вопросы') + questions, [{ layout: 'stack', gap: 's1' }]) : '')
                + notDoneHtml + nextHtml,
                { layout: 'stack', gap: 's2' }));
            const checkBody = (checks.length ? listOf(checks, x => esc(shortText(String(x)))) : box('Агент не указал, что проверено.', { ink: 'muted' }))
                + (notCovered.length ? `<div>${warnLine(`<b>Не проверено:</b> ${esc(shortText(notCovered.join('; ')))}`)}</div>` : '');
            const files: string[] = (r.files ?? []).map(String);
            const detail = [
                longSum ? box(esc(longSum), { pre: true, text: 'read' }) : '',
                section('Шаги', 'check-square', listOf(r.done ?? [], x => esc(shortText(String(x))))),
                section('Решения и почему', 'git-branch', listOf(r.decisions ?? [], d => `<b>${esc(d.what)}</b>${d.why ? box('— ' + esc(d.why), { ink: 'muted' }) : ''}`)),
                section('Проверки', 'seal-check', `<div class="wx-text-small">${checkBody}</div>`, notCovered.length || !checks.length ? 'warning' : 'success'),
                files.length ? section(`Файлы (${files.length})`, 'files', listOf(files, (f: string) => fileRow(f))) : '',
                legacyHtml,
            ].join('');
            detailHtml = fold('Подробный отчёт', box(detail, { layout: 'stack', gap: 's2' }));
        } else {
            doneHtml = section('Что сделано', '', box(status === 'done' || status === 'review' ? 'Сдано без отчёта.' : 'Отчёта пока нет: задача не сдана.', { ink: 'muted' }));
            detailHtml = legacy ? fold('Подробный отчёт', legacyHtml) : '';
        }
    
        // continuation links (team.reopen): «продолжение → …» opens the new task, «продолжение задачи …» the old one
        const linkHtml = links.length ? box(links.map(l => {
            const p = { taskId: l.taskId, ...(l.agentId ? { agentId: l.agentId } : {}) };
            const label = (l.agentId ? (who.get(l.agentId)?.name ?? l.agentId) + ' · ' : '') + l.taskId;
            return `<span class="mu">${l.dir === 'to' ? 'продолжение →' : 'продолжение задачи'}</span> <button type="button" class="lk" data-action="team-reopen-link" hx-popup="team.taskPopup" hx-popup-params="${esc(JSON.stringify(p))}">${esc(label)}</button>`;
        }).join('<br>'), { text: 'small' }) : '';
        // ---- task brief
        // human part = text before a line "---"; everything after it is for the agent
        const instr = instructions.trim();
        const cut = /^[ \t]*---[ \t]*$/m.exec(instr);
        const human = cut ? instr.slice(0, cut.index).trim() : instr.length > 200 ? instr.slice(0, 200).replace(/\s+\S*$/, '') + '…' : instr;
        const agentPart = cut ? instr.slice(cut.index + cut[0].length).trim() : instr.length > 200 ? instr : '';
        const brief = section('Задание', '', box(
            `<div class="lead">${esc(human || '—')}</div>`
            + (acceptance ? box(caption('Критерии приёмки') + box(esc(acceptance), { pre: true }), [{ layout: 'stack', gap: 's1' }]) : '')
            + (note ? box(esc(note), { ink: 'muted' }) : '')
            + linkHtml
            + fold(cut ? 'Детали для агента' : 'Задание целиком', agentPart ? box(esc(agentPart), { pre: true, text: 'small' }) : ''),
            { layout: 'stack', gap: 's2' }));
    
        // ---- history
        const kindTone: Record<string, types.w.Tone> = { approve: 'success', done: 'success', result: 'success', changes: 'warning', block: 'danger', feedback: 'warning', preempt: 'danger', rating: 'success', next: 'info', reopen: 'warning' };
        const hist = history.length ? '<ul class="tl">' + history.slice().reverse().map(h => `<li class="${kindTone[h.kind] ? 't-' + kindTone[h.kind] : ''}"><time>${esc(new Date(h.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</time><p><b>${esc(nameOf(h.actor, h.actorKind))}</b> ${h.kind === 'rating' ? `<span class="rt">${esc(h.text.split(' — ')[0])}</span>` : esc(h.kind)}${h.kind === 'rating' ? (h.text.includes(' — ') ? ' — ' + esc(h.text.split(' — ').slice(1).join(' — ')) : '') : ''}${h.kind !== 'rating' && h.text && h.text !== h.kind ? ' — ' + esc(h.text.length > 600 ? h.text.slice(0, 600) + '…' : h.text) : ''}</p></li>`).join('') + '</ul>' : '<p class="mu">Событий пока нет.</p>';
    
        // ---- feedback form
    // one compact decision bar: [★★★★★] [Комментарий… → textarea on focus] [Вернуть в работу] [Принять]; off review: [★] [Комментарий…] [Отправить]
    // review/done: the comment returns the task to work (team.reopen via /team/reopen, comment required); otherwise it is a plain comment to the assignee (/team/feedback)
        const review = status === 'review';
        const returnable = review || status === 'done';
        const fb = w.form({ form: returnable ? 'team-task-reopen' : 'team-task-feedback', post: returnable ? '/team/reopen' : '/team/feedback', target: '#' + root, swap: 'outerHTML', layout: 'row', vals: { taskId, ...(agentId ? { agentId } : {}) },
            body: csrf + w.textarea({ name: 'text', label: 'Комментарий', placeholder: returnable ? 'Что не так и что доделать… (исполнитель продолжит ту же задачу)' : 'Комментарий…', rows: 1, required: true, maxlength: 8000 })
                + (returnable
                    ? w.button({ label: 'Вернуть в работу', icon: 'arrow-u-up-left', size: 'sm', submit: true, marks: { action: 'team-reopen' }, title: 'Исполнитель получит комментарий и продолжит эту же задачу' })
                    : w.button({ label: 'Отправить', icon: 'paper-plane-right', tone: 'primary', size: 'sm', submit: true })) });
        // rating 1–5 stars (team.rate). In review the stars sit inside the «Принять» form: accept + rate in one action
        // (/team/accept rates after accepting). After that a click on a star submits at once (hx-trigger change).
        const cur = rating ? Number(rating.stars) : 0;
        const starInputs = (pfx: string) => [5, 4, 3, 2, 1].map(n => `<input type="radio" name="stars" value="${n}" id="${esc(root)}-${pfx}${n}"${n === cur ? ' checked' : ''}><label for="${esc(root)}-${pfx}${n}" title="Оценить: ${n} из 5">★</label>`).join('');
        const acceptForm = review ? w.form({ form: 'team-task-accept', post: '/team/accept', target: '#' + root, swap: 'outerHTML', layout: 'row', vals: { taskId, ...(agentId ? { agentId } : {}) },
            body: csrf + `<span class="stars" role="radiogroup" aria-label="Оценка (необязательно) — сохранится вместе с «Принять»">${starInputs('sa')}</span>` + w.button({ label: cur ? 'Принять' : 'Принять и оценить', icon: 'check', tone: 'primary', size: 'sm', submit: true }) }) : '';
        const starInputs1 = starInputs('st');
        const rateForm = status === 'done' ? w.form({ form: 'team-task-rate', post: '/team/rate', target: '#' + root, swap: 'outerHTML', layout: 'row', trigger: 'change', vals,
            body: csrf + `<span class="stars" role="radiogroup" aria-label="${cur ? 'Оценка ★' + cur + ' — нажмите, чтобы изменить' : 'Оценка'}">${starInputs1}</span>` }) : '';
        // sticky at the bottom so it stays visible over a long report
        const actions = `${opts.notice ? `<p class="ab-n" role="status">${esc(opts.notice)}</p>` : ''}<div class="team-task-actions ab">${rateForm}${fb}${acceptForm}</div>`;
        const history2 = fold(`История (${history.length})`, hist);
        const main = header + brief + doneHtml + detailHtml + history2 + '<div class="sp"></div>' + actions;
        return `<div id="${esc(root)}" class="team-task-view tview" data-entity="team-task" data-id="${esc(taskId)}" data-status="${esc(status)}">${STYLE}${main}</div>`;
}

// same look as the board (team.dashboard .tdash): --w-* tokens, grey secondary text, one blue accent, thin rules instead of bordered cards
const STYLE = `<style>
.tview{box-sizing:border-box;display:flex;flex-direction:column;min-height:100%;padding:var(--w-s6);background:var(--w-surface-document);color:var(--w-ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:var(--w-text-ui);line-height:var(--w-line-ui)}
.tview .lk{all:unset;cursor:pointer;color:var(--w-accent,#2563eb);text-decoration:underline}.tview .hd{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--w-s6);padding-bottom:var(--w-s4)}
.tview h1{margin:0;font-size:var(--w-text-read);font-weight:600;line-height:var(--w-line-ui)}
.tview .dl{margin:2px 0 0;font-size:var(--w-text-small);line-height:var(--w-line-small);color:var(--w-ink-faint)}
.tview .dl code{font-size:inherit;color:var(--w-ink-faint)}
.tview .mck{position:relative;display:inline-flex;width:18px;height:18px;flex:none;vertical-align:middle}.tview .mck>*{pointer-events:none}.tview .mck>:first-child{width:18px;height:18px;border-radius:999px;overflow:hidden}.tview .mck svg,.tview .mck img{width:18px;height:18px}.tview .mck i{position:absolute;right:-3px;bottom:-3px;width:9px;height:9px;border-radius:999px;background:var(--w-success, #1f9d55);color:#fff;font:700 7px/9px var(--w-font, sans-serif);font-style:normal;text-align:center;box-shadow:0 0 0 1.5px var(--w-surface-document, #fff)}
.tview .am{display:inline-flex;align-items:center;gap:var(--w-s1);color:var(--w-success, var(--w-ink-muted))}.tview .am .fc{display:inline-flex}
.tview .st{color:var(--w-ink-muted)}.tview .st .gl{margin-right:var(--w-s1);color:var(--w-ink-faint)}
.tview .st.s-working .gl,.tview .st.s-active .gl,.tview .st.s-review .gl{color:var(--w-live)}.tview .st.s-review{color:var(--w-ink)}
.tview .st.s-done .gl{color:var(--w-ink-muted)}.tview .st.s-blocked{color:var(--w-danger)}
.tview .ow{flex:none;display:inline-flex;align-items:center;gap:var(--w-s2);color:var(--w-ink-muted)}
.tview .ow b{display:block;font-weight:500;color:var(--w-ink)}.tview .ow small{display:block;font-size:var(--w-text-small);color:var(--w-ink-faint)}
.tview>*{flex:none;min-width:0}.tview>.sp{flex:1 0 0}
.tview .ab{position:sticky;bottom:0;z-index:10;display:flex;align-items:flex-end;gap:var(--w-s3);min-height:52px;box-sizing:border-box;margin:var(--w-s4) calc(-1 * var(--w-s6)) calc(-1 * var(--w-s6));padding:10px var(--w-s6);background:var(--w-surface-document);border-top:var(--w-rule)}
.tview .ab form{margin:0;gap:var(--w-s2);align-items:flex-end;flex:none}
.tview .ab form[data-form="team-task-rate"]{align-self:center}
.tview .ab{flex-wrap:wrap}.tview .ab form[data-form="team-task-feedback"],.tview .ab form[data-form="team-task-reopen"]{flex:1 1 20rem;min-width:0}
.tview .ab textarea{flex:1;min-width:0;height:var(--w-control-sm);min-height:0;max-height:var(--w-height-textarea);padding:3px var(--w-s2);line-height:20px;resize:none;field-sizing:fixed;overflow:hidden}
.tview .ab textarea:focus,.tview .ab textarea:not(:placeholder-shown){height:auto;min-height:calc(4 * 20px + 10px);field-sizing:content;overflow:auto}
.tview .ab-n{margin:var(--w-s4) 0 0;font-size:var(--w-text-small);color:var(--w-danger)}
@container (max-width:30rem){.tview .ab{flex-wrap:wrap}.tview .ab form[data-form="team-task-feedback"],.tview .ab form[data-form="team-task-reopen"]{flex-basis:100%;order:3}}
.tview .sc{padding:var(--w-s4) 0;border-top:var(--w-rule)}
.tview h3{margin:0;padding-bottom:var(--w-s2);font-size:var(--w-text-small);font-weight:500;line-height:var(--w-line-small);text-transform:uppercase;letter-spacing:var(--w-caps-spacing);color:var(--w-ink-faint)}
.tview .sc .sc{padding:var(--w-s2) 0;border-top:0}
.tview .lead{font-size:var(--w-text-read);line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.tview .ck{margin:0;font-size:var(--w-text-small);line-height:var(--w-line-small);color:var(--w-ink-muted)}
.tview .ck b{font-weight:500}.tview .dot{margin-right:var(--w-s1);color:var(--w-ink-faint)}.tview .dot.ok{color:var(--w-live)}
.tview .wn .dot,.tview .wn b,.tview .sc.wn h3{color:var(--w-warning)}
.tview ul{margin:0;padding-left:1.1em;color:var(--w-ink-muted)}.tview li{margin:2px 0}
.tview .fd{border-top:var(--w-rule)}.tview .fd .fd{border-top:0}
.tview .fd>summary{cursor:pointer;padding:var(--w-s3) 0;font-size:var(--w-text-small);color:var(--w-ink-faint);list-style:none}
.tview .fd>summary::before{content:"▸";display:inline-block;width:1em}.tview .fd[open]>summary::before{content:"▾"}
.tview .fd>summary:hover{color:var(--w-ink)}.tview .fb{padding:0 0 var(--w-s3)}
.tview .tl{list-style:none;padding:0}.tview .tl li{padding:var(--w-s2) 0;border-top:var(--w-rule)}.tview .tl li:first-child{border-top:0}
.tview .tl time{display:block;font-size:var(--w-text-small);color:var(--w-ink-faint);font-variant-numeric:tabular-nums}
.tview .tl p{margin:0;color:var(--w-ink-muted);overflow-wrap:anywhere;white-space:pre-wrap}.tview .tl p b{font-weight:500;color:var(--w-ink)}
.tview .tl .t-warning b{color:var(--w-warning)}.tview .tl .t-danger b{color:var(--w-danger)}
.tview .mu{color:var(--w-ink-faint)}.tview a{color:var(--w-link)}
.tview .vg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--w-s3)}.tview .vg.one{grid-template-columns:minmax(0,1fr)}
@container (max-width:40rem){.tview .vg{grid-template-columns:minmax(0,1fr)}}
.tview .vz{position:relative;margin:0;min-width:0}.tview .vz.m-wide,.tview .vz.m-doc{grid-column:1/-1}
.tview .vt{display:block;box-sizing:border-box;width:100%;min-height:260px;padding:var(--w-s2);margin:0;border:1px solid var(--w-border);border-radius:8px;overflow:hidden;background:var(--w-surface-raised,var(--w-surface-document));cursor:zoom-in}
.tview .vt:hover{border-color:var(--w-ink-faint)}
.tview .vt img,.tview .vt svg{display:block;width:100%;height:260px;object-fit:contain}
.tview .vt.vs{cursor:auto;overflow:auto;max-height:26rem}
.tview .m-wide .vt.vs svg{width:auto;max-width:none;height:280px;min-width:100%}
.tview .vo{position:absolute;top:6px;right:6px;width:28px;height:28px;border:1px solid var(--w-border);border-radius:6px;background:var(--w-surface-document);color:var(--w-ink-muted);font-size:16px;line-height:1;cursor:zoom-in}.tview .vo:hover{color:var(--w-ink);border-color:var(--w-ink-faint)}
.tview .vz figcaption{margin-top:var(--w-s1);font-size:var(--w-text-small);color:var(--w-ink-faint)}
.tview .vm table,.tview .vh table{border-collapse:collapse;width:max-content;max-width:none;font-size:var(--w-text-small);line-height:1.4}
.tview .vm th,.tview .vm td,.tview .vh th,.tview .vh td{padding:6px 10px;border-bottom:var(--w-rule);text-align:left;vertical-align:top;max-width:22rem}
.tview .vm th,.tview .vh th{font-weight:600;color:var(--w-ink-muted);border-bottom:1px solid var(--w-border);background:var(--w-surface-document);position:sticky;top:0}
.tview .lb{box-sizing:border-box;width:96vw;max-width:none;height:94vh;max-height:94vh;padding:var(--w-s4);border:1px solid var(--w-border);border-radius:10px;background:var(--w-surface-document);overflow:auto}
.tview .lb::backdrop{background:rgb(0 0 0 / .55)}
.tview .lb .lbb img,.tview .lb .lbb svg{display:block;width:100%;height:calc(94vh - 6rem);object-fit:contain}
.tview .lb.m-wide .lbb{overflow-x:auto}.tview .lb.m-wide .lbb svg{width:max(100%,1500px);max-width:none;height:auto;max-height:none}
.tview .lb.m-doc .lbb table{font-size:var(--w-text-ui)}.tview .lb.m-doc .lbb th,.tview .lb.m-doc .lbb td{max-width:32rem}
.tview .lb p{margin:var(--w-s2) 0 0;font-size:var(--w-text-small);color:var(--w-ink-muted)}.tview .lx{position:sticky;top:0;float:right;z-index:2;border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:var(--w-ink-muted)}
.tview .vl{display:flex;flex-wrap:wrap;gap:var(--w-s2)}
.tview .nd ul{color:var(--w-ink-faint)}.tview .nxl{list-style:none;padding:0}
.tview .nx{display:flex;align-items:center;justify-content:space-between;gap:var(--w-s3);padding:var(--w-s2) 0;border-top:var(--w-rule)}.tview .nx:first-child{border-top:0}
.tview .nx .nt span{color:var(--w-ink)}.tview .nx .nt small{display:block;font-size:var(--w-text-small);color:var(--w-ink-faint)}.tview .nx.used .nt span{color:var(--w-ink-muted)}
.tview .stars{display:inline-flex;flex-direction:row-reverse}.tview .stars input{position:absolute;opacity:0;width:1px;height:1px}
.tview .stars label{cursor:pointer;font-size:20px;line-height:1;padding:0 1px;color:var(--w-border)}
.tview .stars input:checked~label,.tview .stars label:hover,.tview .stars label:hover~label{color:var(--w-warning)}
.tview .stars input:focus-visible+label{outline:2px solid var(--w-link);border-radius:3px}
.tview .rt{color:var(--w-warning);font-variant-numeric:tabular-nums}
</style>`;

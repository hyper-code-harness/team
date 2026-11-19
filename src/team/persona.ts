/**
 * Renders a persona's page: face, card, live session, editable prompt and notes, revision history with rollback, recent tasks with stars
 *
 * Read-only @view page of one persistent persona (team.persona, via team.personaGet). Top to bottom: face, name, role, responsibilities, plugins, model and teams; the current session with its run state and earlier sessions; a form with the prompt textarea; the memory — the persona's memos (team.persona_memo: path, title, description, version, size; text folded open) and «Сохранить» posting to /team/persona (owner only, CSRF; writes revisions author=user through team.personaSave); the revision history of prompt, card and every memo — who (persona or owner), when, which memo, a short line diff and «Откатить к этой» posting to /team/persona with revertOf; the last 20 tasks of all the persona's sessions (status, summary, ★) and the average owner rating. Opened in the app popup by the board's faces (/rpc/team.persona?{"name":"…"}).
 * @view
 * @live team
 * @param opts.name Persona name, e.g. "Катя".
 * @param opts.notice Quiet line shown under the form (result of the last save or rollback).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persona name, e.g. "Катя". */
        name: string;
        /** Quiet line shown under the form (result of the last save or rollback). */
        notice?: string;
    },
): Promise<string> {
    type Row = Record<string, any>;
    const w = ctx.fns.w;
    const esc = (v: unknown) => w.escape({ text: v === null || v === undefined ? '' : String(v) });
    const name = String(opts.name ?? '').trim();
    if (!name) return w.empty({ title: 'Нет имени', icon: 'question', hint: 'name is required.' });
    const p = await ctx.fns.team.personaGet({ name, revisions: 30 });
    if (!p) return w.empty({ title: 'Персона не найдена', icon: 'magnifying-glass', hint: name });
    const json = (v: unknown): Row => { if (!v) return {}; if (typeof v === 'object') return v as Row; try { return JSON.parse(String(v)); } catch { return {}; } };
    const when = (ts: number) => new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const isOwner = !!session?.user?.id && String(session.user.id) === p.ownerUserId;
    const req = (session as any)?.req as Request | undefined;
    const csrf = req && isOwner ? await ctx.fns.auth.csrfField({ req }) : '';
    const root = 'team-persona-' + name.replace(/[^\p{L}\p{N}_-]/gu, '_');

    // ---- sessions: current + past
    const ids = [...new Set([p.currentAgentId, ...p.sessions.map(s => s.agentId)].filter((x): x is string => !!x))];
    const ag = new Map<string, Row>();
    if (ids.length) for (const r of await ctx.fns.procs.db.select({ sql: 'SELECT id, title, icon, model, run_state, archived_at, scratchpad FROM agents WHERE id = ANY(?::text[])', params: [ids] }) as Row[]) ag.set(String(r.id), r);
    const cur = p.currentAgentId ? ag.get(p.currentAgentId) : undefined;
    const face = (size: 'sm' | 'md' | 'lg') => w.chatIcon({ icon: p.icon ?? cur?.icon ?? null, model: p.model ?? cur?.model ?? null, size, active: cur?.run_state === 'running' });
    const runLabel: Record<string, string> = { running: 'работает', idle: 'ждёт', waiting: 'ждёт', error: 'ошибка', stopped: 'остановлена' };
    const sessLine = (id: string) => { const a = ag.get(id); const st = a?.archived_at ? 'в архиве' : (runLabel[String(a?.run_state ?? '')] ?? String(a?.run_state ?? 'нет данных')); return `<a href="/agent/${esc(id)}" target="_blank"><code>${esc(id)}</code></a> <span class="mu">${esc(st)}</span>`; };

    // ---- tasks: team tasks assigned to any session + plan tasks of the sessions
    type T = { id: string; agentId: string; title: string; status: string; summary: string; at: number; stars: number | null };
    const tasks: T[] = [];
    const ratings = new Map<string, number>();
    if (ids.length) {
        try { for (const r of await ctx.fns.procs.db.select({ sql: 'SELECT agent_id, task_id, assignee_agent_id, stars FROM team.rating WHERE assignee_agent_id = ANY(?::text[]) OR agent_id = ANY(?::text[])', params: [ids, ids] }) as Row[]) ratings.set(String(r.agent_id ?? r.assignee_agent_id) + '/' + String(r.task_id), Number(r.stars)); } catch (e) { if (!/does not exist/.test(String(e))) throw e; }
        for (const r of await ctx.fns.procs.db.select({ sql: 'SELECT id, title, status, assignee_agent_id, progress_at, estimated_at FROM team.task WHERE assignee_agent_id = ANY(?::text[]) ORDER BY COALESCE(progress_at, estimated_at, 0) DESC LIMIT 40', params: [ids] }) as Row[])
            tasks.push({ id: String(r.id), agentId: String(r.assignee_agent_id), title: String(r.title), status: String(r.status), summary: '', at: Number(r.progress_at ?? r.estimated_at ?? 0), stars: ratings.get(String(r.assignee_agent_id) + '/' + String(r.id)) ?? null });
        for (const id of ids) {
            const a = ag.get(id); if (!a) continue;
            const plan = json(a.scratchpad).plan; const list: Row[] = Array.isArray(plan?.tasks) ? plan.tasks : [];
            for (const t of list) {
                const rep = json(t.report); const sum = String(rep.summary ?? (typeof t.result === 'string' ? t.result : json(t.result).summary ?? '')).split(/\n-{3,}\n/)[0] ?? '';
                tasks.push({ id: String(t.id), agentId: id, title: String(t.title ?? t.id), status: String(t.status ?? 'pending'), summary: sum, at: Number(t.doneAt ?? t.updatedAt ?? p.sessions.find(s => s.agentId === id)?.startedAt ?? 0), stars: ratings.get(id + '/' + String(t.id)) ?? null });
            }
        }
    }
    tasks.sort((a, b) => b.at - a.at);
    const last = tasks.slice(0, 20);
    let avg = 0, cnt = 0;
    for (const id of ids) { const r = (await ctx.fns.team.ratings({ agentId: id, recent: 0 })).agents[0]; if (r) { avg += r.avg * r.count; cnt += r.count; } }
    const avgTxt = cnt ? `★ ${(Math.round(avg / cnt * 10) / 10).toFixed(1)} <span class="mu">· ${cnt} ${cnt === 1 ? 'оценка' : cnt < 5 ? 'оценки' : 'оценок'}</span>` : '<span class="mu">оценок пока нет</span>';

    // ---- header card
    const chips = (xs: string[]) => xs.length ? xs.map(x => `<span class="ch">${esc(x)}</span>`).join('') : '<span class="mu">—</span>';
    const header = `<header class="hd"><span class="fc">${face('lg')}</span><div class="tt"><h1>${esc(p.name)}</h1><p class="dl">${esc(p.role || 'без роли')} · ${avgTxt}</p></div></header>`;
    const dl = `<dl class="kv">
<dt>Ответственность</dt><dd>${p.responsibilities ? esc(p.responsibilities) : '<span class="mu">—</span>'}</dd>
<dt>Плагины</dt><dd>${chips(p.plugins)}</dd>
<dt>Модель</dt><dd>${p.model ? `<code>${esc(p.model)}</code>` : '<span class="mu">по умолчанию</span>'}</dd>
<dt>Команды</dt><dd>${chips(p.teams)}</dd>
<dt>Сессия</dt><dd>${p.currentAgentId ? sessLine(p.currentAgentId) : '<span class="mu">нет живой сессии</span>'}</dd>
${p.sessions.filter(s => s.agentId !== p.currentAgentId).length ? `<dt>Раньше</dt><dd>${p.sessions.filter(s => s.agentId !== p.currentAgentId).slice(0, 5).map(s => `<span class="ps">${sessLine(s.agentId)} <span class="mu">${esc(when(s.startedAt))}${s.endedAt ? '–' + esc(when(s.endedAt)) : ''}</span></span>`).join('')}</dd>` : ''}
<dt>Версия</dt><dd>v${esc(p.version)} <span class="mu">· изменена ${esc(when(p.updatedAt))}</span></dd>
</dl>`;

    // ---- prompt + notes form
    const ta = (field: 'prompt' | 'notes', label: string, rows: number) => w.field({ name: field, label, for: root + '-' + field,
        control: w.textarea({ name: field, id: root + '-' + field, value: field === 'prompt' ? p.prompt : p.notes, rows, maxlength: 64000, placeholder: field === 'prompt' ? 'Кто эта персона и как она работает' : 'Что персона запомнила о работе' }) });
    const form = isOwner
        ? w.form({ form: 'team-persona-save', post: '/team/persona', target: '#' + root, swap: 'outerHTML', layout: 'stack', vals: { name: p.name, baseVersion: p.version },
            body: csrf + ta('prompt', 'Промпт', 8)
                + w.input({ name: 'reason', label: 'Причина правки', placeholder: 'Причина правки (необязательно)', maxlength: 500 })
                + `<div class="row">${w.button({ label: 'Сохранить', icon: 'floppy-disk', tone: 'primary', submit: true })}${opts.notice ? `<span class="nt">${esc(opts.notice)}</span>` : ''}</div>` })
        : `<pre class="tx">${esc(p.prompt) || '<span class="mu">пусто</span>'}</pre><p class="mu">Править может только владелец.</p>`;

    // ---- memos (persona memory): one per topic, newest edits on top of each list item via history
    const memoList = p.memos.length ? '<ul class="mm">' + p.memos.map(m => `<li><details><summary><code>${esc(m.path)}</code> <b>${esc(m.title)}</b>${m.description ? ` <span class="mu">— ${esc(m.description)}</span>` : ''} <span class="mu">· v${esc(m.version)} · ${esc(m.content.length)} симв. · ${esc(when(m.updatedAt))}</span></summary><pre class="tx">${esc(m.content)}</pre></details></li>`).join('') + '</ul>' : '<p class="mu">Мемо пока нет — персона заводит их сама при сдаче задач (team.memoSave).</p>';

    // ---- revisions with short line diff
    const diff = (a: string, b: string) => {
        const A = a.split('\n'), B = b.split('\n'); const sa = new Set(A), sb = new Set(B);
        const out = [...A.filter(l => l.trim() && !sb.has(l)).map(l => `<del>− ${esc(l.length > 140 ? l.slice(0, 140) + '…' : l)}</del>`), ...B.filter(l => l.trim() && !sa.has(l)).map(l => `<ins>+ ${esc(l.length > 140 ? l.slice(0, 140) + '…' : l)}</ins>`)];
        return out.length ? out.slice(0, 6).join('') + (out.length > 6 ? `<span class="mu">… ещё ${out.length - 6}</span>` : '') : '<span class="mu">без изменений текста</span>';
    };
    const fieldLabel: Record<string, string> = { prompt: 'промпт', notes: 'заметки', card: 'карточка', memo: 'мемо' };
    const rkey = (r: { field: string; path: string | null }) => r.field + ':' + (r.path ?? '');
    const latest = new Set<string>(); const seen = new Set<string>();
    for (const r of p.revisions) if (!seen.has(rkey(r))) { seen.add(rkey(r)); latest.add(r.id); }
    const revs = p.revisions.length ? '<ul class="rv">' + p.revisions.map(r => {
        const who = r.authorKind === 'user' ? 'владелец' : 'персона' + (r.authorId ? ` <code>${esc(r.authorId)}</code>` : '');
        const undo = isOwner && r.field !== 'card' && !latest.has(r.id) && !(r.field === 'memo' && !r.after) ? w.form({ form: 'team-persona-revert', post: '/team/persona', target: '#' + root, swap: 'outerHTML', layout: 'row', vals: { name: p.name, revertOf: r.id, baseVersion: p.version }, confirm: 'Вернуть ' + (r.field === 'memo' ? 'мемо ' + (r.path ?? '') : fieldLabel[r.field] ?? r.field) + ' к этой версии?',
            body: csrf + w.button({ label: 'Откатить к этой', icon: 'arrow-counter-clockwise', size: 'sm', submit: true, marks: { action: 'team-persona-revert', id: r.id } }) }) : '';
        return `<li><div class="rh"><time>${esc(when(r.at))}</time><b>${who}</b> <span class="mu">${esc(fieldLabel[r.field] ?? r.field)}${r.path ? ' <code>' + esc(r.path) + '</code>' : ''}${r.revertOf ? ' · откат' : ''}</span>${r.summary ? ' — ' + esc(r.summary) : ''}${undo}</div><div class="df">${r.field === 'card' ? (r.summary ? '' : '<span class="mu">карточка изменена</span>') : diff(r.before, r.after)}</div></li>`;
    }).join('') + '</ul>' : '<p class="mu">Правок пока не было.</p>';

    // ---- tasks
    const label: Record<string, string> = { todo: 'в бэклоге', pending: 'ждёт', assigned: 'назначена', working: 'в работе', active: 'в работе', in_progress: 'в работе', blocked: 'заблокирована', paused: 'на паузе', review: 'на ревью', done: 'готово', cancelled: 'отменена' };
    const tl = last.length ? '<ul class="tk">' + last.map(t => `<li><span class="st s-${esc(t.status)}">${esc(label[t.status] ?? t.status)}</span><span class="tn"><b>${esc(t.title)}</b>${t.summary ? `<small>${esc(t.summary.length > 200 ? t.summary.slice(0, 200) + '…' : t.summary)}</small>` : ''}</span><span class="sr">${t.stars ? '★' + t.stars : ''}</span></li>`).join('') + '</ul>' : '<p class="mu">Задач пока нет.</p>';

    const body = header + dl + `<section><h3>Промпт</h3>${form}</section><section><h3>Память <span class="mu">${p.memos.length} мемо</span></h3>${memoList}</section><section><h3>История правок</h3>${revs}</section><section><h3>Задачи <span class="mu">${last.length}${tasks.length > 20 ? ' из ' + tasks.length : ''}</span></h3>${tl}</section>`;
    return `<div id="${esc(root)}" class="team-persona pview" data-entity="team-persona" data-id="${esc(p.name)}">${STYLE}${body}</div>`;
}

// same look as the board and task card: --w-* tokens, grey secondary text, thin rules
const STYLE = `<style>
.pview{box-sizing:border-box;padding:var(--w-s6);background:var(--w-surface-document);color:var(--w-ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:var(--w-text-ui);line-height:var(--w-line-ui)}
.pview .hd{display:flex;align-items:center;gap:var(--w-s4);padding-bottom:var(--w-s4);border-bottom:var(--w-rule)}
.pview h1{margin:0;font-size:var(--w-text-read);font-weight:600;line-height:var(--w-line-ui)}
.pview .dl{margin:2px 0 0;font-size:var(--w-text-small);line-height:var(--w-line-small);color:var(--w-ink-muted)}
.pview .mu{color:var(--w-ink-faint)}
.pview code{font-size:var(--w-text-small);color:var(--w-ink-muted)}
.pview a{color:inherit;text-decoration:none}.pview a:hover code{color:var(--w-ink)}
.pview .kv{display:grid;grid-template-columns:max-content 1fr;gap:var(--w-s2) var(--w-s6);margin:var(--w-s4) 0 0}
.pview .kv dt{color:var(--w-ink-faint);font-size:var(--w-text-small)}.pview .kv dd{margin:0;display:flex;flex-wrap:wrap;gap:var(--w-s1) var(--w-s2)}
.pview .ch{padding:0 var(--w-s2);border:var(--w-rule);border-radius:999px;font-size:var(--w-text-small);color:var(--w-ink-muted)}
.pview .ps{display:block;width:100%}
.pview section{margin-top:var(--w-s6);padding-top:var(--w-s4);border-top:var(--w-rule)}
.pview h3{margin:0 0 var(--w-s2);font-size:var(--w-text-small);font-weight:500;line-height:var(--w-line-small);text-transform:uppercase;letter-spacing:var(--w-caps-spacing);color:var(--w-ink-faint)}
.pview h3 .mu{margin-left:var(--w-s1)}
.pview .row{display:flex;align-items:center;gap:var(--w-s3)}.pview .nt{font-size:var(--w-text-small);color:var(--w-ink-muted)}
.pview .tx{margin:0 0 var(--w-s4);white-space:pre-wrap;font:inherit;color:var(--w-ink-muted)}
.pview ul{list-style:none;margin:0;padding:0}
.pview .mm li{padding:var(--w-s2) 0;border-bottom:var(--w-rule)}.pview .mm summary{cursor:pointer}.pview .mm summary b{font-weight:500}.pview .mm .tx{margin:var(--w-s2) 0 0}
.pview .rv li{padding:var(--w-s2) 0;border-bottom:var(--w-rule)}
.pview .rh{display:flex;flex-wrap:wrap;align-items:center;gap:var(--w-s2)}.pview .rh b{font-weight:500}
.pview .rh time{color:var(--w-ink-faint);font-size:var(--w-text-small);font-variant-numeric:tabular-nums}
.pview .rh form{margin:0 0 0 auto}
.pview .df{display:flex;flex-direction:column;margin-top:var(--w-s1);font-size:var(--w-text-small);line-height:var(--w-line-small);font-family:ui-monospace,monospace}
.pview .df del{text-decoration:none;color:var(--w-danger)}.pview .df ins{text-decoration:none;color:var(--w-success)}
.pview .tk li{display:flex;align-items:baseline;gap:var(--w-s3);padding:var(--w-s2) 0;border-bottom:var(--w-rule)}
.pview .tk .st{flex:none;width:7rem;font-size:var(--w-text-small);color:var(--w-ink-faint)}
.pview .tk .st.s-working,.pview .tk .st.s-in_progress,.pview .tk .st.s-review{color:var(--w-live)}.pview .tk .st.s-blocked{color:var(--w-danger)}
.pview .tk .tn{flex:1;min-width:0}.pview .tk .tn b{font-weight:500}
.pview .tk small{display:block;font-size:var(--w-text-small);line-height:var(--w-line-small);color:var(--w-ink-faint)}
.pview .tk .sr{flex:none;color:var(--w-ink-muted);font-variant-numeric:tabular-nums}
</style>`;

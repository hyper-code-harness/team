/**
 * Lists persistent personas with links to their pages and a «Новая персона» form
 *
 * Read-only @view of team.persona: each row shows face, name, role, live session state, version and teams, and opens team.persona in the app popup. For the owner a «Новая персона» form below: name, role, responsibilities, plugins (multi-select from plugins.list), model, starting prompt, face (pick one of the existing agent icons) and optionally a team to hire into; it posts to /team/personas (CSRF), which creates the persona through team.personaCreate and hires it with team.hire.
 * @view
 * @live team
 * @param opts.notice Quiet line shown under the form (result of the last create).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Quiet line shown under the form (result of the last create). */
        notice?: string;
        /** Narrow the list to what this project sees: system personas plus its own project personas. Default: all. */
        projectId?: string;
    },
): Promise<string> {
    type Row = Record<string, any>;
    const w = ctx.fns.w;
    const esc = (v: unknown) => w.escape({ text: v === null || v === undefined ? '' : String(v) });
    const userId = session?.user?.id ? String(session.user.id) : '';
    const hasScope = ((await ctx.fns.procs.db.select({ sql: `SELECT 1 FROM information_schema.columns WHERE table_schema='team' AND table_name='persona' AND column_name='scope'`, params: [] })) as Row[]).length > 0;
    const projects = await ctx.fns.procs.db.select({ sql: `SELECT id, title FROM projects ORDER BY title`, params: [] }) as Row[];
    const ptitle = new Map(projects.map(p => [String(p.id), String(p.title)]));
    const rows = await ctx.fns.procs.db.select({ sql: `SELECT ${hasScope ? 'p.scope, p.project_id, p.display_name,' : `'system' AS scope, NULL AS project_id, p.name AS display_name,`} p.name, p.role, p.icon, p.model, p.version, p.current_agent_id, p.owner_user_id, a.run_state, a.archived_at, a.icon AS a_icon,
        (SELECT string_agg(t.title, ', ' ORDER BY tp.joined_at) FROM team.team_persona tp JOIN team.team t ON t.id = tp.team_id WHERE tp.persona_name = p.name AND tp.active) AS teams
        FROM team.persona p LEFT JOIN agents a ON a.id = p.current_agent_id${hasScope && opts.projectId ? ` WHERE p.scope = 'system' OR p.project_id = ?` : ''} ORDER BY p.created_at`, params: hasScope && opts.projectId ? [opts.projectId] : [] }) as Row[];
    const run: Record<string, string> = { running: 'работает', idle: 'ждёт', waiting: 'ждёт', error: 'ошибка', stopped: 'остановлена' };
    const link = (name: string, inner: string) => `<a href="/rpc/team.persona?${esc(encodeURIComponent(JSON.stringify({ name })))}" hx-popup="/rpc/team.persona?${esc(JSON.stringify({ name }))}" data-popup-title="${esc(name)}">${inner}</a>`;
    const scopeBadge = (r: Row) => r.scope === 'project' ? `<span class="sc pj" title="Проектная: ${esc(ptitle.get(String(r.project_id)) ?? r.project_id)}">${esc(ptitle.get(String(r.project_id)) ?? r.project_id)}</span>` : '<span class="sc" title="Системная: видна во всех проектах">system</span>';
    // ---- filter: pure CSS (radio + :has), no script; a project shows its own and the system personas
    const used = [...new Set(rows.filter(r => r.scope === 'project').map(r => String(r.project_id)))];
    const pre = '';
    const fopt = (v: string, label: string) => `<label><input type="radio" name="psf" value="${esc(v)}" id="psf-${esc(v || 'all')}"${pre === v ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    const filter = hasScope && rows.length ? `<div class="pf" role="radiogroup" aria-label="Фильтр по уровню">${fopt('', 'Все')}${fopt('system', 'Системные')}${used.map(id => fopt(id, ptitle.get(id) ?? id)).join('')}</div>` : '';
    const fcss = hasScope ? `<style>.psview:has(#psf-system:checked) .pl li:not([data-scope="system"]){display:none}${used.map(id => { const k = String(id).replace(/[^\w-]/g, ''); return `.psview:has(#psf-${k}:checked) .pl li:not([data-scope="system"]):not([data-scope="p-${k}"]){display:none}`; }).join('')}</style>` : '';
    const list = rows.length ? '<ul class="pl">' + rows.map(r => {
        const st = !r.current_agent_id ? 'нет сессии' : r.archived_at ? 'сессия в архиве' : (run[String(r.run_state ?? '')] ?? String(r.run_state ?? ''));
        return `<li data-entity="team-persona" data-id="${esc(r.name)}" data-scope="${esc(r.scope === 'project' ? 'p-' + r.project_id : 'system')}">${link(String(r.name), `<span class="fc">${w.chatIcon({ icon: r.icon ?? r.a_icon ?? null, model: r.model ?? null, size: 'md', active: r.run_state === 'running' && !r.archived_at })}</span><span class="nm"><b>${esc(r.display_name ?? r.name)}${scopeBadge(r)}</b><small>${esc(r.role || 'без роли')}${r.teams ? ' · ' + esc(r.teams) : ''}</small></span>`)}<span class="mu">${esc(st)} · v${esc(r.version)}</span></li>`;
    }).join('') + '</ul>' : w.empty({ title: 'Персон пока нет', icon: 'users', hint: 'Создайте первую в форме ниже.' });

    // ---- «Новая персона» (owner = any signed-in person; personaCreate checks it)
    let form = '<p class="mu">Войдите, чтобы создать персону.</p>';
    const req = (session as any)?.req as Request | undefined;
    if (userId) {
        const csrf = req ? await ctx.fns.auth.csrfField({ req }) : '';
        const plugins = (await ctx.fns.plugins.list({}) as Row[]).map(p => String(p.name)).sort();
        const icons = await ctx.fns.procs.db.select({ sql: `SELECT DISTINCT ON (icon) id, title, icon FROM agents WHERE icon IS NOT NULL AND icon <> '' AND length(icon) < 20000 ORDER BY icon, id DESC LIMIT 60`, params: [] }) as Row[];
        const teams = (await ctx.fns.team.list({})).filter(t => t.status === 'active');
        const fid = (n: string) => 'team-personas-' + n;
        const lastProj = ((await ctx.fns.procs.db.select({ sql: `SELECT project_id FROM agents WHERE created_by = ? AND project_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, params: [userId] })) as Row[])[0]?.project_id;
        const defProject = String(opts.projectId && ptitle.has(opts.projectId) ? opts.projectId : lastProj ?? projects[0]?.id ?? '');
        const faces = `<div class="ic" role="radiogroup" aria-label="Лицо"><label title="С последней сессии этого имени"><input type="radio" name="iconFrom" value="" checked><span class="no">авто</span></label>${icons.map(i => `<label title="${esc(i.title ?? i.id)}"><input type="radio" name="iconFrom" value="${esc(i.id)}">${w.chatIcon({ icon: String(i.icon), size: 'md' })}</label>`).join('')}</div>`;
        const plug = `<select name="plugins" id="${fid('plugins')}" multiple size="6" class="ms">${plugins.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}</select>`;
        form = w.form({ form: 'team-persona-create', post: '/team/personas', target: '#team-personas', swap: 'outerHTML', layout: 'stack',
            body: csrf
                + `<div class="g2">${w.field({ name: 'name', label: 'Имя', for: fid('name'), required: true, control: w.input({ name: 'name', id: fid('name'), required: true, maxlength: 40, placeholder: 'Ян' }) })}`
                + `${w.field({ name: 'role', label: 'Роль', for: fid('role'), required: true, control: w.input({ name: 'role', id: fid('role'), required: true, maxlength: 80, placeholder: 'ядро, фронт, ресерч…' }) })}</div>`
                + (hasScope ? `<div class="g2"><div class="fl"><span class="lb">Уровень</span><div class="lv" role="radiogroup" aria-label="Уровень"><label><input type="radio" name="scope" value="project" checked> Проектная</label><label><input type="radio" name="scope" value="system"> Системная</label></div><small class="mu">Системная видна во всех проектах</small></div>`
                    + w.field({ name: 'projectId', label: 'Проект', for: fid('project'), control: w.select({ name: 'projectId', id: fid('project'), width: 'fill', options: projects.map(p => ({ value: String(p.id), label: String(p.title) })), value: defProject }) }) + `</div>` : '')
                + w.field({ name: 'responsibilities', label: 'Ответственность', for: fid('resp'), control: w.textarea({ name: 'responsibilities', id: fid('resp'), rows: 2, maxlength: 2000, placeholder: 'За что отвечает' }) })
                + `<div class="g2">${w.field({ name: 'plugins', label: 'Плагины', for: fid('plugins'), note: '⌘/Ctrl — несколько', control: plug })}`
                + `<div>${w.field({ name: 'model', label: 'Модель', for: fid('model'), control: w.input({ name: 'model', id: fid('model'), maxlength: 120, placeholder: 'по умолчанию', mono: true }) })}`
                + (teams.length ? w.field({ name: 'teamId', label: 'Нанять в команду', for: fid('team'), control: w.select({ name: 'teamId', id: fid('team'), width: 'fill', options: [{ value: '', label: '— не нанимать —' }, ...teams.map(t => ({ value: t.id, label: t.title }))] }) }) : '')
                + `</div></div>`
                + w.field({ name: 'prompt', label: 'Начальный промпт', for: fid('prompt'), control: w.textarea({ name: 'prompt', id: fid('prompt'), rows: 4, maxlength: 4000, placeholder: 'Как персона работает' }) })
                + `<div class="fl"><span class="lb">Лицо</span>${faces}</div>`
                + `<div class="row">${w.button({ label: 'Создать персону', icon: 'user-plus', tone: 'primary', submit: true })}${opts.notice ? `<span class="nt">${esc(opts.notice)}</span>` : ''}</div>` });
    }
    return `<div id="team-personas" class="team-personas psview">${STYLE}<header class="hd"><h1>Персоны</h1><p class="dl">${rows.length} · постоянные участники команд</p></header>${fcss}${filter}${list}<section><h3>Новая персона</h3>${form}</section></div>`;
}

const STYLE = `<style>
.psview{box-sizing:border-box;padding:var(--w-s6);background:var(--w-surface-document);color:var(--w-ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:var(--w-text-ui);line-height:var(--w-line-ui)}
.psview .hd{padding-bottom:var(--w-s4);border-bottom:var(--w-rule)}
.psview h1{margin:0;font-size:var(--w-text-read);font-weight:600;line-height:var(--w-line-ui)}
.psview .dl,.psview .mu{margin:0;font-size:var(--w-text-small);color:var(--w-ink-faint)}
.psview ul{list-style:none;margin:0;padding:0}
.psview .pl li{display:flex;align-items:center;gap:var(--w-s3);padding:var(--w-s2) 0;border-bottom:var(--w-rule)}
.psview .pl a{flex:1;min-width:0;display:flex;align-items:center;gap:var(--w-s3);color:inherit;text-decoration:none}
.psview .pl a:hover b{color:var(--w-live)}
.psview .nm b{display:block;font-weight:500}.psview .nm small{display:block;font-size:var(--w-text-small);color:var(--w-ink-faint)}
.psview section{margin-top:var(--w-s6);padding-top:var(--w-s4);border-top:var(--w-rule)}
.psview h3{margin:0 0 var(--w-s3);font-size:var(--w-text-small);font-weight:500;text-transform:uppercase;letter-spacing:var(--w-caps-spacing);color:var(--w-ink-faint)}
.psview .g2{display:grid;grid-template-columns:1fr 1fr;gap:var(--w-s4)}
@container (max-width:30rem){.psview .g2{grid-template-columns:1fr}}
.psview .ms{width:100%;box-sizing:border-box;padding:var(--w-s1);border:var(--w-rule);border-radius:var(--w-radius, 6px);background:var(--w-surface-document);color:var(--w-ink);font:inherit}
.psview .fl .lb{display:block;margin-bottom:var(--w-s1);font-size:var(--w-text-small);color:var(--w-ink-muted)}
.psview .ic{display:flex;flex-wrap:wrap;gap:var(--w-s1)}
.psview .ic label{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:36px;border:1px solid transparent;border-radius:8px;cursor:pointer}
.psview .ic input{position:absolute;opacity:0;pointer-events:none}
.psview .ic label:has(input:checked){border-color:var(--w-live);background:var(--w-surface-raised, transparent)}
.psview .ic .no{padding:0 var(--w-s2);font-size:var(--w-text-small);color:var(--w-ink-muted)}
.psview .sc{display:inline-block;margin-left:var(--w-s2);padding:0 6px;border:var(--w-rule);border-radius:999px;font-size:11px;font-weight:400;line-height:16px;color:var(--w-ink-faint);vertical-align:1px}
.psview .sc.pj{color:var(--w-live);border-color:currentColor}
.psview .pf{display:flex;flex-wrap:wrap;gap:var(--w-s1);padding:var(--w-s3) 0}
.psview .pf input{position:absolute;opacity:0;pointer-events:none}
.psview .pf label span{display:inline-block;padding:2px 10px;border:var(--w-rule);border-radius:999px;font-size:var(--w-text-small);color:var(--w-ink-muted);cursor:pointer}
.psview .pf label:has(input:checked) span{border-color:var(--w-live);color:var(--w-live)}
.psview .lv{display:flex;gap:var(--w-s4);padding:6px 0}.psview .lv label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.psview:has(input[name=scope][value=system]:checked) [for="team-personas-project"],.psview:has(input[name=scope][value=system]:checked) #team-personas-project{opacity:.4;pointer-events:none}
.psview .row{display:flex;align-items:center;gap:var(--w-s3)}.psview .nt{font-size:var(--w-text-small);color:var(--w-ink-muted)}
</style>`;

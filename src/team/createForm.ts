/**
 * «Создать команду» block for the team.roster popup when the manager has no active team yet
 *
 * Returns '' unless the caller is the signed-in owner (HTTP request with a user) and no active or draft team is supervised by managerAgentId. Otherwise an HTML fragment: the prefilled team-plugin roster of personas (faces from the latest sessions with that agents.meta.persona.name) and one CSRF form posting to POST /team/ (team.$route__POST) with personas JSON, members = the supervisor only, activate=1 and back = the current board URL. Defaults: id team-plugin, title «team-plugin», goal «Развивать плагин team: доска, задачи, ревью, найм», supervisor = managerAgentId, personas Ян, Рома, Даша, Катя, Лена.
 * @param opts.managerAgentId Supervisor session of the new team; the board's manager.
 * @param opts.back Where to return after creation (path on this site).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Supervisor session of the new team; the board's manager. */
        managerAgentId?: string;
        /** Where to return after creation (path on this site). */
        back?: string;
    },
): Promise<string> {
    type Row = Record<string, any>;
    const req = (session as any)?.req as Request | undefined;
    if (!session?.user?.id || !req || (session as any)?.agent || (session as any)?.agentId) return '';
    const sup = String(opts.managerAgentId ?? '').trim();
    if (!sup) return '';
    const teams = await ctx.fns.procs.db.select({ sql: "SELECT id FROM team.team WHERE owner_user_id=? AND supervisor_agent_id=? AND status IN ('draft','active') LIMIT 1", params: [String(session.user.id), sup] }) as Row[];
    if (teams.length) return '';
    const esc = (v: unknown) => ctx.fns.procs.ui.escape({ text: String(v ?? '') });
    const personas = [
        { name: 'Ян', role: 'ядро', responsibilities: 'Ядро плагина: команды, состояние задач, бриф и правила, API для агентов' },
        { name: 'Рома', role: 'команда и найм', responsibilities: 'Состав команды, персоны, найм и увольнение, раздача задач' },
        { name: 'Даша', role: 'дашборд и хроника', responsibilities: 'Доска, хроника, лента событий' },
        { name: 'Катя', role: 'дизайн доски', responsibilities: 'Внешний вид доски, карточки, страницы персон' },
        { name: 'Лена', role: 'ресерч', responsibilities: 'Исследования, сравнение подходов, обзоры' },
    ];
    const icons = new Map<string, string | null>();
    const rows = await ctx.fns.procs.db.select({ sql: "SELECT DISTINCT ON (meta->'persona'->>'name') meta->'persona'->>'name' AS name, icon FROM agents WHERE meta->'persona'->>'name' = ANY(?::text[]) AND icon IS NOT NULL ORDER BY meta->'persona'->>'name', created_at DESC", params: [personas.map(p => p.name)] }) as Row[];
    for (const r of rows) icons.set(String(r.name), r.icon ?? null);
    const csrf = await ctx.fns.auth.csrfField({ req });
    const faces = personas.map(p => `<li style="display:flex;gap:8px;align-items:center">${ctx.fns.w.chatIcon({ icon: icons.get(p.name) ?? null, size: 'sm' })}<span><b>${esc(p.name)}</b> — ${esc(p.role)}</span></li>`).join('');
    const back = opts.back?.startsWith('/') && !opts.back.startsWith('//') ? opts.back : '';
    const hidden = (n: string, v: string) => `<input type="hidden" name="${esc(n)}" value="${esc(v)}">`;
    return `<section class="tcreate">
<h3 style="margin:0 0 6px;font-size:var(--w-text-small, .875rem);font-weight:600">Команды пока нет</h3>
<p class="mu" style="margin:0 0 8px">Постоянная команда <b>team-plugin</b>: участники — персоны, их сессии меняются, а имя, роль и память остаются. Цель: Развивать плагин team: доска, задачи, ревью, найм.</p>
<ul style="list-style:none;padding:0;margin:0 0 10px;display:grid;gap:4px">${faces}</ul>
<form method="post" action="/team/">${csrf}${hidden('teamId', 'team-plugin')}${hidden('requestKey', 'create:team-plugin:' + sup)}${hidden('title', 'team-plugin')}${hidden('goal', 'Развивать плагин team: доска, задачи, ревью, найм')}${hidden('supervisorAgentId', sup)}${hidden('members', JSON.stringify([{ agentId: sup, role: 'менеджер', responsibilities: 'Ставит задачи, принимает работу' }]))}${hidden('personas', JSON.stringify(personas))}${hidden('progressWindowMs', '3600000')}${hidden('activate', '1')}${back ? hidden('back', back) : ''}
${ctx.fns.w.button({ label: 'Создать команду', icon: 'users-three', tone: 'primary', size: 'sm', submit: true })}</form>
</section>`;
}

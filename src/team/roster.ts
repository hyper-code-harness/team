/**
 * Shows the board's team: title, goal and personas (click opens team.persona), or the «Создать команду» form when there is no team yet
 *
 * Read-only @view opened in the app popup from the «Команда» button in the board header (hx-popup="team.roster" with {managerAgentId, back}). The team is the newest draft/active team.team supervised by managerAgentId (owned by the signed-in user; without managerAgentId — the user's newest team). With a team: title, status, goal and the active roster from team.team_persona joined with team.persona — face, name, role; each row opens team.persona in the popup. Without a team: team.createForm (prefilled team-plugin roster and the CSRF «Создать команду» form, back = the board URL); for a reader who cannot create, a quiet empty state.
 * @view
 * @live team
 * @param opts.managerAgentId Board manager session; the team's supervisor.
 * @param opts.back Board URL to return to after «Создать команду».
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Board manager session; the team's supervisor. */
        managerAgentId?: string;
        /** Board URL to return to after «Создать команду». */
        back?: string;
    },
): Promise<string> {
    type Row = Record<string, any>;
    const w = ctx.fns.w;
    const esc = (v: unknown) => w.escape({ text: v === null || v === undefined ? '' : String(v) });
    const userId = session?.user?.id ? String(session.user.id) : '';
    const sup = String(opts.managerAgentId ?? '').trim();
    const teams = userId ? await ctx.fns.procs.db.select({
        sql: `SELECT id, title, goal, status FROM team.team WHERE owner_user_id = ? AND status IN ('draft','active') ${sup ? 'AND supervisor_agent_id = ?' : ''} ORDER BY created_at DESC LIMIT 1`,
        params: sup ? [userId, sup] : [userId],
    }) as Row[] : [];
    const css = `<style>.troster{padding:var(--w-s4) var(--w-s6);display:grid;gap:var(--w-s3)}
.troster .gl{margin:0;color:var(--w-ink-muted)}
.troster ul{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.troster li button{all:unset;box-sizing:border-box;cursor:pointer;width:100%;display:flex;gap:var(--w-s3);align-items:center;padding:var(--w-s2);border-radius:6px}
.troster li button:hover{background:var(--w-hover)}
.troster li small{display:block;color:var(--w-ink-faint);font-size:var(--w-text-small)}</style>`;
    const t = teams[0];
    if (!t) {
        const form = await ctx.fns.team.createForm({ ...(sup ? { managerAgentId: sup } : {}), ...(opts.back ? { back: opts.back } : {}) });
        return `${css}<div class="troster">${form || w.empty({ title: 'Команды пока нет', icon: 'users-three', hint: 'Создать команду может владелец доски.' })}</div>`;
    }
    const people = await ctx.fns.procs.db.select({
        sql: `SELECT tp.persona_name AS name, p.role, p.responsibilities, COALESCE(p.icon, a.icon) AS icon, a.run_state, a.archived_at
            FROM team.team_persona tp JOIN team.persona p ON p.name = tp.persona_name LEFT JOIN agents a ON a.id = p.current_agent_id
            WHERE tp.team_id = ? AND tp.active ORDER BY tp.joined_at`,
        params: [t.id],
    }) as Row[];
    const list = people.length ? `<ul>${people.map(p => `<li data-entity="team-persona" data-id="${esc(p.name)}"><button type="button" hx-popup="team.persona" hx-popup-params="${esc(JSON.stringify({ name: p.name }))}" title="${esc('Открыть персону ' + p.name)}">${w.chatIcon({ icon: p.icon ?? null, size: 'sm', active: p.run_state === 'running' && !p.archived_at })}<span><b>${esc(p.name)}</b> — ${esc(p.role || 'без роли')}${p.responsibilities ? `<small>${esc(p.responsibilities)}</small>` : ''}</span></button></li>`).join('')}</ul>`
        : w.empty({ title: 'В команде пока нет персон', icon: 'users' });
    const st: Record<string, string> = { draft: 'черновик', active: 'активна' };
    return `${css}<div class="troster" data-entity="team" data-id="${esc(t.id)}"><h3 style="margin:0">${esc(t.title)} <small class="mu">${esc(st[String(t.status)] ?? t.status)}</small></h3>${t.goal ? `<p class="gl">Цель: ${esc(t.goal)}</p>` : ''}${list}</div>`;
}

/**
 * Resolve the caller together with the person it acts for: the signed-in owner, or an agent whose session belongs to that owner.
 *
 * Use before owner roster commands (team.create, personaCreate, activate, archive, hire/fire, persona join/bind/leave). An agent acts on behalf of agents.created_by of its own session; rating, feedback, next and reflect stay person-only and must not use this. With teamId the result also says whether the caller may act as that team's owner: the person who owns it, or an owner's agent that is not on the roster or created the team itself (other roster members keep their member rights only). No side effects.
 * @param opts.teamId Team to check owner authority for; omitted checks only that the caller has an owner.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team to check owner authority for; omitted checks only that the caller has an owner. */
        teamId?: string;
    },
): Promise<{ kind: 'user' | 'agent'; id: string; ownerId: string; onBehalfOf: string | null; teamOwner: boolean | null }> {
    const actor = await ctx.fns.team.resolveActor({});
    let ownerId = actor.id, onBehalfOf: string | null = null;
    if (actor.kind === 'agent') {
        const a = await ctx.fns.session.load({ id: actor.id });
        const by = a?.createdBy ? String(a.createdBy) : '';
        if (!by) throw new Error('Сессия агента ' + actor.id + ' не принадлежит человеку (нет created_by) — команду и персону создаёт человек на /team/ или агент его сессии');
        ownerId = by; onBehalfOf = by;
    }
    let teamOwner: boolean | null = null;
    if (opts.teamId) {
        const t = (await ctx.fns.procs.db.select({ sql: 'SELECT owner_user_id FROM team.team WHERE id=?', params: [opts.teamId] }))[0];
        teamOwner = !!t && String(t.owner_user_id) === ownerId;
        if (teamOwner && actor.kind === 'agent') {
            // A roster member does not inherit owner authority unless it created the team itself.
            const member = (await ctx.fns.procs.db.select({ sql: 'SELECT 1 FROM team.member WHERE team_id=? AND agent_id=? AND left_at IS NULL', params: [opts.teamId, actor.id] })).length > 0;
            const creator = (await ctx.fns.procs.db.select({ sql: "SELECT 1 FROM team.event WHERE team_id=? AND seq=1 AND kind='created' AND actor_kind='agent' AND actor_id=?", params: [opts.teamId, actor.id] })).length > 0;
            teamOwner = !member || creator;
        }
    }
    return { kind: actor.kind, id: actor.id, ownerId, onBehalfOf, teamOwner };
}

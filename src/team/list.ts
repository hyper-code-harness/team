/**
 * List teams visible to the injected owner or roster member
 *
 * Use to discover persistent teams before opening a passport. Human users see only their owned teams; agents see only teams whose roster contains their identity. No actor override is accepted.
 *
 * Empty result is normal for an agent that is not on any roster: it does not mean teams are missing. An agent whose session belongs to a person may create teams and personas for that person (team.create, team.personaCreate; recorded on_behalf_of); ratings stay with the person on /team/. To get work done call team.delegate({agent, persona, title, human, details}). The return stays a plain array (no hint field) because the dashboard, feed, room and personas filter it directly.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {},
): Promise<{id:string;owner_user_id:string;title:string;goal:string;supervisor_agent_id:string;status:'draft'|'active'|'archived';version:number;next_seq:number;progress_window_ms:number;created_at:number}[]> {
    const actor=await ctx.fns.team.resolveActor({});
    return await ctx.fns.procs.db.select({sql:"SELECT t.* FROM team.team t WHERE (?='user' AND t.owner_user_id=?) OR (?='agent' AND EXISTS (SELECT 1 FROM team.member m WHERE m.team_id=t.id AND m.agent_id=?)) ORDER BY t.created_at DESC,t.id",params:[actor.kind,actor.id,actor.kind,actor.id]});
}

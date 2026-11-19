/**
 * List teams visible to the injected owner or roster member
 *
 * Use to discover persistent teams before opening a passport. Human users see only their owned teams; agents see only teams whose roster contains their identity. No actor override is accepted.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {},
): Promise<{id:string;owner_user_id:string;title:string;goal:string;supervisor_agent_id:string;status:'draft'|'active'|'archived';version:number;next_seq:number;progress_window_ms:number;created_at:number}[]> {
    const actor=await ctx.fns.team.resolveActor({});
    return await ctx.fns.procs.db.select({sql:"SELECT t.* FROM team.team t WHERE (?='user' AND t.owner_user_id=?) OR (?='agent' AND EXISTS (SELECT 1 FROM team.member m WHERE m.team_id=t.id AND m.agent_id=?)) ORDER BY t.created_at DESC,t.id",params:[actor.kind,actor.id,actor.kind,actor.id]});
}

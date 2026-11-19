/**
 * Read an authorized team passport, roster, board and delivery status
 *
 * Use to inspect a persistent team. Resolves identity only from injected context: the owning HTTP user or a roster member may read. Delivery claims and receipts are not exposed. Queries produce a current view, not a transactional snapshot.
 * @param opts.teamId Persistent team identifier.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persistent team identifier. */
        teamId: string;
    },
): Promise<{team:{id:string;owner_user_id:string;title:string;goal:string;supervisor_agent_id:string;status:'draft'|'active'|'archived';version:number;next_seq:number;progress_window_ms:number;created_at:number};members:{team_id:string;agent_id:string;role:string;responsibilities:string;active:boolean}[];tasks:{id:string;team_id:string;title:string;instructions:string;acceptance_criteria:string;assignee_agent_id:string|null;status:'todo'|'assigned'|'working'|'blocked'|'paused'|'review'|'done'|'cancelled';version:number;ever_started_at:number|null;current_submission_id:string|null;blocked_reason:string|null;progress_due_at:number|null;last_progress_at:number|null;deadline_generation:number;rank:number|null;group_key:string|null;depends_on:string[];paused_note:string|null}[];deliveries:{id:string;team_id:string;event_id:string;recipient_agent_id:string;status:'pending'|'claimed'|'delivered'|'failed';attempts:number;next_at:number;last_error:string|null}[]}> {
    const actor = await ctx.fns.team.resolveActor({});
    if (!opts.teamId?.trim()) throw new Error('teamId is required');
    const rows = await ctx.fns.procs.db.select({sql: "SELECT t.* FROM team.team t WHERE t.id = ? AND ((? = 'user' AND t.owner_user_id = ?) OR (? = 'agent' AND EXISTS (SELECT 1 FROM team.member m WHERE m.team_id=t.id AND m.agent_id=?)))",params:[opts.teamId,actor.kind,actor.id,actor.kind,actor.id]});
    if (!rows.length) throw new Error('Team not found or access denied');
    const [members,tasks,deliveries] = await Promise.all([
    ctx.fns.procs.db.select({sql:'SELECT * FROM team.member WHERE team_id=? ORDER BY role,agent_id',params:[opts.teamId]}),
    ctx.fns.procs.db.select({sql:'SELECT * FROM team.task WHERE team_id=? ORDER BY assignee_agent_id NULLS FIRST, rank NULLS LAST, id',params:[opts.teamId]}),
    ctx.fns.procs.db.select({sql:'SELECT id,team_id,event_id,recipient_agent_id,status,attempts,next_at,last_error FROM team.delivery WHERE team_id=? ORDER BY next_at,id',params:[opts.teamId]})]);
    return {team:rows[0],members,tasks,deliveries};
}

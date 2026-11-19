/**
 * Remove a member from an active team.
 *
 * Supervisor or owner only; the supervisor cannot be fired. In one command: every unfinished task of the member (including started, paused or in review) goes back to the backlog as todo, or to reassignTo as assigned; the member is marked departed (left_at, reason) and loses roster rights; its pending notifications are cancelled; a public memberFire event lists the returned tasks. After commit the session goes through team.retire (a persona session first updates its persona, then is archived; the persona stays and keeps its notes) when it was hired by team.hire or is a persona session, or when archiveSession is true.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Stable intent key; reuse only for exact retries.
 * @param opts.expectedVersion Current team version. @minimum 1
 * @param opts.memberId Agent id of the departing member.
 * @param opts.reason Why the member leaves; shown in the timeline.
 * @param opts.reassignTo Remaining member who takes the unfinished tasks; omitted returns them to the backlog.
 * @param opts.archiveSession Archive the member session; defaults to true for sessions hired by team.hire, false otherwise.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team identifier. */
        teamId: string;
        /** Stable intent key; reuse only for exact retries. */
        requestKey: string;
        /** Current team version. @minimum 1 */
        expectedVersion: number;
        /** Agent id of the departing member. */
        memberId: string;
        /** Why the member leaves; shown in the timeline. */
        reason: string;
        /** Remaining member who takes the unfinished tasks; omitted returns them to the backlog. */
        reassignTo?: string;
        /** Archive the member session; defaults to true for sessions hired by team.hire, false otherwise. */
        archiveSession?: boolean;
    },
): Promise<Record<string,unknown>> {
    const out=await ctx.fns.team.executeCommand({teamId:opts.teamId,requestKey:opts.requestKey,expectedVersion:opts.expectedVersion,command:{action:'memberFire',agentId:opts.memberId,reason:opts.reason,...(opts.reassignTo?{reassignTo:opts.reassignTo}:{})}});
    const rows=await ctx.fns.procs.db.select({sql:'SELECT persona FROM team.member WHERE team_id=? AND agent_id=?',params:[opts.teamId,opts.memberId]});
    const hired=!!rows[0]?.persona;
    let archived=false; let retire:unknown=null;
    // A persona session gets its last turn to update the persona (team.retire), then is archived; the persona stays.
    if(opts.archiveSession ?? hired) { try { const r=await ctx.fns.team.retire({agentId:opts.memberId,reason:opts.reason}); retire=r; archived=r.archived; } catch(e) { retire={error:String((e as Error)?.message??e).slice(0,200)}; } }
    return {...out,archived,retire};
}

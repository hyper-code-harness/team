/**
 * Validate an explicit task transition and produce its next normative state.
 *
 * Pure board state machine used under a team row lock. Enforces slot exclusivity, started work restrictions, dependency-gated claim, pause/resume (paused releases the slot) and review authority without database or transport side effects.
 * @param opts.task Current locked task snapshot.
 * @param opts.command Explicit transition and its submission or review evidence.
 * @param opts.actorKind Verified caller principal kind.
 * @param opts.actorId Verified caller identifier.
 * @param opts.supervisorId Frozen supervisor identifier.
 * @param opts.slotTaskId Existing working or blocked task for assignee.
 * @param opts.now Transaction time in epoch milliseconds.
 * @param opts.submissionId Fresh event identifier for submission evidence.
 * @param opts.progressWindowMs Progress reporting window in milliseconds. @minimum 1000 @maximum 86400000
 * @param opts.dependencyStatuses Current status of each dependsOn task, keyed by task id; required for claim.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Current locked task snapshot. */
        task: types.team.Task;
        /** Explicit transition and its submission or review evidence. */
        command: types.team.Transition;
        /** Verified caller principal kind. */
        actorKind: "user" | "agent";
        /** Verified caller identifier. */
        actorId: string;
        /** Frozen supervisor identifier. */
        supervisorId: string;
        /** Existing working or blocked task for assignee. */
        slotTaskId: string | null;
        /** Transaction time in epoch milliseconds. */
        now: number;
        /** Fresh event identifier for submission evidence. */
        submissionId: string;
        /** Progress reporting window in milliseconds. @minimum 1000 @maximum 86400000 */
        progressWindowMs: number;
        /** Current status of each dependsOn task, keyed by task id; required for claim. */
        dependencyStatuses?: Record<string, string>;
    },
): Promise<types.team.Task> {
    const t = {...opts.task};
    const c = opts.command;
    const owner = opts.actorKind === 'user';
    const supervisor = opts.actorKind === 'agent' && opts.actorId === opts.supervisorId;
    const assignee = opts.actorKind === 'agent' && opts.actorId === t.assigneeAgentId;
    const fail = (message:string):never => {throw new Error(message)};
    if (!Number.isFinite(opts.now) || opts.progressWindowMs < 1000 || opts.progressWindowMs > 86400000) fail('Invalid deadline policy');
    const requireAssignee = () => {if (!assignee) fail('Only assignee may execute this transition')};
    const arm = () => {t.progressDueAt = opts.now + opts.progressWindowMs; t.deadlineGeneration++};
    const acquireSlot = () => {if (opts.slotTaskId && opts.slotTaskId !== t.id) fail('Assignee already has a working or blocked task')};
    switch(c.action) {
     case 'start': requireAssignee(); if(t.status !== 'assigned') fail('Start requires assigned'); acquireSlot(); t.status='working'; t.everStartedAt ??= opts.now; arm(); break;
     case 'block': requireAssignee(); if(t.status !== 'working') fail('Block requires working'); if(!c.reason.trim()) fail('Blocked reason required'); t.status='blocked'; t.blockedReason=c.reason; arm(); break;
     case 'resume': requireAssignee(); if(t.status !== 'blocked' && t.status !== 'paused') fail('Resume requires blocked or paused'); acquireSlot(); if(t.status==='paused') t.pausedNote=null; t.status='working'; t.blockedReason=null; arm(); break;
     case 'claim': {
      if(opts.actorKind !== 'agent') fail('Only a roster agent may claim');
      if(t.status !== 'todo' || t.assigneeAgentId !== null) fail('Claim requires unassigned todo');
      const deps = opts.dependencyStatuses ?? {};
      const open = (t.dependsOn ?? []).filter(id => deps[id] !== 'done');
      if(open.length) fail('Dependencies not done: '+open.join(','));
      t.assigneeAgentId=opts.actorId; t.status='assigned'; break;
     }
     case 'pause':
      if(!assignee && !owner && !supervisor) fail('Assignee, supervisor or owner required');
      if(t.status !== 'working' && t.status !== 'blocked') fail('Pause requires working or blocked');
      if(typeof c.note !== 'string' || !c.note.trim()) fail('Pause note required');
      t.status='paused'; t.pausedNote=c.note; t.progressDueAt=null; break;
     case 'submit': requireAssignee(); if(t.status !== 'working') fail('Submit requires working'); if(!c.summary.trim() || !c.verification.trim() || !Array.isArray(c.artifacts)) fail('Submission summary, artifacts and verification required'); t.status='review'; t.currentSubmissionId=opts.submissionId; t.progressDueAt=null; t.blockedReason=null; break;
     case 'approve': case 'changes':
      if(!owner && (!supervisor || t.assigneeAgentId===opts.supervisorId)) fail('Reviewer authority required; supervisor work requires owner');
      if(t.status !== 'review' || t.currentSubmissionId !== c.submissionId) fail('Stale submission');
      if(!c.reason.trim()) fail('Review reason required');
      if(c.action==='approve'){t.status='done';t.progressDueAt=null;} else {t.status='assigned';t.currentSubmissionId=null;arm();}
      break;
     case 'cancel':
      if(!owner && !supervisor) fail('Supervisor or owner required');
      if(t.status==='paused') { if(typeof c.reason !== 'string' || !c.reason.trim()) fail('Cancel of paused work requires a reason'); t.status='cancelled'; t.progressDueAt=null; break; }
      if(t.everStartedAt!==null || !['todo','assigned'].includes(t.status)) fail('Started work cannot be cancelled'); t.status='cancelled';t.progressDueAt=null;break;
     default: fail('Unsupported transition');
    }
    t.version++; return t;
}

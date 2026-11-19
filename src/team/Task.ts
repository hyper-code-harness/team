/** Normative task state persisted in team.task; timestamps are milliseconds. Paused does not hold the working slot. */
export type Task = {
 id: string; teamId: string; title: string; instructions: string; acceptanceCriteria: string;
 assigneeAgentId: string | null;
 status: 'todo' | 'assigned' | 'working' | 'blocked' | 'paused' | 'review' | 'done' | 'cancelled';
 version: number; everStartedAt: number | null; currentSubmissionId: string | null;
 blockedReason: string | null; progressDueAt: number | null; lastProgressAt: number | null;
 deadlineGeneration: number;
 /** Order within the backlog (no assignee) or the assignee queue; lower runs first. */
 rank: number | null; groupKey: string | null; dependsOn: string[]; pausedNote: string | null;
};

/** Explicit board commands; submissions preserve evidence in append-only events. */
export type Transition =
 | {action:'start'|'resume'|'claim'}
 | {action:'cancel'; reason?:string}
 | {action:'block'; reason:string}
 | {action:'pause'; note:string}
 | {action:'submit'; summary:string; artifacts:string[]; verification:string; report?:types.team.TaskReport}
 | {action:'approve'|'changes'; submissionId:string; reason:string; /** Assignee acting on the owner's rating (team.close / team.rework): allowed only with an owner rating given after the current submission. */ byOwnerRating?:boolean};

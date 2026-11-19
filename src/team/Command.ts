/** Versioned board or public communication intent. Actor identity is never part of input. */
export type Command =
 | {action:'activate'|'archive'}
 | {action:'retryDelivery'; deliveryId:string}
 | {action:'taskCreate'; taskId:string; title:string; instructions:string; acceptanceCriteria:string; assigneeAgentId?:string; rank?:number; groupKey?:string; dependsOn?:string[]}
 | {action:'taskAssign'; taskId:string; assigneeAgentId:string}
 | {action:'taskReorder'; taskId:string; rank:number; assigneeAgentId?:string}
 | {action:'preempt'; urgentTaskId:string; note:string; assigneeAgentId?:string}
 | {action:'taskTransition'; taskId:string; transition:types.team.Transition}
 | {action:'say'; text:string; to:'all'|string; taskId?:string; replyTo?:string}
 | {action:'report'; text:string; kind:'milestone'|'finding'|'risk'|'decision'|'progress'; taskId?:string}
 | {action:'memberHire'; agentId:string; persona:{name:string; role:string; skills?:string[]; allowed?:string[]}; brief?:string}
 | {action:'memberFire'; agentId:string; reason:string; reassignTo?:string}
 | {action:'personaJoin'; name:string}
 | {action:'personaBind'; name:string; agentId:string; moveOpen?:boolean}
 | {action:'personaLeave'; name:string; reason:string};

/** Trusted call identity; supplied only by team.actor, never by a public command option. */
export type Actor = {kind:'user'|'agent'; id:string};

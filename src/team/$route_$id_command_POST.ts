/** Submit a same-origin owner's explicit board command using trusted HTTP context.
 * @param opts.req Authenticated form request; origin must match the request URL.
 * @param opts.params Team id path parameter.
 */
export default async function(ctx:Context,session:Session|null,opts:{req:Request;params:Record<string,string>}):Promise<Response> {
 const req=opts.req;
 if(!session?.user?.id||!session.req) return new Response('Authentication required',{status:401});
 const origin=req.headers.get('origin');
 if(!origin||origin!==new URL(req.url).origin||req.headers.get('sec-fetch-site')==='cross-site') return new Response('Same-origin request required',{status:403});
 if(!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return new Response('URL encoded form required',{status:415});
 const body=await req.text(); if(body.length>100000) return new Response('Form too large',{status:413});
 const f=new URLSearchParams(body); const text=(name:string)=>f.get(name)??'';
 const teamId=opts.params.id; let current:Awaited<ReturnType<typeof ctx.fns.team.get>>;
 try {current=await ctx.fns.team.get({teamId});}
 catch(error){if(error instanceof Error&&error.message==='Team not found or access denied')return new Response('Team not found',{status:404});throw error;}
 if(current.team.owner_user_id!==String(session.user.id)) return new Response('Owner required',{status:403});
 if(text('action')==='configureMaintenance') {
  try {await ctx.fns.team.configureMaintenance({});}
  catch(error){return new Response('Maintenance setup failed: '+(error instanceof Error?error.message:String(error)),{status:409});}
  return new Response(null,{status:303,headers:{location:'/team/'+encodeURIComponent(teamId)}});
 }
 const expectedVersion=Number(text('expectedVersion')),requestKey=text('requestKey');
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!requestKey.trim()) return new Response('Version and request key required',{status:400});
 let command:types.team.Command;const action=text('action');
 if(action==='activate'||action==='archive')command={action};
 else if(action==='retryDelivery')command={action,deliveryId:text('deliveryId')};
 else if(action==='taskCreate')command={action,taskId:text('taskId'),title:text('title'),instructions:text('instructions'),acceptanceCriteria:text('acceptanceCriteria'),...(text('assigneeAgentId')?{assigneeAgentId:text('assigneeAgentId')}:{})};
 else if(action==='taskAssign')command={action,taskId:text('taskId'),assigneeAgentId:text('assigneeAgentId')};
 else if(action==='review') {const decision=text('decision');if(decision!=='approve'&&decision!=='changes')return new Response('Invalid review decision',{status:400});command={action:'taskTransition',taskId:text('taskId'),transition:{action:decision,submissionId:text('submissionId'),reason:text('reason')}};}
 else return new Response('Unsupported command',{status:400});
 try {if(action==='activate')await ctx.fns.team.configureMaintenance({}); await ctx.fns.team.executeCommand({teamId,requestKey,expectedVersion,command});}
 catch(error) {return new Response('Command rejected. Reload the team before trying a new intent. '+(error instanceof Error?error.message:'Unknown error'),{status:409,headers:{'content-type':'text/plain; charset=utf-8'}});}
 return new Response(null,{status:303,headers:{location:'/team/'+encodeURIComponent(teamId)}});
}

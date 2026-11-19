/** Create an owner's team from a CSRF-checked form: existing agent ids (members JSON) and/or personas (personas JSON). activate=1 activates it right away.
 * @param opts.req Authenticated URL-encoded form request with _csrf.
 * @param opts.params Unused collection route parameters.
 */
export default async function(ctx:Context,session:Session|null,opts:{req:Request;params:Record<string,string>}):Promise<Response> {
 const req=opts.req;
 if(!session?.user?.id||!session.req)return new Response('Authentication required',{status:401});
 // CSRF is the gate (behind the mesh proxy Origin differs from req.url, see feedback route); cross-site fetches are still refused.
 if(req.headers.get('sec-fetch-site')==='cross-site')return new Response('Same-origin request required',{status:403});
 if(!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))return new Response('URL encoded form required',{status:415});
 const body=await req.text();if(body.length>100000)return new Response('Form too large',{status:413});
 const f=new URLSearchParams(body),text=(name:string)=>f.get(name)??'';
 if(!await ctx.fns.auth.verifyCsrf({req,token:text('_csrf')||req.headers.get('x-csrf-token')||''}))return new Response('Invalid CSRF token',{status:403});
 let personas:{name:string;role:string;responsibilities?:string}[]=[];
 if(text('personas').trim()){let pp:unknown;try{pp=JSON.parse(text('personas'));}catch{return new Response('Personas must be valid JSON',{status:400});}
  if(!Array.isArray(pp)||pp.length>30||pp.some(p=>!p||typeof p.name!=='string'||typeof p.role!=='string'))return new Response('Every persona needs name and role strings',{status:400});
  personas=pp.map(p=>({name:p.name,role:p.role,...(typeof p.responsibilities==='string'?{responsibilities:p.responsibilities}:{})}));}
 let parsed:unknown;try {parsed=JSON.parse(text('members'));}catch(error){return new Response('Roster must be valid JSON',{status:400});}
 if(!Array.isArray(parsed)||!parsed.length||parsed.length>100)return new Response('Roster must contain 1 to 100 members',{status:400});
 const members:{agentId:string;role:string;responsibilities:string}[]=[];
 for(const row of parsed) {if(!row||typeof row!=='object'||typeof row.agentId!=='string'||typeof row.role!=='string'||typeof row.responsibilities!=='string')return new Response('Every member needs agentId, role and responsibilities strings',{status:400});members.push({agentId:row.agentId,role:row.role,responsibilities:row.responsibilities});}
 const progressWindowMs=Number(text('progressWindowMs'));
 if(!Number.isSafeInteger(progressWindowMs)||progressWindowMs<1000||progressWindowMs>86400000)return new Response('Progress window must be 1000 to 86400000 milliseconds',{status:400});
 const teamId=text('teamId');
 try {await ctx.fns.team.create({teamId,requestKey:text('requestKey'),title:text('title'),goal:text('goal'),supervisorAgentId:text('supervisorAgentId'),members,progressWindowMs,...(personas.length?{personas}:{})});
  if(text('activate')==='1'){const g=await ctx.fns.team.get({teamId});if(g.team.status==='draft')await ctx.fns.team.activate({teamId,requestKey:text('requestKey')+':activate',expectedVersion:Number(g.team.version)});}}
 catch(error){return new Response('Create rejected: '+(error instanceof Error?error.message:'Unknown error'),{status:409,headers:{'content-type':'text/plain; charset=utf-8'}});}
 const back=text('back');return new Response(null,{status:303,headers:{location:back.startsWith('/')&&!back.startsWith('//')?back:'/team/'+encodeURIComponent(teamId)}});
}

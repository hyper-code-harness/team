/** Accept the owner's (CSRF-checked) "Принять" form from team.taskView: on success empty the app popup body (popup.js then closes it) with a toast; on failure answer with the refreshed card and the error.
 * @param opts.req Authenticated same-origin form request with taskId, optional agentId and optional stars 1–5 (saved with team.rate right after the accept: accept + rate in one action).
 */
export default async function(ctx:Context,session:Session|null,opts:{req:Request}):Promise<Response> {
 const req=opts.req;
 const html=(body:string,status=200)=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8'}});
 if(!session?.user?.id||!session.req) return new Response('Authentication required',{status:401});
 if(req.headers.get('sec-fetch-site')==='cross-site') return new Response('Same-origin request required',{status:403});
 const type=req.headers.get('content-type')??'';
 if(!type.startsWith('application/x-www-form-urlencoded')&&!type.startsWith('multipart/form-data')) return new Response('Form required',{status:415});
 if(Number(req.headers.get('content-length')??0)>100000) return new Response('Form too large',{status:413});
 const f=await req.formData(); const get=(k:string)=>String(f.get(k)??'').trim();
 if(!await ctx.fns.auth.verifyCsrf({req,token:get('_csrf')||req.headers.get('x-csrf-token')||''})) return new Response('Invalid CSRF token',{status:403});
 const taskId=get('taskId'), agentId=get('agentId');
 if(!taskId) return new Response('taskId required',{status:400});
 const close=(message:string)=>{const r=ctx.fns.w.respond({toast:{message}});const h=new Headers(r.headers);h.set('HX-Retarget','#app-popup-body');h.set('HX-Reswap','innerHTML');return new Response('',{status:200,headers:h});};
 let notice='';
 const stars=Number(get('stars')||0);
 if(stars&&(!Number.isInteger(stars)||stars<1||stars>5)) return new Response('stars must be 1–5',{status:400});
 try { await ctx.fns.team.accept({taskId,...(agentId?{agentId}:{})}); }
 catch(error) { return html(await ctx.fns.team.taskView({taskId,...(agentId?{agentId}:{}),notice:'Не принято: '+(error instanceof Error?error.message:String(error))})); }
 // accept + rate in one action: the stars of the «Принять» form are saved right after the final accept
 try { if(stars) await ctx.fns.team.rate({taskId,stars,...(agentId?{agentId}:{})}); return close('Принято'+(stars?' с оценкой ★'+stars:'')+': задача ушла в историю.'); }
 catch(error) { notice='Принято, но оценка не сохранилась: '+(error instanceof Error?error.message:String(error)); }
 return html(await ctx.fns.team.taskView({taskId,...(agentId?{agentId}:{}),notice}));
}

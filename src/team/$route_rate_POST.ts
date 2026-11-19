/** Accept the owner's (CSRF-checked) star rating form from team.taskView (team.rate): on success empty the app popup body (popup.js then closes it) with a toast; on failure answer with the refreshed card and the error.
 * @param opts.req Authenticated same-origin form request with taskId, optional agentId, stars 1–5 and optional comment.
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
 const taskId=get('taskId'), agentId=get('agentId'), stars=Number(get('stars')), comment=get('comment');
 if(!taskId) return new Response('taskId required',{status:400});
 const close=(message:string)=>{const r=ctx.fns.w.respond({toast:{message}});const h=new Headers(r.headers);h.set('HX-Retarget','#app-popup-body');h.set('HX-Reswap','innerHTML');return new Response('',{status:200,headers:h});};
 let notice='';
 try { await ctx.fns.team.rate({taskId,stars,...(comment?{comment}:{}),...(agentId?{agentId}:{})}); return close('Оценка сохранена: ★'+stars+'.'); }
 catch(error) { notice='Оценка не сохранена: '+(error instanceof Error?error.message:String(error)); }
 return html(await ctx.fns.team.taskView({taskId,...(agentId?{agentId}:{}),notice}));
}

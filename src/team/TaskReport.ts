/** Structured task report an agent writes when it hands work in: what was done, decisions with reasons, checks, files, open questions, what is not done, next steps and visuals. */
export type TaskReport = {
 /** One or two sentences: the outcome. */
 summary: string;
 /** Concrete things done. */
 done?: string[];
 /** Decisions taken and why. */
 decisions?: {what:string; why:string}[];
 /** What was verified and how (command, test, screenshot), stated as it is. */
 checks?: string[];
 /** Files or artifacts touched or produced (paths, URLs). */
 files?: string[];
 /** Open questions or risks for the reviewer. */
 questions?: string[];
 /** What was NOT done (empty array when everything is done), short, in plain words. */
 notDone?: string[];
 /** What is worth doing next: continue = finish this same task, new = a separate new task. Empty array when nothing. */
 next?: {title:string; why?:string; kind:'continue'|'new'}[];
 /** Pictures of the result: screenshots (png path), SVG schemas, mermaid source, html fragments, canvas/view links. */
 visuals?: {title:string; kind:'image'|'svg'|'mermaid'|'html'|'canvas'; path?:string; svg?:string; source?:string; html?:string; url?:string}[];
};

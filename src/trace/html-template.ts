/**
 * 轨迹 HTML 的页面骨架、样式与脚本（docs/history/wave6-plan.md §2.5）。[W6-T2]
 *
 * 全部静态：页面只插入三样东西——`lang`、转义过的 `<title>`、已做脚本安全转义的 JSON（`html.ts`）。
 * 脚本只用 `textContent` / `createElement` 写 DOM，不用 `innerHTML`；没有任何外部资源（CSP 见 `CSP`）。
 *
 * 页面：顶部标题 / 汇总 / 工具栏（搜索、跳到回合、缩放、全部展开 / 折叠、图例）；中间是一张表——左列树
 * （sticky）+ 右侧瀑布（横轴 = 会话时间，回合间空闲已压缩，刻度标原始时间）；底部详情。行高固定、只建
 * 可见 ±50 行的 DOM（虚拟列表），10k 行也流畅。键：↑↓ 选择、←→ 折叠 / 展开、`/` 搜索、Enter / Shift+Enter
 * 在匹配间跳转、Ctrl + 滚轮缩放。深浅色跟随系统。
 */

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root{--bg:#fff;--fg:#1f2328;--mut:#656d76;--line:#d8dee4;--alt:#f6f8fa;--sel:#ddf4ff;--hit:#fff8c5;
--ttft:#bf8700;--dec:#0969da;--tool:#1a7f37;--agent:#8250df;--wait:#8c959f;--oth:#1b7c83;--turn:#d0d7de;
--err:#cf222e;--warn:#9a6700;--run:#0969da;--lw:420px;font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8d96a0;--line:#30363d;--alt:#161b22;
--sel:#1f3a5f;--hit:#3b2e00;--ttft:#d29922;--dec:#4493f8;--tool:#3fb950;--agent:#ab7df8;--wait:#6e7681;
--oth:#39c5cf;--turn:#30363d;--err:#f85149;--warn:#d29922;--run:#4493f8}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg)}
body{display:flex;flex-direction:column}
header{padding:8px 12px;border-bottom:1px solid var(--line)}
h1{font-size:15px;margin:0 0 2px}.sum{font-variant-numeric:tabular-nums}.mut{color:var(--mut)}
.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px}
input,select,button{font:inherit;color:inherit;background:var(--alt);border:1px solid var(--line);border-radius:4px;padding:2px 6px}
button{cursor:pointer}input{width:200px}
.lg{display:inline-flex;align-items:center;gap:4px;margin-left:6px;color:var(--mut)}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px}
#sc{flex:1;overflow:auto;position:relative}
#ru{position:sticky;top:0;z-index:3;height:20px;display:flex;background:var(--bg);border-bottom:1px solid var(--line)}
#ru .lc{background:var(--bg)}#tk{position:relative;flex:none;height:20px}
.tick{position:absolute;top:0;height:20px;border-left:1px solid var(--line);padding-left:3px;font-size:11px;color:var(--mut);white-space:nowrap}
#bd{position:relative}
.row{position:absolute;left:0;height:22px;display:flex;cursor:default}
.row.odd .lc,.row.odd .wf{background:var(--alt)}
.row.sel .lc,.row.sel .wf{background:var(--sel)}.row.hit .lc{background:var(--hit)}
.lc{position:sticky;left:0;z-index:2;flex:none;width:var(--lw);display:flex;align-items:center;gap:4px;
padding-right:6px;background:var(--bg);border-right:1px solid var(--line);overflow:hidden;white-space:nowrap}
.tg{flex:none;width:14px;text-align:center;color:var(--mut);cursor:pointer}
.lb{flex:1;overflow:hidden;text-overflow:ellipsis}.k-turn .lb{font-weight:600}
.cols{flex:none;color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}
.st{flex:none;font-size:11px;padding:0 4px;border-radius:3px;color:var(--bg);background:var(--mut)}
.st.error,.st.denied{background:var(--err)}.st.aborted,.st.interrupted,.st.retried{background:var(--warn)}.st.running{background:var(--run)}
.wf{position:relative;flex:none;height:22px}
.sg{position:absolute;top:6px;height:10px;min-width:2px;border-radius:2px}
.sg.turn{top:9px;height:4px;background:var(--turn)}.sg.ttft{background:var(--ttft)}.sg.dec{background:var(--dec)}
.sg.tool{background:var(--tool)}.sg.agent{background:var(--agent)}.sg.oth{background:var(--oth)}
.sg.wait{background:repeating-linear-gradient(45deg,var(--wait) 0 3px,transparent 3px 6px)}
.sg.run{width:2px;top:3px;height:16px;background:var(--run)}
#dt{height:32vh;overflow:auto;border-top:1px solid var(--line);padding:8px 12px}
#dt h2{font-size:14px;margin:0 0 6px}#dt h3{font-size:12px;margin:10px 0 4px;color:var(--mut)}
#dt table{border-collapse:collapse}#dt td{padding:1px 12px 1px 0;vertical-align:top}#dt td:first-child{color:var(--mut);white-space:nowrap}
pre{margin:0;padding:6px 8px;background:var(--alt);border:1px solid var(--line);border-radius:4px;white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow:auto}
footer{padding:4px 12px;border-top:1px solid var(--line);font-size:11px;color:var(--mut)}
`;

const SCRIPT = `
(function(){"use strict";
var D=JSON.parse(document.getElementById("data").textContent),R=D.rows,I=D.i18n,N=R.length;
var RH=22,OV=50,LW=420,AX=D.axis,SPAN=D.span;
function lw(){LW=Math.max(200,Math.min(420,Math.floor($("sc").clientWidth*0.45)));document.documentElement.style.setProperty("--lw",LW+"px")}
var $=function(id){return document.getElementById(id)};
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
var kids=new Uint8Array(N),open=new Uint8Array(N),vis=[],sel=-1,hits=[],hit=-1,hitSet={},scale=1,W=0,fitted=1;
for(var i=0;i<N;i++){if(R[i].p>=0)kids[R[i].p]=1;if(R[i].e)open[i]=1}
function rebuild(){vis=[];var skip=1e9;for(var i=0;i<N;i++){var r=R[i];if(r.d>skip)continue;skip=1e9;vis.push(i);if(kids[i]&&!open[i])skip=r.d}
$("bd").style.height=(vis.length*RH)+"px";draw()}
function width(){return Math.max(SPAN*scale,$("sc").clientWidth-LW-2)}
function fit(){fitted=1;scale=Math.max(1e-6,($("sc").clientWidth-LW-24)/SPAN);rebuild()}
function inv(m){var p=AX[0]||[0,0];for(var k=0;k<AX.length;k++){var q=AX[k];if(m<=q[1]){return q[1]===p[1]?q[0]:p[0]+(m-p[1])*(q[0]-p[0])/(q[1]-p[1])}p=q}return p[0]+(m-p[1])}
function fmt(ms){ms=Math.max(0,Math.round(ms));if(ms<1000)return ms+"ms";var s=ms/1000;if(s<60)return(s<10?s.toFixed(1):Math.floor(s))+"s";s=Math.floor(s);return Math.floor(s/60)+"m"+String(s%60).padStart(2,"0")+"s"}
function ticks(){var t=$("tk"),sc=$("sc");t.style.width=W+"px";t.textContent="";
var a=Math.max(0,sc.scrollLeft-LW),b=a+sc.clientWidth,raw=90/scale,step=1;
while(step<raw){step*=(String(step).charAt(0)==="2"?2.5:2)}
for(var x=Math.floor(a/scale/step)*step;x*scale<=b;x+=step){if(x<0)continue;var e=el("div","tick",fmt(inv(x)));e.style.left=(x*scale)+"px";t.appendChild(e)}}
function row(idx,top){var i=vis[idx],r=R[i],e=el("div","row k-"+r.k+(idx%2?" odd":"")+(i===sel?" sel":"")+(hitSet[i]?" hit":""));
e.style.top=top+"px";e.dataset.i=i;var lc=el("div","lc");lc.style.paddingLeft=(4+Math.min(r.d,12)*14)+"px";
var tg=el("span","tg",kids[i]?(open[i]?"\\u25BE":"\\u25B8"):"");tg.dataset.t="1";lc.appendChild(tg);
if(r.s){lc.appendChild(el("span","st "+(r.sc||""),r.s))}
var lb=el("span","lb",r.l);lb.title=r.l;lc.appendChild(lb);
var cols=[r.du,r.tk,r.ca].filter(Boolean).join("  ");if(cols)lc.appendChild(el("span","cols",cols));
e.appendChild(lc);var wf=el("div","wf");wf.style.width=W+"px";
(r.g||[]).forEach(function(g){var s=el("div","sg "+g[2]);s.style.left=(g[0]*scale)+"px";if(g[2]!=="run")s.style.width=Math.max(2,(g[1]-g[0])*scale)+"px";wf.appendChild(s)});
e.appendChild(wf);e.style.width=(LW+W)+"px";return e}
var pend=0;function draw(){if(pend)return;pend=1;requestAnimationFrame(function(){pend=0;paint()})}
function paint(){var sc=$("sc"),bd=$("bd"),h=sc.clientHeight,first=Math.max(0,Math.floor(sc.scrollTop/RH)-OV),last=Math.min(vis.length,Math.ceil((sc.scrollTop+h)/RH)+OV);
W=width();bd.textContent="";if(N===0){bd.appendChild(el("div","mut",I.empty));return}
for(var k=first;k<last;k++)bd.appendChild(row(k,k*RH));ticks()}
function select(i,scroll){sel=i;var at=vis.indexOf(i);if(scroll&&at>=0){var sc=$("sc"),top=at*RH;if(top<sc.scrollTop+20||top>sc.scrollTop+sc.clientHeight-RH*2)sc.scrollTop=Math.max(0,top-sc.clientHeight/3)}detail(i);draw()}
function reveal(i){for(var p=R[i].p;p>=0;p=R[p].p)open[p]=1;rebuild();select(i,true)}
function toggle(i,v){if(!kids[i])return;open[i]=v==null?(open[i]?0:1):v;rebuild()}
function detail(i){var d=$("dt");d.textContent="";if(i<0){d.appendChild(el("div","mut",I.detailEmpty));return}var r=R[i];
d.appendChild(el("h2",null,r.l));if(r.kv.length){var t=el("table");r.kv.forEach(function(kv){var tr=el("tr");tr.appendChild(el("td",null,kv[0]));tr.appendChild(el("td",null,kv[1]));t.appendChild(tr)});d.appendChild(t)}
(r.pv||[]).forEach(function(p){d.appendChild(el("h3",null,p[0]));d.appendChild(el("pre",null,p[1]))});
var note=!D.content?I.noContent:r.pd?I.previewDropped:r.pc?I.childPreviewOff:"";if(note)d.appendChild(el("p","mut",note))}
function search(q){q=q.trim().toLowerCase();hits=[];hitSet={};hit=-1;if(q){for(var i=0;i<N;i++){var r=R[i],s=r.l+" "+(r.pv||[]).map(function(p){return p[1]}).join(" ");if(s.toLowerCase().indexOf(q)>=0){hits.push(i);hitSet[i]=1}}}
$("cnt").textContent=q?(hits.length?"0/"+hits.length:I.noMatch):"";draw()}
function next(dir){if(!hits.length)return;hit=(hit+dir+hits.length)%hits.length;$("cnt").textContent=(hit+1)+"/"+hits.length;reveal(hits[hit])}
function init(){document.title=D.title;$("h").textContent=D.title;$("sum").textContent=D.summary;$("meta").textContent=D.meta;$("ft").textContent=D.footer;
var q=$("q");q.placeholder=I.search;q.addEventListener("input",function(){search(q.value)});
q.addEventListener("keydown",function(e){if(e.key==="Enter"){next(e.shiftKey?-1:1);e.preventDefault()}else if(e.key==="Escape")q.blur()});
var j=$("jump");j.appendChild(el("option",null,I.jump)).value="";
R.forEach(function(r,i){if(r.t){var o=el("option",null,r.l.length>60?r.l.slice(0,59)+"\\u2026":r.l);o.value=String(i);j.appendChild(o)}});
j.addEventListener("change",function(){if(j.value!==""){var i=+j.value;open[i]=1;reveal(i);j.value=""}});
[["zo",I.zoomOut,function(){zoom(0.5)}],["zi",I.zoomIn,function(){zoom(2)}],["zf",I.zoomFit,fit],
["ea",I.expandAll,function(){open.fill(1);rebuild()}],["ca",I.collapseAll,function(){open.fill(0);rebuild()}]].forEach(function(b){var e=$(b[0]);e.textContent=b[1];e.addEventListener("click",b[2])});
["ttft","dec","tool","agent","wait","oth"].forEach(function(c){var s=el("span","lg");s.appendChild(el("span","sw sg "+c)).style.position="static";s.appendChild(document.createTextNode(I[c]));$("lg").appendChild(s)});
$("note").textContent=I.axisNote+" \\u00B7 "+I.keys;
var sc=$("sc");sc.addEventListener("scroll",draw);window.addEventListener("resize",function(){lw();if(fitted)fit();else draw()});
sc.addEventListener("wheel",function(e){if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();var x=e.clientX-sc.getBoundingClientRect().left-LW;zoom(e.deltaY<0?1.25:0.8,x)},{passive:false});
$("bd").addEventListener("click",function(e){var r=e.target.closest(".row");if(!r)return;var i=+r.dataset.i;if(e.target.dataset.t)toggle(i);select(i,false)});
$("bd").addEventListener("dblclick",function(e){var r=e.target.closest(".row");if(r)toggle(+r.dataset.i)});
document.addEventListener("keydown",function(e){if(e.target===q||e.target===j||!vis.length)return;var at=vis.indexOf(sel);
if(e.key==="/"){q.focus();e.preventDefault()}else if(e.key==="ArrowDown"){select(vis[Math.min(vis.length-1,at+1)],true);e.preventDefault()}
else if(e.key==="ArrowUp"){select(vis[Math.max(0,at-1)],true);e.preventDefault()}
else if(e.key==="ArrowRight"&&sel>=0){toggle(sel,1);e.preventDefault()}
else if(e.key==="ArrowLeft"&&sel>=0){if(kids[sel]&&open[sel])toggle(sel,0);else if(R[sel].p>=0)select(R[sel].p,true);e.preventDefault()}});
detail(-1);lw();fit()}
function zoom(f,x){fitted=0;var sc=$("sc");if(x==null)x=(sc.clientWidth-LW)/2;var t=(sc.scrollLeft+x)/scale;scale=Math.min(1e3,Math.max(1e-7,scale*f));rebuild();sc.scrollLeft=Math.max(0,t*scale-x)}
init()})();
`;

/** 页面骨架。`json` 必须已经过 `scriptSafeJson`。 */
export function renderPage(parts: { lang: string; title: string; json: string }): string {
  return `<!doctype html>
<html lang="${escapeHtml(parts.lang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(parts.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1 id="h"></h1><div class="sum" id="sum"></div><div class="mut" id="meta"></div>
<div class="bar"><input id="q" type="search" autocomplete="off"><span class="mut" id="cnt"></span>
<select id="jump"></select><button id="zo"></button><button id="zi"></button><button id="zf"></button>
<button id="ea"></button><button id="ca"></button><span id="lg"></span></div>
<div class="mut" id="note"></div></header>
<div id="sc"><div id="ru"><div class="lc"></div><div id="tk"></div></div><div id="bd"></div></div>
<section id="dt"></section>
<footer id="ft"></footer>
<script type="application/json" id="data">${parts.json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

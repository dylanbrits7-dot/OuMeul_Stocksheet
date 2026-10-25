/* Ou Meul Stock: main app. Ported from the Claude-hosted draft. It talks to a backend object (see backend.js). */
(function(){
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const DEFAULT_AREAS=["Bakery","Kitchen Prep","Meat & Dairy","Dry Goods & Spices","Fresh Produce","Bar & Drinks","Coffee & Tea","Retail Shelves","Retail Pies & Meals"];
// Walk route from the store walkthrough: kitchen → store room → shop → front counter → bar.
const LOCS=[["kitchen","Kitchen"],["dry","Store room shelves"],["cold","Store room fridges & freezers"],["shop","Shop shelves"],["front","Front counter & fridges"],["bar","Bar & coffee station"]];
const LOCNAME=Object.fromEntries([...LOCS,["sheet","GAAP sheet order"],["recount","Recount list"]]);
const LOC_BY_CODE={};
[["kitchen","2796 2878 984 1508 245 1030 900"],
 ["cold","7 2400 250 1174 229 65 734 260 186 1179 2142"],
 ["dry","901 905 911 915 936 916 917 904 906 920"],
 ["front","25 17 85 88 18 84 228 3231 14 13 30 31 3991 3990 317 27 305 306 308 349 1493 1065"],
 ["shop","1414 1220 2874 1665 1221 1413 545 1649"]].forEach(([l,s])=>s.split(" ").forEach(c=>LOC_BY_CODE[c]=l));
const LOC_BY_AREA={"Bakery":"front","Kitchen Prep":"kitchen","Meat & Dairy":"cold","Dry Goods & Spices":"dry","Fresh Produce":"cold","Bar & Drinks":"bar","Coffee & Tea":"bar","Retail Shelves":"shop","Retail Pies & Meals":"front"};
const locOf=i=>i.loc||LOC_BY_CODE[i.code]||LOC_BY_AREA[i.area]||"dry";
const rand=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);
const fmtQ=n=>n==null||n===""?"—":(Math.round(n*1000)/1000).toLocaleString("en-ZA");
const fmtR=n=>(n<0?"−":"")+"R "+Math.abs(n).toLocaleString("en-ZA",{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtSigned=n=>n>0?"+"+fmtQ(n):n<0?"−"+fmtQ(-n):"0";
const ls={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};

let db=null, user=null, downloads=null, canWrite=true;
let items=[]; // {id,...}
let waste=[]; // waste log entries {id,itemId,qty,reason,note,at,by}
let daily=[]; // GAAP Management Overview Report per trading day: daily/{YYYY-MM-DD}
let dSel=null;
let sessions=[]; // {id,...data}
let sid=ls.get("om-sid");
let tab="count", place=ls.get("om-place")||"kitchen";
const pend={}; // itemId -> {location: count} not yet saved
let flushing=false, flushTimer=null;

function toast(msg){const t=$("#toast");t.textContent=msg;t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,2600)}
function note(msg,kind){const n=$("#globalNote");if(!msg){n.hidden=true;return}n.className="note "+(kind||"info");n.style.marginTop="16px";n.textContent=msg;n.hidden=false}

const session=()=>sessions.find(s=>s.id===sid)||null;
const isOpen=()=>{const s=session();return !!s&&s.status!=="closed"};
// Counts are kept per location (session.loc[itemId][location]); an item's total is the sum of its locations.
function bucketsOf(id){const s=session();const saved=(s&&s.loc&&s.loc[id])||{};return {...saved,...(pend[id]||{})}}
function cntAt(id,b){const v=bucketsOf(id)[b];return v===undefined||v===null?null:v}
function qtyOf(id){
  const bs=bucketsOf(id), vals=Object.values(bs).filter(v=>v!=null&&!Number.isNaN(Number(v)));
  if(vals.length)return Math.round(vals.reduce((a,b)=>a+Number(b),0)*1000)/1000;
  if(Object.keys(bs).length)return null;
  const s=session(), v=s&&s.qty?s.qty[id]:undefined; return v==null?null:v;
}
// Recounts: a second count for items whose first count is far from GAAP. When present it replaces the first count.
const pendR={};
function recountOf(id){if(id in pendR)return pendR[id];const s=session();const v=s&&s.recount?s.recount[id]:undefined;return v==null?null:v}
function qtyFinal(id){const r=recountOf(id);return r!=null?r:qtyOf(id)}
let settings={recountR:100,wasteInGaap:true};
const PAY_KEYS=["roleRates","baseRate","sundayX","holidays"];
const paySettings=()=>Object.fromEntries(PAY_KEYS.filter(k=>settings[k]!==undefined).map(k=>[k,settings[k]]));
const mainSettings=()=>Object.fromEntries(Object.entries(settings).filter(([k])=>!PAY_KEYS.includes(k))); // wasteInGaap: waste is also booked in GAAP, so GAAP qty already excludes it
function needsRecount(i){
  const q=qtyOf(i.id);if(q==null)return false;
  const d=q-(i.gaap??0);if(Math.abs(d)<1e-9)return false;
  if(i.cost)return Math.abs(d*i.cost)>=settings.recountR;
  const g=Math.abs(i.gaap||0);return g>0?(Math.abs(d)/g>=.25&&Math.abs(d)>=1):Math.abs(d)>=5;
}
// Items follow the GAAP stock-take sheet order (the `order` field); areas are listed in the order they first appear on that sheet.
function sortItems(a,b){return ((a.order??1e9)-(b.order??1e9))||(a.name||"").localeCompare(b.name||"")}
function areas(){if(!items.length)return DEFAULT_AREAS.slice();const set=new Set();[...items].sort(sortItems).forEach(i=>i.area&&set.add(i.area));return [...set]}

/* ---------- stock lists ---------- */
// GAAP stock sheets (Weekly Mini, Nwabisa Mini, Bongani, Retail Crucial, …) live in lists/{id} as {name, gaapSheet, order, itemIds in sheet order}.
// "full" means every item in GAAP sheet order. A stocktake counts one or more lists (session.lists); older stocktakes have none = full.
let lists=[];
const listById=id=>lists.find(l=>l.id===id)||null;
const KIND_NAME={full:"Full stocktake",monthend:"Month-end stocktake",lists:"List count"};
const sessLists=s=>{s=s===undefined?session():s;const l=s&&Array.isArray(s.lists)?s.lists.filter(x=>x==="full"||listById(x)):[];return l.length&&!l.includes("full")?l:["full"]};
const isFullScope=()=>sessLists()[0]==="full";
function listItems(id){const l=listById(id);if(!l)return [];const m=new Map(items.map(i=>[i.id,i]));return (l.itemIds||[]).map(x=>m.get(x)).filter(Boolean)}
function scopeIds(){if(isFullScope())return null;const set=new Set();sessLists().forEach(id=>(listById(id)?.itemIds||[]).forEach(x=>set.add(x)));return set}
function scope(){const ids=scopeIds();return ids?items.filter(i=>ids.has(i.id)):items}
function scopeLabel(s){const l=sessLists(s);return l[0]==="full"?"every item":l.map(id=>listById(id)?.name||id).join(" + ")}
const isListPlace=k=>typeof k==="string"&&k.startsWith("L:");
const bucketOf=k=>isListPlace(k)?"sheet":k; // list sheets share the "sheet" bucket, so an item on two lists is never counted twice
const placeName=k=>isListPlace(k)?(listById(k.slice(2))?.name||"List"):LOCNAME[k];
function listIdx(id){const l=listById(id);const m=new Map();(l?.itemIds||[]).forEach((x,n)=>m.set(x,n));return m}

/* ---------- tabs ---------- */
document.querySelectorAll(".tabs button").forEach(b=>b.addEventListener("click",()=>{
  tab=b.dataset.tab;
  document.querySelectorAll(".tabs button").forEach(x=>x.setAttribute("aria-selected",x===b));
  document.querySelectorAll("section.view").forEach(v=>v.hidden=v.id!=="view-"+tab);
  renderAll();
}));

/* ---------- session bar ---------- */
function renderSessions(){
  const sel=$("#sessionSel");
  if(!sessions.length){sel.innerHTML='<option value="">No stocktake yet — press New stocktake</option>';}
  else sel.innerHTML=sessions.map(s=>`<option value="${esc(s.id)}"${s.id===sid?" selected":""}>${esc(s.name||"Stocktake")}${s.status==="closed"?" (final)":" (draft)"}</option>`).join("");
  const s=session(), pill=$("#sessionPill");
  subscribeDrafts();
  $("#countTools").hidden=!isOpen()||!canWrite;
  if(!isOpen()){$("#clearConfirm").hidden=true;$("#draftSavePanel").hidden=true}
  pill.className="pill "+(s&&s.status!=="closed"?"open":"closed");
  pill.textContent=!s?"none":s.status==="closed"?"Final":"Draft";
  $("#closedNote").hidden=!(s&&s.status==="closed");
  $("#closeSessionBtn").hidden=!isOpen()||!canWrite;
  $("#newSessionBtn").disabled=!canWrite;
  setDelSessBtn();
}
// Delete a whole draft stocktake (never a final one). Two taps, like the other deletes in the app.
let delSessArmed=false, delSessTimer=null;
function setDelSessBtn(){
  const b=$("#delSessionBtn");
  b.hidden=!isOpen()||!canWrite;
  if(b.hidden){delSessArmed=false;clearTimeout(delSessTimer)}
  if(!delSessArmed)b.textContent="Delete draft";
}
$("#delSessionBtn").addEventListener("click",async()=>{
  if(!isOpen()||!canWrite||!sid||!db)return;
  const b=$("#delSessionBtn");
  if(!delSessArmed){
    delSessArmed=true;
    b.textContent=`Tap again to delete (${countSnapshot().n} counted)`;
    clearTimeout(delSessTimer);delSessTimer=setTimeout(()=>{delSessArmed=false;setDelSessBtn()},4000);
    return;
  }
  delSessArmed=false;clearTimeout(delSessTimer);
  const id=sid, nm=(session()||{}).name||"Draft";
  b.disabled=true;
  // Drop any unsaved counts so a pending save can't re-create the stocktake after it is deleted.
  clearTimeout(flushTimer);
  Object.keys(pend).forEach(k=>delete pend[k]);Object.keys(pendR).forEach(k=>delete pendR[k]);
  while(flushing)await new Promise(r=>setTimeout(r,50));
  Object.keys(pend).forEach(k=>delete pend[k]);Object.keys(pendR).forEach(k=>delete pendR[k]);
  try{
    for(let guard=0;guard<20;guard++){
      const snap=await db.collection("sessions/"+id+"/drafts").limit(500).get();
      if(!snap.docs.length)break;
      for(const d of snap.docs)await db.doc("sessions/"+id+"/drafts/"+d.id).delete();
    }
    await db.doc("sessions/"+id).delete();
    toast(`Deleted “${nm}”`);
  }catch(e){writeErr(e)}
  finally{b.disabled=false;setDelSessBtn()}
});
$("#sessionSel").addEventListener("change",e=>{sid=e.target.value;ls.set("om-sid",sid);delSessArmed=false;setDelSessBtn();renderAll()});
// New stocktake: Monday → full, last day of the month → month-end, any other day → pick lists.
let newSel=new Set(), nameTouched=false;
function newDefaultName(){
  const d=new Date(), k=$("#newKind").value;
  const day=d.toLocaleDateString("en-ZA",{weekday:"short",day:"numeric",month:"short",year:"numeric"}).replace(",","");
  if(k==="monthend")return "Month-end "+d.toLocaleDateString("en-ZA",{month:"long",year:"numeric"});
  if(k==="full")return "Full stocktake "+day;
  const names=lists.filter(l=>newSel.has(l.id)).map(l=>l.name);
  return (names.length?names.join(" + "):"List count")+" "+day;
}
function renderNewLists(){
  const k=$("#newKind").value;$("#newListsWrap").hidden=k!=="lists";
  $("#newLists").innerHTML=lists.length?lists.map(l=>`<button class="chip" data-l="${esc(l.id)}" aria-pressed="${newSel.has(l.id)}">${esc(l.name)}<small class="num">${(l.itemIds||[]).length}</small></button>`).join("")
    :'<span class="muted">No stock lists loaded yet.</span>';
  if(!nameTouched)$("#newSessionName").value=newDefaultName();
}
$("#newSessionBtn").addEventListener("click",()=>{
  const d=new Date(), last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate()===d.getDate();
  $("#newKind").value=last?"monthend":d.getDay()===1?"full":"lists";
  newSel=new Set();nameTouched=false;renderNewLists();
  $("#newSessionPanel").hidden=false;$("#newKind").focus();
});
$("#newKind").addEventListener("change",renderNewLists);
$("#newLists").addEventListener("click",e=>{const b=e.target.closest(".chip");if(!b)return;const id=b.dataset.l;newSel.has(id)?newSel.delete(id):newSel.add(id);renderNewLists()});
$("#newSessionName").addEventListener("input",()=>nameTouched=true);
$("#cancelSessionBtn").addEventListener("click",()=>$("#newSessionPanel").hidden=true);
$("#createSessionBtn").addEventListener("click",async()=>{
  if(!db)return;const kind=$("#newKind").value;
  const chosen=kind==="lists"?lists.filter(l=>newSel.has(l.id)).map(l=>l.id):["full"];
  if(!chosen.length){toast("Tick at least one stock list");return}
  const id=rand();
  try{await db.doc("sessions/"+id).set({name:$("#newSessionName").value.trim()||newDefaultName(),kind,lists:chosen,status:"open",startedAt:Date.now(),qty:{},loc:{}});
    sid=id;ls.set("om-sid",sid);place=chosen[0]==="full"?"kitchen":"L:"+chosen[0];ls.set("om-place",place);
    $("#newSessionPanel").hidden=true;toast("Stocktake started");}
  catch(e){writeErr(e)}
});

/* ---------- count view ---------- */
const recountItems=()=>scope().filter(i=>needsRecount(i)||recountOf(i.id)!=null);
const placeItems=k=>isListPlace(k)?listItems(k.slice(2)):k==="sheet"?scope():k==="recount"?recountItems():scope().filter(i=>locOf(i)===k);
const doneAt=(i,k)=>k==="sheet"||isListPlace(k)?qtyOf(i.id)!=null:k==="recount"?recountOf(i.id)!=null:cntAt(i.id,k)!=null;
const valAt=id=>place==="recount"?recountOf(id):cntAt(id,bucketOf(place));
function chipKeys(){
  const locs=LOCS.map(l=>l[0]);
  if(isFullScope())return [...locs,"sheet","recount"];
  const sc=scope();
  return [...sessLists().map(id=>"L:"+id),...locs.filter(k=>sc.some(i=>locOf(i)===k)),"recount"];
}
function renderChips(){
  const list=chipKeys();
  if(!list.includes(place))place=list[0];
  const s=session();
  $("#scopeLine").hidden=!s;
  if(s)$("#scopeLine").innerHTML=`<b>${esc(KIND_NAME[s.kind]||(isFullScope()?"Full stocktake":"List count"))}</b> · ${esc(scopeLabel())} · <span class="num">${scope().length}</span> items`;
  $("#areaChips").innerHTML=list.map(k=>{
    const its=placeItems(k), done=its.filter(i=>doneAt(i,k)).length;
    const pre=k==="sheet"||isListPlace(k)?"":k==="recount"?'<b class="num">⚑</b> ':`<b class="num">${LOCS.findIndex(l=>l[0]===k)+1}</b> `;
    return `<button class="chip${k==="recount"&&its.length>done?" flagchip":""}${isListPlace(k)?" listchip":""}" data-a="${esc(k)}" aria-pressed="${k===place}">${pre}${esc(placeName(k))}<small class="num">${done}/${its.length}</small></button>`}).join("");
  $("#placeHint").textContent=isListPlace(place)
    ?`The ${placeName(place)} sheet in GAAP order. Count everything on it wherever it's stored. Others counting at the same time pick their own list above.`
    :place==="sheet"
    ?"Every item in GAAP sheet order. Totals include what was counted in each location."
    :place==="recount"
    ?`Items whose first count is far from GAAP (over R ${settings.recountR} in value, or 25% when there's no cost yet). Count each one again, everywhere it's stored, without looking at the first count. The recount replaces the first count in the variance.`
    :"Count only what is in "+LOCNAME[place].toLowerCase()+". Found something that lives elsewhere? Search for it and count it here; the app adds the locations together.";
}
$("#areaChips").addEventListener("click",e=>{const b=e.target.closest(".chip");if(!b)return;place=b.dataset.a;ls.set("om-place",place);renderChips();renderCountList()});
$("#search").addEventListener("input",()=>renderCountList());
$("#hideCounted").addEventListener("change",()=>renderCountList());
$("#showGaap").addEventListener("change",()=>renderCountList());

function visibleItems(){
  const q=$("#search").value.trim().toLowerCase(), hide=$("#hideCounted").checked;
  const match=i=>(i.name||"").toLowerCase().includes(q)||(i.code||"").toLowerCase().includes(q);
  let list;
  const sc=scope();
  if(isListPlace(place)){
    list=placeItems(place).filter(i=>!q||match(i));
    if(hide)list=list.filter(i=>!doneAt(i,place));
    return list; // already in this list's sheet order
  }
  if(place==="sheet")list=sc.filter(i=>!q||match(i));
  else if(place==="recount")list=recountItems().filter(i=>!q||match(i));
  else if(q)list=sc.filter(match); // search covers every item in this stocktake, so stock found in the wrong place can still be counted here
  else list=sc.filter(i=>locOf(i)===place||cntAt(i.id,place)!=null);
  if(hide)list=list.filter(i=>!doneAt(i,place));
  return list.sort(sortItems);
}
function renderProgress(){
  const its=placeItems(place), done=its.filter(i=>doneAt(i,place)).length;
  $("#progLabel").textContent=place==="sheet"?"Counted, all items":isListPlace(place)?"Counted on "+placeName(place):"Counted in "+LOCNAME[place];
  $("#progText").textContent=`${done} / ${its.length}`;
  $("#progBar").style.width=its.length?(done/its.length*100)+"%":"0";
}
function rowMeta(i){
  const showG=$("#showGaap").checked, home=locOf(i);
  if(place==="recount"){
    const rc=recountOf(i.id);
    return `<span class="mono">${esc(i.code||"")}</span>${i.code?" · ":""}${esc(i.unit||"each")} · ${esc(LOCNAME[home])}`+
      (rc!=null?` · first count <b class="num">${fmtQ(qtyOf(i.id))}</b>`:"")+(showG?` · GAAP <b class="num">${fmtQ(i.gaap)}</b>`:"");
  }
  const bk=bucketOf(place);
  const where=bk==="sheet"?LOCNAME[home]:(home!==place?"usually "+LOCNAME[home]:"");
  const others=Object.entries(bucketsOf(i.id)).filter(([k,v])=>k!==bk&&v!=null).map(([k,v])=>`${fmtQ(v)} in ${esc(k==="sheet"?"sheet count":LOCNAME[k]||k)}`);
  const tot=qtyOf(i.id);
  return `<span class="mono">${esc(i.code||"")}</span>${i.code?" · ":""}${esc(i.unit||"each")}${where?" · "+esc(where):""}${showG?` · GAAP <b class="num">${fmtQ(i.gaap)}</b>`:""}`+
    (others.length?`<div class="also">Also ${others.join(", ")} · total <b class="num">${fmtQ(tot)}</b></div>`:"");
}
function renderCountList(){
  renderProgress();
  const el=$("#countList");
  if(!items.length){el.innerHTML='<div class="empty">No items yet. Import your GAAP stock list on the <b>Items</b> tab, or add items one by one.</div>';return}
  if(!session()){el.innerHTML='<div class="empty">Press <b>New stocktake</b> above to start counting.</div>';return}
  const vis=visibleItems();
  if(!vis.length){el.innerHTML='<div class="empty">Nothing to show here. Clear the search or untick “Hide counted”.</div>';return}
  const lock=!isOpen()||!canWrite;
  el.innerHTML=vis.map(i=>{const q=valAt(i.id);return `<div class="crow${q!=null?" done":""}" data-id="${esc(i.id)}">
    <div><div class="nm">${esc(i.name)}${i.example?' <span class="tag ex">example</span>':""}</div>
    <div class="meta">${rowMeta(i)}</div></div>
    <div class="stepper"><button data-d="-1" aria-label="One less" ${lock?"disabled":""}>−</button>
    <input type="number" inputmode="decimal" step="any" min="0" value="${q==null?"":q}" placeholder="–" aria-label="Count for ${esc(i.name)}" ${lock?"disabled":""}>
    <button data-d="1" aria-label="One more" ${lock?"disabled":""}>+</button></div></div>`}).join("");
}
function patchRow(id){
  const row=document.querySelector(`.crow[data-id="${CSS.escape(id)}"]`);if(!row)return;
  const q=valAt(id), inp=row.querySelector("input"), it=items.find(i=>i.id===id);
  row.classList.toggle("done",q!=null);
  if(document.activeElement!==inp)inp.value=q==null?"":q;
  if(it)row.querySelector(".meta").innerHTML=rowMeta(it);
}
$("#countList").addEventListener("click",e=>{
  const b=e.target.closest("button[data-d]");if(!b)return;
  const id=b.closest(".crow").dataset.id;const cur=valAt(id)||0;
  setCount(id,Math.max(0,Math.round((cur+Number(b.dataset.d))*1000)/1000));patchRow(id);
});
$("#countList").addEventListener("input",e=>{
  if(e.target.tagName!=="INPUT")return;const id=e.target.closest(".crow").dataset.id;
  const v=e.target.value.trim();setCount(id,v===""?null:Math.max(0,Number(v)));
  e.target.closest(".crow").classList.toggle("done",v!=="");
});
function setCount(id,val){
  if(!isOpen()||!canWrite)return;
  if(Number.isNaN(val))return;
  if(place==="recount")pendR[id]=val;
  else pend[id]={...(pend[id]||{}),[bucketOf(place)]:val};
  renderProgress();renderChips();
  clearTimeout(flushTimer);flushTimer=setTimeout(flush,400);
}
const hasPending=()=>Object.keys(pend).length||Object.keys(pendR).length;
async function flush(){
  if(flushing){flushTimer=setTimeout(flush,300);return}
  const ids=Object.keys(pend), rids=Object.keys(pendR);if((!ids.length&&!rids.length)||!db||!sid)return;
  const body={updatedAt:Date.now()}, locBatch={}, recBatch={};
  if(ids.length){const qtyBatch={};ids.forEach(id=>{locBatch[id]={...pend[id]};qtyBatch[id]=qtyOf(id)});body.loc=locBatch;body.qty=qtyBatch}
  if(rids.length){rids.forEach(id=>recBatch[id]=pendR[id]);body.recount=recBatch}
  flushing=true;
  try{await db.doc("sessions/"+sid).update(body);
    ids.forEach(id=>{const p=pend[id];if(!p)return;for(const b in locBatch[id])if(p[b]===locBatch[id][b])delete p[b];if(!Object.keys(p).length)delete pend[id]});
    rids.forEach(id=>{if(pendR[id]===recBatch[id])delete pendR[id]});}
  catch(e){writeErr(e);}
  finally{flushing=false}
  if(hasPending())flushTimer=setTimeout(flush,600);
}
window.addEventListener("pagehide",()=>{if(hasPending())flush()});

/* ---------- variance ---------- */
// Waste counts against the period since the previous final stocktake, up to this one's finalising (or now).
function wastePeriod(){
  const s=session();if(!s)return {from:0,to:Date.now()+1};
  const prev=sessions.filter(x=>x.id!==s.id&&x.status==="closed"&&x.closedAt&&x.closedAt<=(s.startedAt||Date.now())).sort((a,b)=>b.closedAt-a.closedAt)[0];
  return {from:prev?prev.closedAt:0,to:s.status==="closed"&&s.closedAt?s.closedAt:Date.now()+1,prev};
}
function wasteByItem(from,to){const m={};waste.forEach(w=>{if(w.at>=from&&w.at<to)m[w.itemId]=(m[w.itemId]||0)+Number(w.qty||0)});return m}
function varianceRows(){
  const s=session(); if(!s)return [];
  const closed=s.status==="closed", p=wastePeriod(), wm=wasteByItem(p.from,p.to);
  return scope().map(i=>{
    const q1=qtyOf(i.id), rc=recountOf(i.id), q=rc!=null?rc:q1;
    const g=closed&&s.gaap&&i.id in s.gaap?s.gaap[i.id]:(i.gaap??0);
    const c=closed&&s.cost&&i.id in s.cost?s.cost[i.id]:(i.cost??0);
    const d=q==null?null:Math.round((q-(g||0))*1000)/1000;
    const w=Math.round((wm[i.id]||0)*1000)/1000;
    // If waste is booked in GAAP it is already out of GAAP's figure, so the whole shortage is unexplained.
    const u=d==null||d>=0?0:settings.wasteInGaap?d:Math.min(0,Math.round((d+w)*1000)/1000);
    return {i,q,q1,rc,g:g||0,c:c||0,d,v:d==null?0:d*(c||0),w,wv:w*(c||0),u,uv:u*(c||0),flag:!closed&&rc==null&&needsRecount(i)};
  });
}
function renderVariance(){
  const sel=$("#varArea"), cur=sel.value||"All";
  const sl=isFullScope()?[]:sessLists();
  sel.innerHTML=`<option value="All">All${isFullScope()?"":" in this stocktake"}</option>`+(sl.length>1?sl.map(id=>`<option value="L:${esc(id)}">List: ${esc(listById(id)?.name||id)}</option>`).join(""):"")+areas().map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join("");
  sel.value=[...sel.options].some(o=>o.value===cur)?cur:"All";
  if(document.activeElement!==$("#recountR"))$("#recountR").value=settings.recountR;
  const s=session();
  if(!s){$("#varTiles").innerHTML="";$("#varBody").innerHTML='<tr><td colspan="9" class="empty">Start a stocktake to see variances.</td></tr>';return}
  const a=sel.value, f=$("#varFilter").value;
  const inL=isListPlace(a)?new Set(listById(a.slice(2))?.itemIds||[]):null;
  let rows=varianceRows().filter(r=>a==="All"||(inL?inL.has(r.i.id):r.i.area===a));
  const counted=rows.filter(r=>r.q!=null), withVar=counted.filter(r=>r.d!==0), flagged=rows.filter(r=>r.flag);
  const short=withVar.filter(r=>r.d<0).reduce((t,r)=>t+r.v,0), over=withVar.filter(r=>r.d>0).reduce((t,r)=>t+r.v,0);
  const wasteV=rows.reduce((t,r)=>t+r.wv,0), unexp=rows.reduce((t,r)=>t+r.uv,0);
  const p=wastePeriod();
  $("#varTiles").innerHTML=`
    <div class="tile"><div class="lbl">Counted</div><div class="v">${counted.length}<span class="muted" style="font-size:1rem"> / ${rows.length}</span></div></div>
    <div class="tile short"><div class="lbl">Missing stock</div><div class="v">${fmtR(short)}</div></div>
    <div class="tile"><div class="lbl">Waste logged${settings.wasteInGaap?" (also in GAAP)":""}</div><div class="v">${fmtR(-wasteV)}</div></div>
    <div class="tile short"><div class="lbl">Unexplained loss</div><div class="v">${fmtR(unexp)}</div></div>
    <div class="tile over"><div class="lbl">Extra stock</div><div class="v">${fmtR(over)}</div></div>
    <div class="tile${flagged.length?" flagtile":""}"><div class="lbl">To recount</div><div class="v">${flagged.length}</div></div>
    <p class="muted" style="grid-column:1/-1;margin:0;font-size:.85rem">Waste period: ${p.from?"since "+esc(p.prev.name||"the last final count")+" ("+new Date(p.from).toLocaleDateString("en-ZA")+")":"everything logged so far"}${s.status==="closed"?" up to finalising":" up to now"}.${settings.wasteInGaap?" Waste is also booked in GAAP, so GAAP's figure already excludes it: it's shown for reference and the whole shortage counts as unexplained.":" Waste is not booked in GAAP, so it's taken off the shortage."}${items.some(i=>i.cost)?"":" Rand values show once items have a unit cost."}</p>`;
  if(f==="var")rows=withVar;else if(f==="recount")rows=rows.filter(r=>r.flag||r.rc!=null);else if(f==="all")rows=counted;else rows=rows.filter(r=>r.q==null);
  rows.sort((x,y)=>(y.flag-x.flag)||Math.abs(y.v)-Math.abs(x.v)||sortItems(x.i,y.i));
  $("#varBody").innerHTML=rows.length?rows.map(r=>`<tr class="${r.d<0?"short":r.d>0?"over":""}">
    <td><b>${esc(r.i.name)}</b>${r.flag?' <span class="tag flag">⚑ recount</span>':r.rc!=null?` <span class="tag">recounted · first ${fmtQ(r.q1)}</span>`:""}<br><span class="mono muted">${esc(r.i.code||"")}</span></td>
    <td>${esc(r.i.area||"")}</td><td class="n">${fmtQ(r.g)}</td><td class="n">${fmtQ(r.q)}</td>
    <td class="n d">${r.d==null?"—":fmtSigned(r.d)}</td><td class="n">${r.w?fmtQ(r.w):"—"}</td><td class="n">${fmtR(r.c)}</td>
    <td class="n d">${r.d==null?"—":fmtR(r.v)}</td><td class="n${r.u<0?" ux":""}">${r.d==null?"—":r.u<0?fmtR(r.uv):"—"}</td></tr>`).join("")
    :`<tr><td colspan="9" class="empty">${f==="var"?"No variances in what has been counted so far.":f==="recount"?"Nothing needs a recount.":f==="uncounted"?"Everything here has been counted.":"Nothing counted yet."}</td></tr>`;
}
$("#varArea").addEventListener("change",renderVariance);
$("#varFilter").addEventListener("change",renderVariance);
$("#recountR").addEventListener("change",async e=>{
  const v=Math.max(0,Number(e.target.value)||0);settings.recountR=v;renderVariance();
  if(db&&canWrite)try{await db.doc("settings/main").set(mainSettings())}catch(err){writeErr(err)}
});
$("#closeSessionBtn").addEventListener("click",()=>{
  const n=scope().filter(i=>recountOf(i.id)==null&&needsRecount(i)).length;
  $("#closeRecountWarn").innerHTML=n?`<b>${n} item${n>1?"s are":" is"} flagged for a recount and not recounted yet</b> (see the ⚑ Recount list on the Count tab). `:"";
  $("#closeConfirm").hidden=false;
});
$("#closeNo").addEventListener("click",()=>$("#closeConfirm").hidden=true);
$("#closeYes").addEventListener("click",async()=>{
  await flush();const gaap={},cost={};items.forEach(i=>{gaap[i.id]=i.gaap??0;cost[i.id]=i.cost??0});
  try{await db.doc("sessions/"+sid).update({status:"closed",closedAt:Date.now(),gaap,cost});$("#closeConfirm").hidden=true;toast("Final count saved and locked")}
  catch(e){writeErr(e)}
});

/* ---------- clear all & drafts ---------- */
// The current counts as one snapshot: per-location buckets plus each item's total.
function countSnapshot(){
  const loc={},qty={},recount={};let n=0;
  items.forEach(i=>{
    const b={};Object.entries(bucketsOf(i.id)).forEach(([k,v])=>{if(v!=null&&!Number.isNaN(Number(v)))b[k]=Number(v)});
    const q=qtyOf(i.id), r=recountOf(i.id);
    if(Object.keys(b).length)loc[i.id]=b;
    if(q!=null){qty[i.id]=q;n++}
    if(r!=null)recount[i.id]=r;
  });
  return {loc,qty,recount,n};
}
// Replace the whole stocktake document so removed counts really disappear (update() would merge them back).
async function replaceCounts(loc,qty,recount={}){
  const s=session();if(!s)return;
  const {id,...rest}=s;
  clearTimeout(flushTimer);Object.keys(pend).forEach(k=>delete pend[k]);Object.keys(pendR).forEach(k=>delete pendR[k]);
  await db.doc("sessions/"+sid).set({...rest,loc,qty,recount,updatedAt:Date.now()});
}
$("#clearAllBtn").addEventListener("click",()=>{
  const s=session();if(!s)return;
  $("#clearName").textContent=s.name||"this stocktake";
  $("#clearConfirm").hidden=false;$("#draftSavePanel").hidden=true;
});
$("#clearNo").addEventListener("click",()=>$("#clearConfirm").hidden=true);
$("#clearYes").addEventListener("click",async()=>{
  if(!isOpen()||!canWrite)return;
  try{await replaceCounts({},{});$("#clearConfirm").hidden=true;renderChips();renderCountList();toast("All counts cleared")}
  catch(e){writeErr(e)}
});

let drafts=[], draftUnsub=null, draftSid=null, restoreArmed=null, delArmed2=null;
function subscribeDrafts(){
  if(!db||draftSid===sid)return;
  draftSid=sid; if(draftUnsub){draftUnsub();draftUnsub=null} drafts=[]; renderDrafts();
  if(!sid)return;
  draftUnsub=db.collection("sessions/"+sid+"/drafts").orderBy("savedAt","desc").limit(50)
    .onSnapshot(snap=>{drafts=snap.docs.map(d=>({id:d.id,...d.data()}));renderDrafts()},
      e=>note("Drafts stopped updating ("+e.code+"). Reload the page.","err"));
}
function renderDrafts(){
  $("#draftCount").textContent=drafts.length;
  const el=$("#draftList");if(!el)return;
  if(!drafts.length){el.innerHTML='<p class="muted" style="margin:0">No drafts saved yet. Press <b>Save draft</b> to keep a copy of the counts as they are now.</p>';return}
  el.innerHTML=drafts.map(d=>{
    const when=new Date(d.savedAt||0).toLocaleString("en-ZA",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
    return `<div class="drow" data-id="${esc(d.id)}"><div class="dn"><b>${esc(d.name||"Draft")}</b><span class="muted" style="font-size:.85rem">${esc(when)} · ${d.counted||0} items counted</span></div>
      <button class="btn" data-act="restore">${restoreArmed===d.id?"Tap again to replace current counts":"Restore"}</button>
      <button class="btn ghost" data-act="del">${delArmed2===d.id?"Tap again to delete":"Delete"}</button></div>`}).join("");
}
$("#showDraftsBtn").addEventListener("click",()=>{const p=$("#draftsPanel");p.hidden=!p.hidden;$("#showDraftsBtn").setAttribute("aria-expanded",String(!p.hidden));renderDrafts()});
$("#saveDraftBtn").addEventListener("click",()=>{
  const d=new Date();
  $("#draftName").value="Draft "+d.toLocaleString("en-ZA",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
  $("#draftSavePanel").hidden=false;$("#clearConfirm").hidden=true;$("#draftName").focus();
});
$("#draftSaveNo").addEventListener("click",()=>$("#draftSavePanel").hidden=true);
$("#draftSaveYes").addEventListener("click",async()=>{
  if(!db||!sid)return;
  const snap=countSnapshot();
  try{await db.collection("sessions/"+sid+"/drafts").doc(rand()).set({name:$("#draftName").value.trim()||"Draft",savedAt:Date.now(),counted:snap.n,loc:snap.loc,qty:snap.qty,recount:snap.recount});
    $("#draftSavePanel").hidden=true;toast(`Draft saved (${snap.n} items)`);}
  catch(e){/^invalid[-_]argument$/.test(e&&e.code)&&canWrite?toast("Couldn't save the draft: it may be too large. Try again after finalising some areas."):writeErr(e)}
});
$("#draftList").addEventListener("click",async e=>{
  const b=e.target.closest("button[data-act]");if(!b)return;
  const id=b.closest(".drow").dataset.id, d=drafts.find(x=>x.id===id);if(!d)return;
  if(b.dataset.act==="restore"){
    if(!isOpen()){toast("This stocktake is final, so drafts can't be restored into it");return}
    if(restoreArmed!==id){restoreArmed=id;delArmed2=null;renderDrafts();return}
    restoreArmed=null;
    try{await replaceCounts(d.loc||{},d.qty||{},d.recount||{});renderChips();renderCountList();renderDrafts();toast(`Restored “${d.name||"Draft"}”`)}
    catch(err){writeErr(err)}
  }else{
    if(delArmed2!==id){delArmed2=id;restoreArmed=null;renderDrafts();return}
    delArmed2=null;
    try{await db.doc("sessions/"+sid+"/drafts/"+id).delete();toast("Draft deleted")}catch(err){writeErr(err)}
  }
});
const csvCell=v=>{v=v==null?"":String(v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
// Every table download is saved as an Excel workbook (.xlsx), built here with no outside library.
// Numbers stay numbers so Excel can add them up; the first row of each sheet is bold and frozen.
const xlNum=v=>typeof v==="string"&&/^-?\d+(\.\d+)?$/.test(v.trim())&&!/^0\d/.test(v.trim())?Number(v):v;
const CRC_T=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
function crc32(b){let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=CRC_T[(c^b[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0}
function zipStore(files){ // files: [[name, Uint8Array]] -> Uint8Array (stored, no compression)
  const enc=new TextEncoder(),parts=[],cen=[];let off=0;
  const u16=(a,v)=>a.push(v&255,(v>>>8)&255),u32=(a,v)=>a.push(v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255);
  files.forEach(([name,data])=>{const nb=enc.encode(name),crc=crc32(data),h=[];
    u32(h,0x04034b50);u16(h,20);u16(h,0x0800);u16(h,0);u16(h,0);u16(h,0x21);u32(h,crc);u32(h,data.length);u32(h,data.length);u16(h,nb.length);u16(h,0);
    const lh=new Uint8Array([...h,...nb]);parts.push(lh,data);
    const c=[];u32(c,0x02014b50);u16(c,20);u16(c,20);u16(c,0x0800);u16(c,0);u16(c,0);u16(c,0x21);u32(c,crc);u32(c,data.length);u32(c,data.length);u16(c,nb.length);u16(c,0);u16(c,0);u16(c,0);u16(c,0);u32(c,0);u32(c,off);
    cen.push(new Uint8Array([...c,...nb]));off+=lh.length+data.length});
  const cl=cen.reduce((t,x)=>t+x.length,0),e=[];u32(e,0x06054b50);u16(e,0);u16(e,0);u16(e,files.length);u16(e,files.length);u32(e,cl);u32(e,off);u16(e,0);
  const all=[...parts,...cen,new Uint8Array(e)],out=new Uint8Array(all.reduce((t,x)=>t+x.length,0));let p=0;all.forEach(x=>{out.set(x,p);p+=x.length});return out;
}
const xe=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,"");
function colName(i){let s="";i++;while(i>0){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26)}return s}
function xlsxBytes(sheets){ // sheets: [[name, rows]]
  const enc=new TextEncoder(),names=[];
  const sheetXml=rows=>{rows=rows.map(r=>r.map(xlNum));const n=Math.max(1,...rows.map(r=>r.length));
    const w=[...Array(n)].map((_,c)=>Math.min(45,Math.max(8,...rows.map(r=>String(r[c]??"").length))+2));
    const body=rows.map((r,ri)=>`<row r="${ri+1}">`+r.map((v,ci)=>{if(v==null||v==="")return"";const ref=colName(ci)+(ri+1),st=ri===0?' s="1"':"";
      return typeof v==="number"&&Number.isFinite(v)?`<c r="${ref}"${st}><v>${v}</v></c>`:`<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xe(v)}</t></is></c>`}).join("")+"</row>").join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${w.map((x,i)=>`<col min="${i+1}" max="${i+1}" width="${x}" customWidth="1"/>`).join("")}</cols><sheetData>${body}</sheetData></worksheet>`};
  const files=[],used=new Set();
  sheets.forEach(([name,rows],i)=>{let nm=String(name||"Sheet").replace(/[\\\/?*\[\]:]/g," ").slice(0,31).trim()||"Sheet"+(i+1);while(used.has(nm.toLowerCase()))nm=(nm.slice(0,28)+" "+(i+1));used.add(nm.toLowerCase());names.push(nm);
    files.push([`xl/worksheets/sheet${i+1}.xml`,enc.encode(sheetXml(rows))])});
  const ct=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
  const rels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wb=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n,i)=>`<sheet name="${xe(n)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("")}</sheets></workbook>`;
  const wbr=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("")}<Relationship Id="rId${names.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const st=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return zipStore([["[Content_Types].xml",enc.encode(ct)],["_rels/.rels",enc.encode(rels)],["xl/workbook.xml",enc.encode(wb)],["xl/_rels/workbook.xml.rels",enc.encode(wbr)],["xl/styles.xml",enc.encode(st)],...files]);
}
async function offerXlsx(filename,sheets){
  if(!downloads){toast("Downloads aren't available in this view");return}
  let data;try{data=xlsxBytes(sheets)}catch(e){toast("Couldn't build the Excel file");return}
  try{await downloads.save({filename:filename.replace(/\.(csv|xlsx)$/i,"")+".xlsx",data})}
  catch(e){if(e&&e.code!=="declined")toast(e.code==="rate_limited"?"A download is already waiting for you":"Couldn't offer the file: "+(e.message||e.code))}
}
async function offer(filename,data){
  if(!downloads){toast("Downloads aren't available in this view");return}
  if(/\.csv$/i.test(filename)&&typeof data==="string"){
    const title=filename.replace(/\.csv$/i,"").replace(/[-_]+/g," ").replace(/^ou meul /i,"").replace(/^./,c=>c.toUpperCase()).slice(0,31)||"Sheet1";
    return offerXlsx(filename,[[title,parseCSV(data)]]);
  }
  try{await downloads.save({filename,data})}
  catch(e){if(e&&e.code!=="declined")toast(e.code==="rate_limited"?"A download is already waiting for you":"Couldn't offer the file: "+(e.message||e.code))}
}
const slug=s=>(s||"stocktake").replace(/[^\w-]+/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"");
$("#dlVarCsv").addEventListener("click",()=>{
  const s=session();if(!s)return;
  const lines=[["Code","Item","Area","Unit","GAAP qty","First count","Recount","Counted (final)","Variance","Waste logged","Unit cost","Value variance","Unexplained value"].join(",")];
  varianceRows().sort((x,y)=>sortItems(x.i,y.i)).forEach(r=>lines.push([r.i.code,r.i.name,r.i.area,r.i.unit,r.g,r.q1??"",r.rc??"",r.q??"",r.d??"",r.w||"",r.c.toFixed(2),r.d==null?"":r.v.toFixed(2),r.d==null?"":r.uv.toFixed(2)].map(csvCell).join(",")));
  offer(slug(s.name)+"-variance.csv",lines.join("\r\n"));
});

/* ---------- sheets ---------- */
// Sheet groups: by walk-route location, by category, or one list in GAAP order. Each group = {key, label, items}.
let sheetSel=null, sheetMode="loc";
function sheetGroups(){
  if(isListPlace(sheetMode)){const l=listById(sheetMode.slice(2));return l?[{key:sheetMode,label:l.name,items:listItems(l.id)}]:[]}
  if(sheetMode==="lists")return sessLists().filter(id=>id!=="full").map(id=>({key:"L:"+id,label:listById(id)?.name||id,items:listItems(id)}));
  const sc=scope();
  if(sheetMode==="sheet")return [{key:"sheet",label:isFullScope()?"Full stock list":scopeLabel(),items:[...sc].sort(sortItems)}];
  if(sheetMode==="area")return areas().map(a=>({key:a,label:a,items:sc.filter(i=>i.area===a).sort(sortItems)}));
  return LOCS.map(([k,n],x)=>({key:k,label:`${x+1}. ${n}`,items:sc.filter(i=>locOf(i)===k).sort(sortItems)}));
}
function renderSheets(){
  const gsel=$("#sheetGroup"), full=isFullScope();
  const opts=[...(full?[]:[["lists","This stocktake's lists, one page each"]]),["loc","Location (walk route)"],["area","Category"],["sheet",full?"One list in GAAP sheet order":"One list, everything in this stocktake"],...lists.map(l=>["L:"+l.id,"GAAP sheet: "+l.name])];
  if(!opts.some(o=>o[0]===sheetMode)){sheetMode=full?"loc":"lists";sheetSel=null}
  gsel.innerHTML=opts.map(([v,t])=>`<option value="${esc(v)}">${esc(t)}</option>`).join("");gsel.value=sheetMode;
  const gs=sheetGroups(); if(!sheetSel)sheetSel=new Set(gs.map(g=>g.key));
  $("#sheetAreas").innerHTML=gs.map(g=>`<button class="chip" data-a="${esc(g.key)}" aria-pressed="${sheetSel.has(g.key)}">${esc(g.label)}<small class="num">${g.items.length}</small></button>`).join("");
}
$("#sheetGroup").addEventListener("change",e=>{sheetMode=e.target.value;sheetSel=null;renderSheets()});
$("#sheetAreas").addEventListener("click",e=>{const b=e.target.closest(".chip");if(!b)return;const a=b.dataset.a;sheetSel.has(a)?sheetSel.delete(a):sheetSel.add(a);renderSheets()});
function chosenGroups(){return sheetGroups().filter(g=>sheetSel&&sheetSel.has(g.key)&&g.items.length)}
const sheetQty=(i,g)=>sheetMode==="loc"?cntAt(i.id,g.key):qtyOf(i.id);
$("#dlSheetHtml").addEventListener("click",()=>{
  const gs=chosenGroups();if(!gs.length){$("#sheetMsg").textContent="Pick at least one page that has items.";return}
  const g=$("#sheetGaap").checked, fill=$("#sheetCounted").checked, s=session();
  const date=new Date().toLocaleDateString("en-ZA",{day:"numeric",month:"long",year:"numeric"});
  const pages=gs.map(grp=>{const its=grp.items, a=grp.label;
    return `<section><header><div><h1>${esc(a)}</h1><p>Ou Meul Pinelands · ${esc(s?s.name:"Stock count")} · ${date}</p></div><p class="sign">Counted by ____________________ &nbsp; Checked by ____________________</p></header>
    <table><thead><tr><th>#</th><th>Code</th><th>Item</th><th>Unit</th>${g?'<th class="n">GAAP</th>':""}<th class="c">Count</th><th class="c">Recount</th></tr></thead><tbody>
    ${its.map((i,k)=>{const q=fill?sheetQty(i,grp):null;return `<tr><td>${k+1}</td><td class="m">${esc(i.code||"")}</td><td>${esc(i.name)}</td><td>${esc(i.unit||"each")}</td>${g?`<td class="n">${fmtQ(i.gaap)}</td>`:""}<td class="c">${q==null?"":fmtQ(q)}</td><td class="c"></td></tr>`}).join("")}
    </tbody></table><p class="foot">${its.length} items · Write clearly; cross out and initial any corrections.</p></section>`}).join("");
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>Count sheets — ${esc(s?s.name:"Ou Meul")}</title><style>
  @page{size:A4;margin:12mm}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0}
  section{page-break-after:always;padding:8mm 0}section:last-child{page-break-after:auto}
  header{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:8px}
  h1{font-size:20pt;margin:0;text-transform:uppercase;letter-spacing:.04em}p{margin:2px 0;font-size:9pt}.sign{font-size:9pt;text-align:right}
  table{width:100%;border-collapse:collapse;font-size:10pt}th,td{border:1px solid #888;padding:5px 6px;text-align:left}
  th{background:#eee;font-size:8pt;text-transform:uppercase;letter-spacing:.05em}td.c{width:22mm;text-align:center}td.n,th.n{text-align:right}
  td.m{font-family:monospace;font-size:9pt}tr{page-break-inside:avoid}.foot{margin-top:6px;color:#555}
  @media screen{body{max-width:900px;margin:20px auto;padding:0 16px}.hint{background:#ffe;padding:8px 12px;border:1px solid #cc9}}
  @media print{.hint{display:none}}</style></head><body><p class="hint">Press Ctrl+P (or Share → Print on a phone) to print.</p>${pages}</body></html>`;
  offer("count-sheets-"+slug(s?s.name:"ou-meul")+".html",html);$("#sheetMsg").textContent="";
});
$("#dlSheetCsv").addEventListener("click",()=>{
  const gs=chosenGroups();if(!gs.length){$("#sheetMsg").textContent="Pick at least one page that has items.";return}
  const g=$("#sheetGaap").checked, fill=$("#sheetCounted").checked;
  const lines=[["Page","Code","Item","Unit",...(g?["GAAP qty"]:[]),"Count"].join(",")];
  gs.forEach(grp=>grp.items.forEach(i=>lines.push([grp.label,i.code,i.name,i.unit,...(g?[i.gaap]:[]),fill?(sheetQty(i,grp)??""):""].map(csvCell).join(","))));
  offer("count-sheet.csv",lines.join("\r\n"));
});

/* ---------- items ---------- */
let editId=null, delArmed=false;
function renderItems(){
  $("#itemCount").textContent=`Items (${items.length})`;
  $("#removeExamples").hidden=!canWrite||!items.some(i=>i.example);
  const lf=$("#itemListFilter"), curF=lf.value||"all";
  lf.innerHTML='<option value="all">All items (Full stocktake)</option>'+lists.map(l=>`<option value="${esc(l.id)}">${esc(l.name)} (${(l.itemIds||[]).length})</option>`).join("")+'<option value="none">Not on any list</option>';
  lf.value=[...lf.options].some(o=>o.value===curF)?curF:"all";
  const memb=itemListsMap();
  const sorted=lf.value==="all"?[...items].sort(sortItems):lf.value==="none"?items.filter(i=>!memb[i.id]).sort(sortItems):listItems(lf.value);
  $("#itemBody").innerHTML=sorted.length?sorted.map(i=>`<tr class="clickable" data-id="${esc(i.id)}"><td class="mono">${esc(i.code||"")}</td><td>${esc(i.name)}${i.example?' <span class="tag ex">example</span>':""}</td><td>${(memb[i.id]||[]).map(l=>`<span class="tag">${esc(l.name)}</span>`).join(" ")}</td><td>${esc(i.area||"")}</td><td>${esc(LOCNAME[locOf(i)])}</td><td>${esc(i.unit||"")}</td><td class="n">${fmtQ(i.gaap)}</td><td class="n">${fmtR(i.cost||0)}</td><td>${esc(i.supplier||"")}</td><td class="n">${i.min!=null?fmtQ(i.min):"—"}</td><td class="n">${i.par!=null?fmtQ(i.par):"—"}</td></tr>`).join("")
    :`<tr><td colspan="11" class="empty">${items.length?"No items on this list.":"No items yet. Import your GAAP list above."}</td></tr>`;
}
$("#itemListFilter").addEventListener("change",renderItems);
function itemListsMap(){const m={};lists.forEach(l=>(l.itemIds||[]).forEach(id=>(m[id]=m[id]||[]).push(l)));return m}
let fListSel=new Set();
function renderFormLists(){
  $("#fLists").innerHTML=lists.length?lists.map(l=>`<button type="button" class="chip" data-l="${esc(l.id)}" aria-pressed="${fListSel.has(l.id)}">${esc(l.name)}</button>`).join(""):'<span class="muted">No stock lists yet.</span>';
}
$("#fLists").addEventListener("click",e=>{const b=e.target.closest(".chip");if(!b)return;const id=b.dataset.l;fListSel.has(id)?fListSel.delete(id):fListSel.add(id);renderFormLists()});
// Put an item into a list at its GAAP sheet position (before the first list item that comes after it in the full sheet).
function insertByOrder(ids,id,ord){
  const at=ids.findIndex(x=>{const it=items.find(i=>i.id===x);return it&&(it.order??1e9)>ord});
  const out=ids.slice();at<0?out.push(id):out.splice(at,0,id);return out;
}
async function saveItemLists(id,ord){
  for(const l of lists){
    const has=(l.itemIds||[]).includes(id), want=fListSel.has(l.id);
    if(has===want)continue;
    const next=want?insertByOrder(l.itemIds||[],id,ord??1e9):(l.itemIds||[]).filter(x=>x!==id);
    await db.doc("lists/"+l.id).update({itemIds:next});
  }
}
const numOrNull=v=>{v=String(v).trim();if(v==="")return null;const n=Number(v);return isFinite(n)&&n>=0?n:null};
function fillForm(i){
  editId=i?i.id:null;delArmed=false;
  $("#itemFormTitle").textContent=i?"Edit item":"Add an item";
  $("#saveItem").textContent=i?"Save changes":"Add item";
  $("#cancelEdit").hidden=!i;$("#deleteItem").hidden=!i;$("#deleteItem").textContent="Delete";
  $("#fCode").value=i?.code||"";$("#fName").value=i?.name||"";$("#fArea").value=i?.area||"";
  $("#fUnit").value=i?.unit||"";$("#fGaap").value=i?.gaap??"";$("#fCost").value=i?.cost??"";
  $("#fLoc").innerHTML=LOCS.map(([k,n])=>`<option value="${k}">${esc(n)}</option>`).join("");
  $("#fLoc").value=i?locOf(i):(LOCNAME[place]&&place!=="sheet"&&place!=="recount"?place:"dry");
  $("#fSupplier").value=i?.supplier||"";$("#fMin").value=i?.min??"";$("#fPar").value=i?.par??"";
  fListSel=new Set(i?lists.filter(l=>(l.itemIds||[]).includes(i.id)).map(l=>l.id):[]);renderFormLists();
}
fillForm(null);
$("#itemBody").addEventListener("click",e=>{const tr=e.target.closest("tr[data-id]");if(!tr||!canWrite)return;fillForm(items.find(i=>i.id===tr.dataset.id));$("#itemFormPanel").scrollIntoView({behavior:"smooth",block:"start"})});
$("#cancelEdit").addEventListener("click",()=>fillForm(null));
$("#saveItem").addEventListener("click",async()=>{
  const name=$("#fName").value.trim();if(!name){toast("Give the item a name");return}
  const body={code:$("#fCode").value.trim(),name,area:$("#fArea").value.trim()||"Retail Shelves",unit:$("#fUnit").value.trim()||"each",gaap:Number($("#fGaap").value)||0,cost:Number($("#fCost").value)||0,loc:$("#fLoc").value,
    supplier:$("#fSupplier").value.trim(),min:numOrNull($("#fMin").value),par:numOrNull($("#fPar").value)};
  try{ const id=editId||rand(), old=items.find(i=>i.id===id);
    if(!editId)body.order=Math.max(0,...items.map(i=>i.order||0))+1;
    if(editId) await db.doc("items/"+id).update(body); else await db.doc("items/"+id).set(body);
    await saveItemLists(id,old?old.order:body.order);
    toast(editId?"Item saved":"Item added");fillForm(null);}catch(e){writeErr(e)}
});
$("#deleteItem").addEventListener("click",async()=>{
  if(!delArmed){delArmed=true;$("#deleteItem").textContent="Tap again to delete";return}
  try{const id=editId;await db.doc("items/"+id).delete();
    for(const l of lists.filter(l=>(l.itemIds||[]).includes(id)))await db.doc("lists/"+l.id).update({itemIds:l.itemIds.filter(x=>x!==id)});
    toast("Item deleted");fillForm(null)}catch(e){writeErr(e)}
});
$("#removeExamples").addEventListener("click",async()=>{
  const b=$("#removeExamples");
  if(b.dataset.armed!=="1"){b.dataset.armed="1";b.textContent="Tap again to remove all examples";return}
  b.dataset.armed="";b.textContent="Remove example items";
  const ex=items.filter(i=>i.example);
  await runPool(ex,i=>db.doc("items/"+i.id).delete());
  const exS=sessions.filter(s=>s.example);for(const s of exS){try{await db.doc("sessions/"+s.id).delete()}catch(e){}}
  toast(`Removed ${ex.length} example items`);
});

/* import */
let parsed=null;
function parseCSV(text){
  const rows=[];let row=[],cell="",q=false;
  const delim=(text.split("\n")[0].match(/;/g)||[]).length>(text.split("\n")[0].match(/,/g)||[]).length?";":(text.includes("\t")&&!text.split("\n")[0].includes(",")?"\t":",");
  for(let k=0;k<text.length;k++){const ch=text[k];
    if(q){if(ch==='"'){if(text[k+1]==='"'){cell+='"';k++}else q=false}else cell+=ch}
    else if(ch==='"')q=true; else if(ch===delim){row.push(cell);cell=""} else if(ch==="\n"){row.push(cell);rows.push(row);row=[];cell=""} else if(ch!=="\r")cell+=ch;}
  if(cell!==""||row.length){row.push(cell);rows.push(row)}
  return rows.filter(r=>r.some(c=>String(c).trim()!==""));
}
function mapRows(rows){
  // find the header row: first row with a recognisable name column
  const test=(h,res)=>res.some(r=>r.test(h));
  const R={code:[/^code$/,/item ?code/,/stock ?code/,/sku/,/barcode/,/plu/,/^id$/],
    name:[/desc/,/^name$/,/item ?name/,/product/,/^item$/,/stock ?item/],
    area:[/area/,/categ/,/group/,/dept/,/department/,/location/,/store ?room/],
    unit:[/^unit$/,/uom/,/unit of/,/measure/,/pack/],
    gaap:[/on ?hand/,/^qty$/,/quantity/,/soh/,/stock ?level/,/closing/,/theoretical/,/system ?qty/,/^stock$/,/balance/],
    cost:[/cost/,/price/,/avg/,/unit ?value/]};
  let hi=-1,map=null;
  for(let r=0;r<Math.min(rows.length,15);r++){
    const hs=rows[r].map(h=>String(h).trim().toLowerCase());const m={};
    for(const key of Object.keys(R)){const idx=hs.findIndex((h,ix)=>h&&test(h,R[key])&&!Object.values(m).includes(ix));if(idx>=0)m[key]=idx}
    if(m.name!=null){hi=r;map=m;break}
  }
  if(!map)return {error:"Couldn't find a header row with an item name or description column. Make sure the first row has headings like Code, Description, On Hand, Cost."};
  const fallback=$("#impArea").value.trim()||"Retail Shelves";
  const num=v=>{if(v==null||v==="")return 0;if(typeof v==="number")return v;const n=Number(String(v).replace(/[R\s]/g,"").replace(/,(?=\d{3}\b)/g,"").replace(",","."));return Number.isFinite(n)?n:0};
  const out=[];
  for(const r of rows.slice(hi+1)){
    const name=String(r[map.name]??"").trim();if(!name)continue;
    out.push({code:map.code!=null?String(r[map.code]??"").trim():"",name,area:map.area!=null&&String(r[map.area]??"").trim()?String(r[map.area]).trim():fallback,
      unit:map.unit!=null&&String(r[map.unit]??"").trim()?String(r[map.unit]).trim():"each",gaap:map.gaap!=null?num(r[map.gaap]):0,cost:map.cost!=null?num(r[map.cost]):0});
  }
  return {rows:out,found:Object.keys(map)};
}
function loadScript(src){return new Promise((res,rej)=>{const s=document.createElement("script");s.src=src;s.onload=res;s.onerror=()=>rej(new Error("load"));document.head.appendChild(s)})}
async function readFile(f){
  if(/\.xlsx?$/i.test(f.name)){
    if(!window.XLSX)await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
    const wb=XLSX.read(await f.arrayBuffer(),{type:"array"});const ws=wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:""});
  }
  return parseCSV(await f.text());
}
$("#previewImp").addEventListener("click",async()=>{
  const msg=$("#impMsg");msg.className="";parsed=null;$("#runImp").disabled=true;$("#impPreviewWrap").hidden=true;
  try{
    const f=$("#impFile").files[0];let rows;
    if(f)rows=await readFile(f);else if($("#impText").value.trim())rows=parseCSV($("#impText").value);
    else{msg.className="note warn";msg.textContent="Choose a file or paste some rows first.";return}
    const m=mapRows(rows);
    if(m.error){msg.className="note err";msg.textContent=m.error;return}
    if(!m.rows.length){msg.className="note err";msg.textContent="The header was found but there were no item rows under it.";return}
    parsed=m.rows;
    const byCode=new Map(items.filter(i=>i.code).map(i=>[i.code.toLowerCase(),i]));
    const upd=parsed.filter(p=>p.code&&byCode.has(p.code.toLowerCase())).length;
    const missing=["code","gaap","cost"].filter(k=>!m.found.includes(k));
    msg.className="note info";
    msg.textContent=`${parsed.length} rows ready: ${upd} will update existing items, ${parsed.length-upd} will be added.`+(missing.length?` No ${missing.map(k=>({code:"code",gaap:"quantity on hand",cost:"cost"})[k]).join(" or ")} column found; those will be left at 0 or blank.`:"");
    $("#impPreview").innerHTML=parsed.slice(0,12).map(p=>`<tr><td class="mono">${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.area)}</td><td>${esc(p.unit)}</td><td class="n">${fmtQ(p.gaap)}</td><td class="n">${fmtR(p.cost)}</td></tr>`).join("")+(parsed.length>12?`<tr><td colspan="6" class="muted">…and ${parsed.length-12} more</td></tr>`:"");
    $("#impPreviewWrap").hidden=false;$("#runImp").disabled=!canWrite;
  }catch(e){msg.className="note err";msg.textContent="Couldn't read that file. Save it from GAAP as CSV and try again."}
});
async function runPool(list,fn,onStep){let k=0,done=0;const worker=async()=>{while(k<list.length){const it=list[k++];for(let t=0;t<2;t++){try{await fn(it);break}catch(e){if(t||!e||e.code!=="unavailable"&&e.code!=="resource_exhausted")throw e;await new Promise(r=>setTimeout(r,800+Math.random()*600))}}done++;onStep&&onStep(done)}};await Promise.all([worker(),worker(),worker()])}
$("#runImp").addEventListener("click",async()=>{
  if(!parsed)return;const btn=$("#runImp"),msg=$("#impMsg");btn.disabled=true;
  const byCode=new Map(items.filter(i=>i.code).map(i=>[i.code.toLowerCase(),i]));
  try{
    await runPool(parsed,p=>{const ex=p.code&&byCode.get(p.code.toLowerCase());
      return ex?db.doc("items/"+ex.id).update({name:p.name,area:p.area,unit:p.unit,gaap:p.gaap,cost:p.cost,example:false}):db.doc("items/"+rand()).set(p)},
      n=>{msg.textContent=`Importing… ${n} / ${parsed.length}`});
    msg.className="note info";msg.textContent=`Imported ${parsed.length} items.`;parsed=null;$("#impPreviewWrap").hidden=true;$("#impText").value="";$("#impFile").value="";
  }catch(e){msg.className="note err";msg.textContent=/^(quota_exceeded|resource-exhausted)$/.test(e&&e.code)?"The item store is full. Remove items you no longer stock and try again.":"The import stopped part-way ("+(e&&e.code||"error")+"). Run it again; existing codes are updated, not duplicated."}
});

/* ---------- order ---------- */
const EACH_UNITS=/^(each|ea|tots?|shots?|box|pack|bottle|can|set|bag|tray|punnet)$/i;
function suppliers(){return [...new Set(items.map(i=>(i.supplier||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b))}
const ordEdits={}; // manual order quantities typed on the Order tab (not saved)
function orderLines(){
  const zero=$("#ordUncounted").checked;
  return scope().filter(i=>i.min!=null||i.par!=null).map(i=>{
    const oh=qtyFinal(i.id), on=oh==null?(zero?0:null):oh;
    const min=i.min??0, par=i.par??i.min??0;
    let q=0;
    if(on!=null&&on<=min&&par>on){q=par-on;q=EACH_UNITS.test(i.unit||"each")?Math.ceil(q-1e-9):Math.round(q*100)/100}
    if(i.id in ordEdits)q=ordEdits[i.id];
    return {i,on,min,par,q};
  });
}
function renderOrder(){
  const sel=$("#ordSupplier"), cur=sel.value||"all", sups=suppliers();
  sel.innerHTML=`<option value="all">All suppliers</option>`+sups.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join("")+`<option value="none">No supplier set</option>`;
  sel.value=[...sel.options].some(o=>o.value===cur)?cur:"all";
  const withLv=items.filter(i=>i.min!=null||i.par!=null).length;
  const lines=orderLines(), toOrder=lines.filter(l=>l.q>0), notCounted=lines.filter(l=>l.on==null);
  $("#ordTiles").innerHTML=`<div class="tile"><div class="lbl">Items with levels</div><div class="v">${withLv}<span class="muted" style="font-size:1rem"> / ${items.length}</span></div></div>
    <div class="tile"><div class="lbl">Lines to order</div><div class="v">${toOrder.length}</div></div>
    <div class="tile"><div class="lbl">Estimated cost</div><div class="v">${fmtR(toOrder.reduce((t,l)=>t+l.q*(l.i.cost||0),0))}</div></div>
    <div class="tile"><div class="lbl">Levels set, not counted</div><div class="v">${notCounted.length}</div></div>`;
  const el=$("#ordGroups");
  if(!session()){el.innerHTML='<div class="empty">Start a stocktake and count first; the order is worked out from the count.</div>';return}
  if(!withLv){el.innerHTML='<div class="empty">No minimum or target levels set yet. Press <b>Set min &amp; target levels</b> to add them, starting with the items you order every week.</div>';return}
  const f=sel.value, groups={};
  toOrder.filter(l=>f==="all"||(f==="none"?!l.i.supplier:l.i.supplier===f)).forEach(l=>{const k=l.i.supplier||"No supplier set";(groups[k]=groups[k]||[]).push(l)});
  const keys=Object.keys(groups).sort((a,b)=>(a==="No supplier set")-(b==="No supplier set")||a.localeCompare(b));
  el.innerHTML=(keys.length?keys.map(k=>{const ls=groups[k].sort((a,b)=>sortItems(a.i,b.i));const v=ls.reduce((t,l)=>t+l.q*(l.i.cost||0),0);
    return `<div class="ogroup" data-sup="${esc(k)}"><div class="row" style="justify-content:space-between"><h3>${esc(k)}</h3>
      <div class="row"><span class="muted num">${ls.length} line${ls.length>1?"s":""} · ~${fmtR(v)}</span><button class="btn primary" data-copy="${esc(k)}">Copy order</button></div></div>
      <div class="tablewrap"><table><thead><tr><th>Item</th><th class="n">On hand</th><th class="n">Min</th><th class="n">Target</th><th class="n">Order</th><th>Unit</th><th class="n">Est. cost</th></tr></thead><tbody>
      ${ls.map(l=>`<tr data-id="${esc(l.i.id)}"><td><b>${esc(l.i.name)}</b><br><span class="mono muted">${esc(l.i.code||"")}</span></td><td class="n">${fmtQ(l.on)}</td><td class="n">${fmtQ(l.min)}</td><td class="n">${fmtQ(l.par)}</td>
        <td class="n"><input class="oq" type="number" step="any" min="0" inputmode="decimal" value="${l.q}" aria-label="Order quantity for ${esc(l.i.name)}"></td><td>${esc(l.i.unit||"each")}</td><td class="n">${fmtR(l.q*(l.i.cost||0))}</td></tr>`).join("")}
      </tbody></table></div><div class="copyout"></div></div>`}).join("")
    :'<div class="empty">Nothing is at or below its minimum. No order needed for this selection.</div>')+
    (notCounted.length?`<p class="muted" style="margin:0;font-size:.85rem">${notCounted.length} item${notCounted.length>1?"s have":" has"} levels but no count in this stocktake, so ${notCounted.length>1?"they're":"it's"} left off. Tick “Treat items not counted as 0 on hand” to include them.</p>`:"");
}
$("#ordSupplier").addEventListener("change",renderOrder);
$("#ordUncounted").addEventListener("change",renderOrder);
$("#ordGroups").addEventListener("change",e=>{if(!e.target.classList.contains("oq"))return;const id=e.target.closest("tr").dataset.id;ordEdits[id]=numOrNull(e.target.value)??0;renderOrder()});
$("#ordGroups").addEventListener("click",e=>{
  const b=e.target.closest("button[data-copy]");if(!b)return;
  const g=b.closest(".ogroup"), sup=b.dataset.copy;
  const rows=[...g.querySelectorAll("tbody tr")].map(tr=>{const it=items.find(i=>i.id===tr.dataset.id);const q=numOrNull(tr.querySelector(".oq").value)||0;return it&&q>0?`• ${it.name} – ${fmtQ(q)} ${it.unit||"each"}`:null}).filter(Boolean);
  const text=`Ou Meul Pinelands – order${sup!=="No supplier set"?" for "+sup:""}\n${new Date().toLocaleDateString("en-ZA",{weekday:"long",day:"numeric",month:"long"})}\n\n${rows.join("\n")}\n\nThank you`;
  const showBox=()=>{const o=g.querySelector(".copyout");o.innerHTML=`<textarea class="copybox" readonly aria-label="Order text">${esc(text)}</textarea><p class="muted" style="margin:0;font-size:.85rem">Select the text and copy it.</p>`;const t=o.querySelector("textarea");t.focus();t.select()};
  try{navigator.clipboard.writeText(text).then(()=>toast("Order copied. Paste it into WhatsApp or email."),showBox)}catch(err){showBox()}
});

function renderLevels(){
  const q=$("#lvlSearch").value.trim().toLowerCase(), loc=$("#lvlLoc").value||"all", unset=$("#lvlUnset").checked;
  if(!$("#lvlLoc").options.length){$("#lvlLoc").innerHTML='<option value="all">All locations</option>'+LOCS.map(([k,n])=>`<option value="${k}">${esc(n)}</option>`).join("")}
  const list=items.filter(i=>(loc==="all"||locOf(i)===loc)&&(!q||(i.name||"").toLowerCase().includes(q)||(i.code||"").toLowerCase().includes(q))&&(!unset||(i.min==null&&i.par==null))).sort(sortItems);
  $("#lvlCount").textContent=`${items.filter(i=>i.min!=null||i.par!=null).length} of ${items.length} items have levels`;
  $("#lvlBody").innerHTML=list.length?list.map(i=>`<tr data-id="${esc(i.id)}"><td><b>${esc(i.name)}</b><br><span class="mono muted">${esc(i.code||"")}</span></td><td>${esc(i.unit||"each")}</td>
    <td class="n">${fmtQ(i.gaap)}</td><td class="n">${fmtQ(qtyFinal(i.id))}</td>
    <td><input class="num" data-f="min" type="number" step="any" min="0" inputmode="decimal" value="${i.min??""}" aria-label="Minimum for ${esc(i.name)}" ${canWrite?"":"disabled"}></td>
    <td><input class="num" data-f="par" type="number" step="any" min="0" inputmode="decimal" value="${i.par??""}" aria-label="Target for ${esc(i.name)}" ${canWrite?"":"disabled"}></td>
    <td><input data-f="supplier" data-pick="supplier" autocomplete="off" value="${esc(i.supplier||"")}" aria-label="Supplier for ${esc(i.name)}" ${canWrite?"":"disabled"}></td></tr>`).join("")
    :'<tr><td colspan="7" class="empty">No items match.</td></tr>';
}
$("#ordLevelsBtn").addEventListener("click",()=>{const p=$("#levelsPanel");p.hidden=!p.hidden;$("#ordLevelsBtn").setAttribute("aria-expanded",String(!p.hidden));if(!p.hidden)renderLevels()});
["lvlSearch","lvlLoc","lvlUnset"].forEach(id=>$("#"+id).addEventListener(id==="lvlSearch"?"input":"change",renderLevels));
$("#lvlBody").addEventListener("change",async e=>{
  const inp=e.target, f=inp.dataset.f;if(!f)return;const id=inp.closest("tr").dataset.id;
  const val=f==="supplier"?inp.value.trim():numOrNull(inp.value);
  try{await db.doc("items/"+id).update({[f]:val});inp.classList.add("saved");setTimeout(()=>inp.classList.remove("saved"),1200)}catch(err){writeErr(err)}
});

/* ---------- weekly order sheets ---------- */
// orderSheets/{id}: {name, account, order, lines:[{k,name,size,code,price,itemId}], draft:{k:qty}, last:{k:qty}, lastAt}
// orderLog/{id}: {sheetId, name, at, by, total, lines:[{name,size,code,q,price}]}
// The draft is shared, so whoever opens the sheet sees this week's order as it stands.
let ordMode=ls.get("om-ordmode")==="levels"?"levels":"sheets", sheets=[], orderLog=[], osSel=ls.get("om-os")||null;
let osEdit=false, osRmArmed=null, osSentArmed=false, osClearArmed=false, osTimer=null, osFlushing=false;
const osPend={}; // sheetId -> {lineKey: qty} not yet saved
const osSheet=()=>sheets.find(s=>s.id===osSel)||sheets[0]||null;
function osQty(s,k){const p=osPend[s.id];if(p&&k in p)return Number(p[k])||0;return Number((s.draft||{})[k])||0}
const osOn=s=>(s.lines||[]).map(l=>({l,q:osQty(s,l.k)})).filter(x=>x.q>0);
const hasPrice=l=>l.price!=null&&l.price!==""&&isFinite(Number(l.price));
const osDate=t=>new Date(t).toLocaleDateString("en-ZA",{day:"numeric",month:"short",year:"numeric"});
function osMessage(s){
  const on=osOn(s);if(!on.length)return "";
  const d=new Date().toLocaleDateString("en-ZA",{day:"numeric",month:"long",year:"numeric"});
  return `Good morning 👋\n\n*${s.name} Order – Ou Meul Pinelands*\n${d}${s.account?"\nAccount "+s.account:""}\n\n${on.map(({l,q})=>`• ${l.name}${l.size?" ("+l.size+")":""} x${fmtQ(q)}`).join("\n")}\n\nThank you 🙏`;
}
function renderOrderTab(){
  document.querySelectorAll("#ordMode .chip").forEach(c=>c.setAttribute("aria-pressed",String(c.dataset.m===ordMode)));
  $("#ordSheetsMode").hidden=ordMode!=="sheets";$("#ordLevelsMode").hidden=ordMode!=="levels";
  if(ordMode==="sheets")renderOS();else renderOrder();
}
$("#ordMode").addEventListener("click",e=>{const b=e.target.closest(".chip");if(!b)return;ordMode=b.dataset.m;ls.set("om-ordmode",ordMode);renderOrderTab()});

function osRowMeta(s,l){
  const byId=osRowMeta.byId||{}, it=l.itemId&&byId[l.itemId], oh=it?qtyFinal(it.id):null, last=(s.last||{})[l.k];
  return [l.size?esc(l.size):"",osEdit?"":hasPrice(l)?fmtR(Number(l.price)):'<span class="muted">no price yet</span>',l.code?`<span class="mono">${esc(l.code)}</span>`:"",
    last?`<span class="last">Last: ${fmtQ(last)}</span>`:"",oh!=null?`<span class="oh">On hand ${fmtQ(oh)} ${esc(it.unit||"")}</span>`:""].filter(Boolean).join(" · ");
}
function renderOS(){
  $("#osNewBtn").hidden=!canWrite;
  // Don't rebuild under someone's fingers: while a box on the sheet has focus, only refresh the totals and message.
  const ae=document.activeElement;
  if(ae&&ae.tagName==="INPUT"&&$("#osBody").contains(ae)&&$("#osBody").children.length){osSummary();return}
  const pick=$("#osPick"), body=$("#osBody");
  if(!sheets.length){pick.innerHTML="";body.innerHTML=`<div class="empty">No order sheets yet. ${canWrite?"Press <b>New order sheet</b> to make one for a supplier you order from every week.":""}</div>`;return}
  const s=osSheet();osSel=s.id;
  osRowMeta.byId=Object.fromEntries(items.map(i=>[i.id,i]));
  pick.innerHTML=sheets.map(x=>{const n=osOn(x).length;return `<button class="chip" data-s="${esc(x.id)}" aria-pressed="${x.id===s.id}">${esc(x.name)}${n?`<small class="num">${n}</small>`:""}</button>`}).join("");
  const lock=!canWrite, lines=s.lines||[];
  const rows=lines.map(l=>{const q=osQty(s,l.k);
    const ctl=osEdit
      ?`<div class="editcell"><input class="osprice" data-price="${esc(l.k)}" type="number" step="any" min="0" inputmode="decimal" value="${hasPrice(l)?l.price:""}" placeholder="Price" aria-label="Price excl. VAT for ${esc(l.name)}"><button class="btn ghost" data-rm="${esc(l.k)}">${osRmArmed===l.k?"Tap again":"Remove"}</button></div>`
      :`<div class="stepper"><button data-d="-1" aria-label="One less ${esc(l.name)}" ${lock?"disabled":""}>−</button><input type="number" inputmode="numeric" min="0" step="1" value="${q||""}" placeholder="0" aria-label="Order quantity for ${esc(l.name)}" ${lock?"disabled":""}><button data-d="1" aria-label="One more ${esc(l.name)}" ${lock?"disabled":""}>+</button></div>`;
    return `<div class="crow${q>0&&!osEdit?" done":""}" data-k="${esc(l.k)}"><div><div class="nm">${esc(l.name)}</div><div class="meta">${osRowMeta(s,l)}</div></div>${ctl}</div>`}).join("");
  const log=orderLog.filter(o=>o.sheetId===s.id).slice(0,8);
  body.innerHTML=`
    <div class="oshead"><div><h3>${esc(s.name)}</h3><div class="sub">${s.account?"Account "+esc(s.account)+" · ":""}${s.lastAt?"Last ordered "+osDate(s.lastAt):"Not ordered from this sheet yet"}</div></div>
      ${canWrite?`<div class="row">${osEdit?`<button class="btn primary" data-os="done">Done editing</button>`
        :`<button class="btn" data-os="last"${Object.keys(s.last||{}).length?"":" disabled"}>Use last order</button><button class="btn ghost" data-os="clear">${osClearArmed?"Tap again to clear":"Clear"}</button><button class="btn ghost" data-os="edit">Edit items</button>`}</div>`:""}</div>
    ${osEdit?`<div class="panel">
      <div class="grid2">
        <div class="field"><label for="osName">Supplier name</label><input id="osName" data-pick="supplier" autocomplete="off" value="${esc(s.name)}"></div>
        <div class="field"><label for="osAcct">Account number</label><input id="osAcct" value="${esc(s.account||"")}"></div>
      </div>
      <p class="muted" style="margin:0;font-size:.85rem">Prices are per pack, excl. VAT, as on the supplier's invoice. Change a price below and it saves when you leave the box.</p></div>`:""}
    <div class="countlist">${rows||'<div class="empty">No items on this sheet yet. Add them below.</div>'}</div>
    ${osEdit?`<form class="panel" id="osAdd">
      <h3>Add an item</h3>
      <div class="grid2">
        <div class="field"><label for="osaName">Item</label><input id="osaName" data-pick="itemname" data-link="#osaItem" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Type to search your items, or a new name"></div>
        <div class="field"><label for="osaSize">Pack size</label><input id="osaSize" placeholder="e.g. box, 1kg, case 6 x 1L"></div>
        <div class="field"><label for="osaPrice">Price excl. VAT (R)</label><input id="osaPrice" type="number" step="any" min="0" inputmode="decimal"></div>
        <div class="field"><label for="osaCode">Supplier code</label><input id="osaCode"></div>
        <div class="field"><label for="osaItem">Stock item (optional, shows what's on hand)</label><input id="osaItem" data-pick type="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Type the item name or code"></div>
      </div>
      <div class="row"><button class="btn primary" type="submit">Add to sheet</button></div></form>`
    :`<div class="tiles" id="osTiles"></div>
    <div class="panel">
      <span class="lbl">WhatsApp message</span>
      <textarea class="copybox" id="osMsg" readonly aria-label="Order message"></textarea>
      ${canWrite?`<div class="row"><button class="btn primary" data-os="copy">Copy message</button><button class="btn" data-os="sent">${osSentArmed?"Tap again to confirm":"Mark as ordered"}</button></div>
      <p class="muted" style="margin:0;font-size:.85rem"><b>Mark as ordered</b> once you've sent it. The order is saved below, becomes the new “last order”, and the sheet clears for next week.</p>`:""}
    </div>
    <h3>Past orders</h3>
    <div class="oslog">${log.length?log.map(o=>`<details><summary><b>${osDate(o.at)}</b><span class="muted num">${(o.lines||[]).length} item${(o.lines||[]).length===1?"":"s"}${o.total?" · ~"+fmtR(o.total):""}</span></summary>
      <ul>${(o.lines||[]).map(x=>`<li>${esc(x.name)}${x.size?" ("+esc(x.size)+")":""} x${fmtQ(x.q)}</li>`).join("")}</ul></details>`).join("")
      :'<div class="empty">No orders marked as ordered yet.</div>'}</div>`}`;
  osSummary();
}
function osSummary(){
  const s=osSheet();if(!s||osEdit)return;
  const on=osOn(s), total=on.reduce((t,{l,q})=>t+(hasPrice(l)?Number(l.price)*q:0),0), unpriced=on.filter(x=>!hasPrice(x.l)).length;
  const tl=$("#osTiles");
  if(tl)tl.innerHTML=`<div class="tile"><div class="lbl">Items on order</div><div class="v">${on.length}</div></div>
    <div class="tile"><div class="lbl">Estimate excl. VAT</div><div class="v">${fmtR(total)}</div></div>
    <div class="tile"><div class="lbl">Incl. VAT</div><div class="v">${fmtR(total*1.15)}</div></div>`+
    (unpriced?`<p class="muted" style="grid-column:1/-1;margin:0;font-size:.85rem">${unpriced} item${unpriced>1?"s have":" has"} no price yet, so ${unpriced>1?"they're":"it's"} not in the estimate. Add prices under <b>Edit items</b>.</p>`:"");
  const m=$("#osMsg");if(m)m.value=osMessage(s)||"Add quantities above and the message appears here.";
  document.querySelectorAll("#osPick .chip").forEach(c=>{const x=sheets.find(y=>y.id===c.dataset.s);if(!x)return;const n=osOn(x).length;let sm=c.querySelector("small");
    if(n){if(!sm){sm=document.createElement("small");sm.className="num";c.appendChild(sm)}sm.textContent=n}else if(sm)sm.remove()});
}
function osSet(k,v){
  const s=osSheet();if(!s||!canWrite)return;
  v=Math.max(0,Math.round(Number(v)||0));
  (osPend[s.id]=osPend[s.id]||{})[k]=v;
  const row=document.querySelector(`#osBody .crow[data-k="${CSS.escape(k)}"]`);
  if(row){row.classList.toggle("done",v>0);const inp=row.querySelector(".stepper input");if(inp&&document.activeElement!==inp)inp.value=v||""}
  osSummary();clearTimeout(osTimer);osTimer=setTimeout(osFlush,400);
}
async function osFlush(){
  if(osFlushing){osTimer=setTimeout(osFlush,300);return}
  const ids=Object.keys(osPend).filter(id=>Object.keys(osPend[id]).length);if(!ids.length||!db)return;
  osFlushing=true;
  try{for(const id of ids){const batch={...osPend[id]};await db.doc("orderSheets/"+id).update({draft:batch,updatedAt:Date.now()});
      const p=osPend[id];for(const k in batch)if(p[k]===batch[k])delete p[k]}}
  catch(e){writeErr(e)}
  finally{osFlushing=false}
  if(Object.values(osPend).some(p=>Object.keys(p).length))osTimer=setTimeout(osFlush,600);
}
window.addEventListener("pagehide",()=>{if(Object.values(osPend).some(p=>Object.keys(p).length))osFlush()});
// Replace the sheet document whole, so maps that must shrink (last order, cleared draft) really lose their old keys.
async function osReplace(s,changes){const {id,...rest}=s;await db.doc("orderSheets/"+id).set({...rest,...changes,updatedAt:Date.now()})}

$("#osPick").addEventListener("click",e=>{const b=e.target.closest(".chip");if(!b)return;osSel=b.dataset.s;ls.set("om-os",osSel);osEdit=false;osRmArmed=null;osSentArmed=false;osClearArmed=false;renderOS()});
$("#osNewBtn").addEventListener("click",()=>{$("#osNewPanel").hidden=false;$("#osNewName").value="";$("#osNewName").focus()});
$("#osNewNo").addEventListener("click",()=>$("#osNewPanel").hidden=true);
$("#osNewYes").addEventListener("click",async()=>{
  const name=$("#osNewName").value.trim();if(!name){toast("Give the supplier a name");return}
  const id=rand();
  try{await db.doc("orderSheets/"+id).set({name,account:"",order:sheets.length+1,lines:[],draft:{},last:{},createdAt:Date.now()});
    osSel=id;ls.set("om-os",id);osEdit=true;$("#osNewPanel").hidden=true;toast("Order sheet created. Add its items.")}
  catch(e){writeErr(e)}
});
$("#osBody").addEventListener("click",async e=>{
  const s=osSheet();if(!s)return;
  const st=e.target.closest(".stepper button[data-d]");
  if(st){const k=st.closest(".crow").dataset.k;osSet(k,osQty(s,k)+Number(st.dataset.d));return}
  const rm=e.target.closest("button[data-rm]");
  if(rm){const k=rm.dataset.rm;if(osRmArmed!==k){osRmArmed=k;renderOS();return}
    osRmArmed=null;try{await db.doc("orderSheets/"+s.id).update({lines:(s.lines||[]).filter(l=>l.k!==k)});toast("Removed from the sheet")}catch(err){writeErr(err)}return}
  const b=e.target.closest("button[data-os]");if(!b)return;const a=b.dataset.os;
  if(a!=="clear")osClearArmed=false;if(a!=="sent")osSentArmed=false;
  if(a==="edit"){osEdit=true;renderOS()}
  else if(a==="done"){osEdit=false;osRmArmed=null;renderOS()}
  else if(a==="last"){const last=s.last||{};(s.lines||[]).forEach(l=>osSet(l.k,Number(last[l.k])||0));toast("Filled with the last order")}
  else if(a==="clear"){if(!osClearArmed){osClearArmed=true;renderOS();return}osClearArmed=false;(s.lines||[]).forEach(l=>osSet(l.k,0));renderOS();toast("Sheet cleared")}
  else if(a==="copy"){
    const text=osMessage(s);if(!text){toast("Add some quantities first");return}
    const sel=()=>{const m=$("#osMsg");m.focus();m.select();toast("Message selected. Copy it from here.")};
    try{navigator.clipboard.writeText(text).then(()=>toast("Copied. Paste it into WhatsApp."),sel)}catch(err){sel()}
  }
  else if(a==="sent"){
    const on=osOn(s);if(!on.length){toast("There's nothing on this order yet");return}
    if(!osSentArmed){osSentArmed=true;renderOS();return}
    osSentArmed=false;clearTimeout(osTimer);
    const total=on.reduce((t,{l,q})=>t+(hasPrice(l)?Number(l.price)*q:0),0), at=Date.now(), last={};
    on.forEach(({l,q})=>last[l.k]=q);
    try{
      await db.collection("orderLog").doc(rand()).set({sheetId:s.id,name:s.name,at,by:myId||"",total:R2(total),lines:on.map(({l,q})=>({name:l.name,size:l.size||"",code:l.code||"",q,price:hasPrice(l)?Number(l.price):null}))});
      delete osPend[s.id];await osReplace(s,{last,lastAt:at,draft:{}});toast("Saved as ordered. The sheet is clear for next week.")}
    catch(err){writeErr(err)}
  }
});
$("#osBody").addEventListener("input",e=>{const inp=e.target.closest(".stepper input");if(!inp)return;osSet(inp.closest(".crow").dataset.k,inp.value)});
$("#osBody").addEventListener("change",async e=>{
  const s=osSheet();if(!s||!canWrite)return;const t=e.target;
  try{
    if(t.dataset.price){const k=t.dataset.price, v=numOrNull(t.value);
      await db.doc("orderSheets/"+s.id).update({lines:(s.lines||[]).map(l=>l.k===k?{...l,price:v}:l)});toast("Price saved")}
    else if(t.id==="osName"&&t.value.trim())await db.doc("orderSheets/"+s.id).update({name:t.value.trim()});
    else if(t.id==="osAcct")await db.doc("orderSheets/"+s.id).update({account:t.value.trim()});
  }catch(err){writeErr(err)}
});
$("#osBody").addEventListener("submit",async e=>{
  if(e.target.id!=="osAdd")return;e.preventDefault();
  const s=osSheet();if(!s)return;const name=$("#osaName").value.trim();if(!name){toast("Give the item a name");$("#osaName").focus();return}
  const lab=$("#osaItem").value.trim(), it=lab?items.find(i=>itemLabel(i)===lab):null;
  if(lab&&!it){toast("Pick the stock item from the list, or leave it empty");return}
  const line={k:rand(),name,size:$("#osaSize").value.trim(),code:$("#osaCode").value.trim(),price:numOrNull($("#osaPrice").value),itemId:it?it.id:null};
  try{await db.doc("orderSheets/"+s.id).update({lines:[...(s.lines||[]),line]});toast(`Added ${name}`)}catch(err){writeErr(err)}
});

/* ---------- waste ---------- */
const REASONS=["Expired / past use-by","Spoiled","Dropped / broken","Prep or cooking error","Customer return","Staff meal","Other"];
let wReason=REASONS[0], myId=null, names={}, wDelArmed=null;
function wasteRange(){
  const v=$("#wPeriod").value, now=Date.now();
  if(v==="stock"){const prev=sessions.filter(x=>x.status==="closed"&&x.closedAt).sort((a,b)=>b.closedAt-a.closedAt)[0];return {from:prev?prev.closedAt:0,to:now+1}}
  if(v==="today"){const d=new Date();d.setHours(0,0,0,0);return {from:d.getTime(),to:now+1}}
  if(v==="all")return {from:0,to:now+1};
  return {from:now-Number(v)*864e5,to:now+1};
}
const wItem=()=>items.find(i=>itemLabel(i)===$("#wItem").value.trim())||null;
function updWasteForm(){
  const it=wItem(), q=numOrNull($("#wQty").value);
  $("#wUnit").textContent=it?`(${it.unit||"each"})`:"";
  $("#wValue").textContent=it&&q?`≈ ${fmtR(q*(it.cost||0))}${it.cost?"":" (no cost on this item yet)"}`:"";
}
function renderWaste(){
  $("#wasteForm").hidden=!canWrite;
  $("#wReasons").innerHTML=REASONS.map(r=>`<button class="chip" data-r="${esc(r)}" aria-pressed="${r===wReason}">${esc(r)}</button>`).join("");
  const {from,to}=wasteRange(), byId=Object.fromEntries(items.map(i=>[i.id,i])), g=!!settings.wasteInGaap;
  $("#wInGaap").checked=g;$("#wOnlyUnposted").parentElement.hidden=!g;$("#wPostedTh").hidden=!g;
  $("#wFoot").textContent=g
    ?"Waste is also booked in GAAP, so the Variance tab shows it for reference only and doesn't take it off the shortage again. Tick “In GAAP” once an entry is booked there, so nothing gets missed."
    :"Waste isn't booked in GAAP, so logged waste comes off the shortage on the Variance tab and what's left is the loss nobody can explain.";
  const all=waste.filter(w=>w.at>=from&&w.at<to);
  const list=g&&$("#wOnlyUnposted").checked?all.filter(w=>!w.posted):all;
  const val=all.reduce((t,w)=>t+Number(w.qty||0)*(byId[w.itemId]?.cost||0),0);
  const byR={};all.forEach(w=>{byR[w.reason]=(byR[w.reason]||0)+Number(w.qty||0)*(byId[w.itemId]?.cost||0)});
  const top=Object.entries(byR).sort((a,b)=>b[1]-a[1])[0], unposted=all.filter(w=>!w.posted).length;
  $("#wTiles").innerHTML=`<div class="tile"><div class="lbl">Entries</div><div class="v">${all.length}</div></div>
    <div class="tile short"><div class="lbl">Waste value</div><div class="v">${fmtR(val)}</div></div>
    <div class="tile"><div class="lbl">Biggest reason</div><div class="v" style="font-size:1.15rem">${top?esc(top[0]):"—"}</div></div>`+
    (g?`<div class="tile${unposted?" flagtile":""}"><div class="lbl">Not yet in GAAP</div><div class="v">${unposted}</div></div>`:"");
  $("#wBody").innerHTML=list.length?list.map(w=>{const it=byId[w.itemId];const v=Number(w.qty||0)*(it?.cost||0);
    return `<tr data-id="${esc(w.id)}"><td class="num" style="white-space:nowrap">${esc(new Date(w.at).toLocaleString("en-ZA",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}))}</td>
    <td><b>${esc(it?it.name:"(deleted item)")}</b>${w.note?`<br><span class="muted" style="font-size:.85rem">${esc(w.note)}</span>`:""}</td>
    <td class="n">${fmtQ(w.qty)} ${esc(it?.unit||"")}</td><td>${esc(w.reason||"")}</td><td class="n">${it?.cost?fmtR(v):"—"}</td>
    <td><span data-by="${esc(w.by||"")}">${esc(names[w.by]||(w.by?"…":""))}</span></td>
    ${g?`<td><label class="check"><input type="checkbox" data-posted="1" ${w.posted?"checked":""} ${canWrite?"":"disabled"} aria-label="Booked in GAAP"> ${w.posted?"Yes":"No"}</label></td>`:""}
    <td>${canWrite?`<button class="btn ghost" data-del="1">${wDelArmed===w.id?"Tap again":"Delete"}</button>`:""}</td></tr>`}).join("")
    :`<tr><td colspan="${g?8:7}" class="empty">${g&&$("#wOnlyUnposted").checked&&all.length?"Every entry in this period is booked in GAAP.":"No waste logged in this period."}</td></tr>`;
  resolveNames(list.map(w=>w.by));
  const gw=daily.filter(d=>{const t=dayStart(d.date);return t>=from&&t<to&&d.wastage});
  const gEl=$("#wGaap");gEl.hidden=!gw.length;
  if(gw.length){const tot=gw.reduce((t,d)=>t+Math.abs(d.wastage),0);
    gEl.innerHTML=`<b>Wastage booked in GAAP</b> in this period: ${fmtR(tot)} over ${gw.length} trading day${gw.length>1?"s":""} with a report (`+gw.map(d=>`${esc(dayLabel(d.date,true))} ${fmtR(Math.abs(d.wastage))}`).join(" · ")+`). See the Daily tab for each day.`}
}
async function resolveNames(ids){
  if(!user)return;const need=[...new Set(ids.filter(id=>id&&!(id in names)))];if(!need.length)return;
  try{const ps=await user.profiles(need);need.forEach(id=>{names[id]=(ps&&ps[id]&&ps[id].name)||"Someone"});
    document.querySelectorAll("#wBody [data-by]").forEach(s=>{const id=s.dataset.by;if(id in names)s.textContent=names[id]})}catch(e){}
}
$("#wReasons").addEventListener("click",e=>{const b=e.target.closest(".chip");if(!b)return;wReason=b.dataset.r;document.querySelectorAll("#wReasons .chip").forEach(c=>c.setAttribute("aria-pressed",String(c.dataset.r===wReason)))});
$("#wItem").addEventListener("input",updWasteForm);
$("#wQty").addEventListener("input",updWasteForm);
$("#wPeriod").addEventListener("change",renderWaste);
$("#wOnlyUnposted").addEventListener("change",renderWaste);
$("#wInGaap").addEventListener("change",async e=>{
  settings.wasteInGaap=e.target.checked;renderWaste();
  if(db&&canWrite)try{await db.doc("settings/main").set(mainSettings())}catch(err){writeErr(err)}
});
$("#wBody").addEventListener("change",async e=>{
  if(!e.target.dataset.posted)return;const id=e.target.closest("tr").dataset.id;
  try{await db.doc("waste/"+id).update({posted:e.target.checked,postedAt:e.target.checked?Date.now():null})}catch(err){writeErr(err)}
});
$("#wSave").addEventListener("click",async()=>{
  const it=wItem(), q=numOrNull($("#wQty").value);
  if(!it){toast("Pick the item from the list");$("#wItem").focus();return}
  if(!q){toast("Enter how much was wasted");$("#wQty").focus();return}
  try{await db.collection("waste").doc(rand()).set({itemId:it.id,qty:q,reason:wReason,note:$("#wNote").value.trim(),at:Date.now(),by:myId||""});
    toast(`Logged ${fmtQ(q)} ${it.unit||""} ${it.name}`);$("#wItem").value="";$("#wQty").value="";$("#wNote").value="";updWasteForm();$("#wItem").focus()}
  catch(e){writeErr(e)}
});
$("#wBody").addEventListener("click",async e=>{
  const b=e.target.closest("button[data-del]");if(!b)return;const id=b.closest("tr").dataset.id;
  if(wDelArmed!==id){wDelArmed=id;renderWaste();return}
  wDelArmed=null;try{await db.doc("waste/"+id).delete();toast("Waste entry deleted")}catch(err){writeErr(err)}
});
$("#wCsv").addEventListener("click",()=>{
  const {from,to}=wasteRange(), byId=Object.fromEntries(items.map(i=>[i.id,i]));
  const lines=[["Date","Code","Item","Unit","Qty","Reason","Note","Unit cost","Value","In GAAP"].join(",")];
  waste.filter(w=>w.at>=from&&w.at<to).slice().reverse().forEach(w=>{const it=byId[w.itemId]||{};lines.push([new Date(w.at).toISOString().slice(0,16).replace("T"," "),it.code,it.name,it.unit,w.qty,w.reason,w.note,(it.cost||0).toFixed(2),(Number(w.qty||0)*(it.cost||0)).toFixed(2),w.posted?"Yes":"No"].map(csvCell).join(","))});
  offer("waste-log.csv",lines.join("\r\n"));
});

/* ---------- invoices ---------- */
// Pack sizes Dylan confirmed, so the reader converts invoice packs to counting units the same way every time.
const KNOWN_SIZES=`Micro herbs: 1 tray = 90 g. All lettuce (cos, butter, lettuce mix, baby spinach, spinach): 1 pack = 200 g.
Spring onions: 1 bunch = 0.3 kg. Peppadews A10 tin: 3 kg net, 1.2 kg drained - cost per kg uses DRAINED weight.
Whole peeled tomatoes A10 tin: 2.5 kg net, 1.5 kg drained - cost per kg uses NET weight. Ice cream tub (Dairy Exchange) = 2.5 units.
Avocados "C14/16" box: assume 15 per box. Cookies marked (S) are sold per single cookie: a "10s" pack price / 10.
Kegs are 30 L; ignore keg/container/drum deposits. Smoked salmon is bought in 80 g packs.`;
let sample=null, sampleImgs=null, invoices=[], capPages=[], review=null, readCtl=null;
const R2=n=>Math.round(n*100)/100;
const itemLabel=i=>`${i.code?i.code+" · ":""}${i.name}`;
/* ---------- item picker ---------- */
// Replaces <datalist>: on some phones that opens a pop-up with no keyboard. This list sits under the box and keeps the keyboard open.
const pickBox=document.createElement("div");pickBox.className="pickbox";pickBox.hidden=true;pickBox.setAttribute("role","listbox");document.body.appendChild(pickBox);
let pickFor=null, pickHits=[], pickOn=0;
function pickMatches(raw){
  const q=raw.trim().toLowerCase(), words=q.split(/\s+/).filter(Boolean), all=[...items].sort(sortItems);
  if(!words.length)return all.slice(0,40);
  const txt=i=>((i.code||"")+" "+(i.name||"")).toLowerCase();
  const rank=i=>(i.code||"").toLowerCase()===q?0:(i.name||"").toLowerCase().startsWith(q)||(i.code||"").startsWith(q)?1:2;
  return all.filter(i=>words.every(w=>txt(i).includes(w))).sort((a,b)=>rank(a)-rank(b)).slice(0,40);
}
// Text pickers (suppliers, areas): choose an existing name, or keep typing to use a new one.
const supplierNames=()=>[...new Set([...suppliers(),...(typeof sheets!=="undefined"?sheets.map(x=>(x.name||"").trim()).filter(Boolean):[])])].sort((a,b)=>a.localeCompare(b));
function textMatches(kind,raw){
  const list=kind==="supplier"?supplierNames():areas();const q=raw.trim().toLowerCase();
  return q?list.filter(x=>x.toLowerCase().includes(q)).sort((a,b)=>(a.toLowerCase().startsWith(q)?0:1)-(b.toLowerCase().startsWith(q)?0:1)):list;
}
function placePick(){
  if(!pickFor||!pickFor.isConnected){hidePick();return}
  const r=pickFor.getBoundingClientRect(), w=Math.min(Math.max(r.width,260),innerWidth-16);
  pickBox.style.width=w+"px";pickBox.style.left=(Math.max(8,Math.min(r.left,innerWidth-w-8))+scrollX)+"px";pickBox.style.top=(r.bottom+scrollY+4)+"px";
}
function showPick(inp){
  pickFor=inp;const kind=inp.dataset.pick||"item";
  if(inp.dataset.picked==="1"){hidePick();return}
  if(kind==="supplier"||kind==="area"){
    const hits=textMatches(kind,inp.value), typed=inp.value.trim();
    pickHits=hits.map(x=>({id:"t:"+x}));pickOn=0;
    const isNew=typed&&!hits.some(x=>x.toLowerCase()===typed.toLowerCase());
    pickBox.innerHTML=hits.map((x,n)=>`<button type="button" role="option" data-id="t:${esc(x)}"${n===0?' class="on"':""}>${esc(x)}</button>`).join("")+
      (isNew?`<div class="none">New ${kind}: “${esc(typed)}” is kept as you typed it.</div>`:hits.length?"":`<div class="none">No ${kind}s yet. Type a name to add one.</div>`);
    pickBox.hidden=false;pickBox.scrollTop=0;placePick();return;
  }
  pickHits=pickMatches(inp.value);pickOn=0;
  pickBox.innerHTML=pickHits.length?pickHits.map((i,n)=>`<button type="button" role="option" data-id="${esc(i.id)}"${n===0?' class="on"':""}>${esc(i.name)}<small>${esc(i.code||"no code")} · ${esc(i.unit||"each")} · ${esc(LOCNAME[locOf(i)]||"")}</small></button>`).join("")
    :kind==="itemname"?`<div class="none">Not in your stock items. “${esc(inp.value.trim())}” is kept as a new name.</div>`:'<div class="none">No item matches. Try fewer letters or the code.</div>';
  pickBox.hidden=false;pickBox.scrollTop=0;placePick();
}
function hidePick(){pickBox.hidden=true;pickFor=null}
function choosePick(id){
  const inp=pickFor;if(!inp)return;
  if(id.startsWith("t:"))inp.value=id.slice(2);
  else{
    const it=items.find(i=>i.id===id);if(!it)return;
    // "itemname" boxes take the plain name and link the stock item in the box named by data-link.
    if(inp.dataset.pick==="itemname"){inp.value=it.name;const ln=inp.dataset.link&&$(inp.dataset.link);if(ln){ln.value=itemLabel(it);ln.dataset.picked="1"}}
    else inp.value=itemLabel(it);
  }
  inp.dataset.picked="1";hidePick();
  inp.dispatchEvent(new Event("input",{bubbles:true}));inp.dispatchEvent(new Event("change",{bubbles:true}));
  if(inp.id==="wItem")$("#wQty").focus();
  if(inp.id==="osaName")$("#osaSize").focus();
  if(inp.id==="osNewName")$("#osNewYes").focus();
}
pickBox.addEventListener("mousedown",e=>e.preventDefault()); // keep focus (and the keyboard) on the search box
pickBox.addEventListener("click",e=>{const b=e.target.closest("button[data-id]");if(b)choosePick(b.dataset.id)});
document.addEventListener("focusin",e=>{if(e.target.matches&&e.target.matches("input[data-pick]"))showPick(e.target)});
document.addEventListener("input",e=>{if(e.isTrusted&&e.target.matches&&e.target.matches("input[data-pick]")){e.target.dataset.picked="";showPick(e.target)}});
document.addEventListener("focusout",e=>{if(e.target===pickFor)setTimeout(()=>{if(document.activeElement!==pickFor)hidePick()},200)});
document.addEventListener("keydown",e=>{
  if(pickBox.hidden||e.target!==pickFor)return;
  const bs=[...pickBox.querySelectorAll("button")];
  if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();if(!bs.length)return;pickOn=(pickOn+(e.key==="ArrowDown"?1:-1)+bs.length)%bs.length;bs.forEach((b,n)=>b.classList.toggle("on",n===pickOn));bs[pickOn].scrollIntoView({block:"nearest"})}
  else if(e.key==="Enter"){if(pickHits[pickOn]){e.preventDefault();choosePick(pickHits[pickOn].id)}}
  else if(e.key==="Escape")hidePick();
});
addEventListener("resize",placePick);
document.addEventListener("scroll",e=>{if(!pickBox.hidden&&e.target!==document&&!pickBox.contains(e.target))placePick()},true);
function setInvStatus(html,kind){const el=$("#invStatus");el.className=kind?"note "+kind:"";el.innerHTML=html||""}

async function fileToBitmap(f){try{return await createImageBitmap(f,{imageOrientation:"from-image"})}catch(e){return await createImageBitmap(f)}}
// Draw a page (optionally rotated, optionally a vertical slice) onto a canvas no larger than maxSide, as a JPEG blob.
function pageCanvas(p,maxSide,y0=0,y1=1){
  const b=p.bmp, rot=((p.rot%360)+360)%360, sw=b.width, sh=b.height;
  const W0=rot%180?sh:sw, H0=rot%180?sw:sh;
  const full=document.createElement("canvas");full.width=W0;full.height=H0;
  const fx=full.getContext("2d");fx.translate(W0/2,H0/2);fx.rotate(rot*Math.PI/180);fx.drawImage(b,-sw/2,-sh/2);
  const cy=Math.round(H0*y0), ch=Math.round(H0*(y1-y0)), sc=Math.min(1,maxSide/Math.max(W0,ch));
  const c=document.createElement("canvas");c.width=Math.round(W0*sc);c.height=Math.round(ch*sc);
  const cx=c.getContext("2d");cx.fillStyle="#fff";cx.fillRect(0,0,c.width,c.height);cx.drawImage(full,0,cy,W0,ch,0,0,c.width,c.height);
  return c;
}
const toBlob=(c,q)=>new Promise(r=>c.toBlob(r,"image/jpeg",q));
const toDataURL=(c,q)=>c.toDataURL("image/jpeg",q);

async function addPages(files){
  for(const f of files){
    if(!f||!/^image\//.test(f.type)&&!/\.(jpe?g|png|webp|heic|gif)$/i.test(f.name)){toast("That file isn't a photo");continue}
    try{const bmp=await fileToBitmap(f);capPages.push({bmp,rot:0,url:URL.createObjectURL(f)})}
    catch(e){toast("Couldn't open that photo. Try taking it again.")}
  }
  renderThumbs();
}
function renderThumbs(){
  $("#invThumbs").innerHTML=capPages.map((p,k)=>`<div class="thumb" data-k="${k}"><img src="${p.url}" alt="Invoice page ${k+1}" style="transform:rotate(${p.rot}deg)"><span class="pg">Page ${k+1}</span>
    <div class="tb"><button data-a="rot" aria-label="Rotate page ${k+1}">↻</button><button data-a="del" aria-label="Remove page ${k+1}">✕</button></div></div>`).join("");
  const has=capPages.length>0;
  $("#invActions").hidden=!has;$("#camLbl").textContent=has?"📷 Photo next page":"📷 Take photo";$("#galLbl").textContent=has?"🖼 Add page from gallery":"🖼 Choose from gallery";
  $("#invRead").hidden=!sample;
}
$("#invPhoto").addEventListener("change",e=>{addPages([...e.target.files]);e.target.value=""});
$("#invPhotoMore").addEventListener("change",e=>{addPages([...e.target.files]);e.target.value=""});
$("#invThumbs").addEventListener("click",e=>{
  const b=e.target.closest("button[data-a]");if(!b)return;const k=Number(b.closest(".thumb").dataset.k);
  if(b.dataset.a==="rot")capPages[k].rot=(capPages[k].rot+90)%360;else{URL.revokeObjectURL(capPages[k].url);capPages.splice(k,1)}
  renderThumbs();
});
function resetCapture(){capPages.forEach(p=>URL.revokeObjectURL(p.url));capPages=[];review=null;renderThumbs();$("#revPanel").hidden=true;setInvStatus("")}
$("#invDiscard").addEventListener("click",resetCapture);

function buildPrompt(){
  const list=[...items].sort(sortItems).map(i=>`${i.id} | ${i.code||"-"} | ${i.name} | ${i.unit||"each"} | ${i.cost?("R"+R2(i.cost)):"no cost"}`).join("\n");
  return `You are reading a supplier tax invoice for Ou Meul Pinelands, a bakery-café in Cape Town, South Africa, from photos.
The images are, for each page in order: the whole page, then a zoomed top half, then a zoomed bottom half (when included).

1. Read the header (supplier name, invoice/document number, date, totals) and EVERY product line exactly as printed.
2. Match each line to ONE item in the stock list below by its id, or null when nothing fits (cleaning stock, gloves, packaging, deposits, fuel levy, delivery, items not stocked).
3. For matched lines, work out the cost per COUNTING UNIT of that stock item, EXCLUDING VAT, after any line discount. Use the pack size in the description: "Spinach 200G" at R14 for an item counted in kg = 14 / 0.2 = R70/kg; a 24-can case at R248.78 for an item counted each = R10.37; a 30 L keg at R1000 for an item counted in ltr = R33.33. Weighed items priced per kg stay per kg. If only VAT-inclusive prices are shown, divide by 1.15 for lines that carry VAT (fresh produce is usually zero-rated).

Rules:
- Check qty x unit price = line total. Dot-matrix invoices sometimes print prices one line out of step with the descriptions; use the line totals to put each price on the right line.
- Handwritten numbers next to a line (e.g. "4,739" by cucumbers) are the delivered weight in kg; use them to get a per-kg cost.
- Decimal separators may be commas or points.
- If a pack size or weight you need is neither on the invoice nor in the known sizes, set costPerUnit to null and say in "note" exactly what size is needed.
- Never invent lines. If something is unreadable, say so in "warnings".

Known pack sizes:
${KNOWN_SIZES}

Stock list (id | code | name | counting unit | current cost excl VAT):
${list}

Reply with only JSON in this shape:
{"supplier":"","invoiceNumber":"","date":"YYYY-MM-DD","totalExcl":0,"vat":0,"totalIncl":0,
 "lines":[{"description":"","qty":0,"unitPrice":0,"lineTotal":0,"itemId":"g123 or null","costPerUnit":0,"working":"14 / 0.2 kg = 70 per kg","confidence":"high|medium|low","note":""}],
 "warnings":[""]}`;
}
$("#invRead").addEventListener("click",async()=>{
  if(!sample||!capPages.length)return;
  const lim=sampleImgs||{maxCount:4};
  const imgs=[];
  try{
    for(const p of capPages)imgs.push(await toBlob(pageCanvas(p,2400),.85));
    // Zoomed halves make small print legible after the platform downsizes each image; add them only while under the image limit.
    if(capPages.length*3<=lim.maxCount)for(const p of capPages){imgs.push(await toBlob(pageCanvas(p,2000,0,.55),.85));imgs.push(await toBlob(pageCanvas(p,2000,.45,1),.85))}
  }catch(e){setInvStatus("Couldn't prepare the photos. Try taking them again.","err");return}
  if(imgs.length>lim.maxCount){setInvStatus(`That's more pages than can be read at once (limit ${lim.maxCount}). Save the first pages as one invoice and the rest as another.`,"warn");return}
  readCtl=new AbortController();
  $("#invRead").disabled=true;
  setInvStatus(`<span class="spin"></span>Reading the invoice and matching ${items.length} stock items. This usually takes 20–90 seconds. <button class="btn ghost" id="invStop">Stop</button>`,"info");
  $("#invStop").onclick=()=>readCtl&&readCtl.abort();
  try{
    const out=await sample.json(buildPrompt(),{images:imgs,signal:readCtl.signal});
    if(!out||!Array.isArray(out.lines))throw {code:"invalid_json"};
    startReview(out);setInvStatus("");
  }catch(e){
    const msg={cancelled:"Stopped.",not_granted:"Reading invoices needs permission to use Claude. Allow it when asked, or save the photo only and enter prices on the Items tab.",
      images_unavailable:"This view can't send photos to Claude. Open the app in claude.ai, or save the photo only.",rate_limited:"Too many requests just now, or your Claude usage limit is reached. Try again in a while.",
      image_rejected:"One of the photos couldn't be read. Retake it a little further away, or as a JPEG.",invalid_json:"The reply didn't come back in a usable form. Press Read invoice to try again.",
      refused:"The invoice couldn't be read. Check that the photo shows a supplier invoice.",session_expired:"Sign in to claude.ai again, then try."}[e&&e.code]||"Something went wrong while reading. Press Read invoice to try again.";
    setInvStatus(msg,e&&e.code==="cancelled"?"":"warn");
  }finally{$("#invRead").disabled=false;readCtl=null}
});

function startReview(out){
  const byId=Object.fromEntries(items.map(i=>[i.id,i]));
  review={supplier:out.supplier||"",invoiceNumber:String(out.invoiceNumber||""),date:/^\d{4}-\d{2}-\d{2}$/.test(out.date||"")?out.date:"",
    totalExcl:Number(out.totalExcl)||null,vat:Number(out.vat)||null,totalIncl:Number(out.totalIncl)||null,warnings:(out.warnings||[]).filter(Boolean),
    lines:out.lines.map(l=>{const it=byId[l.itemId]||null;const c=l.costPerUnit==null||l.costPerUnit===""?null:Number(l.costPerUnit);
      return {description:String(l.description||""),qty:Number(l.qty)||0,unitPrice:Number(l.unitPrice)||0,lineTotal:Number(l.lineTotal)||0,
        itemId:it?it.id:null,cost:c!=null&&isFinite(c)&&c>0?R2(c):null,working:String(l.working||""),confidence:l.confidence||"",note:String(l.note||""),
        apply:!!(it&&c>0)}})};
  $("#rvSupplier").value=review.supplier;$("#rvNumber").value=review.invoiceNumber;$("#rvDate").value=review.date;$("#rvTotal").value=review.totalExcl??"";
  renderReview();$("#revPanel").hidden=false;$("#revPanel").scrollIntoView({behavior:"smooth",block:"start"});
}
function chgBadge(oldC,newC){
  if(newC==null)return "";
  if(!oldC)return '<span class="chg new">first price</span>';
  const p=(newC-oldC)/oldC*100;
  if(Math.abs(p)<1)return '<span class="chg same">same</span>';
  return `<span class="chg ${p>0?"up":"down"}">${p>0?"▲":"▼"} ${Math.abs(p).toFixed(0)}%</span>`;
}
function renderReview(){
  const byId=Object.fromEntries(items.map(i=>[i.id,i]));
  const dup=invoices.find(v=>v.invoiceNumber&&review.invoiceNumber&&v.invoiceNumber===$("#rvNumber").value.trim()&&(v.supplier||"").toLowerCase()===$("#rvSupplier").value.trim().toLowerCase());
  const sum=R2(review.lines.reduce((t,l)=>t+(l.lineTotal||0),0));
  const tot=Number($("#rvTotal").value)||0;
  const warns=[...review.warnings];
  if(dup)warns.unshift(`This invoice number was already captured on ${new Date(dup.capturedAt).toLocaleDateString("en-ZA")}. Saving again will create a duplicate.`);
  if(tot&&sum&&Math.abs(sum-tot)>Math.max(1,tot*.01))warns.push(`The lines add up to R ${sum.toFixed(2)} but the invoice total excl. VAT is R ${tot.toFixed(2)}. A line may be missing or misread; check against the paper.`);
  const big=review.lines.filter(l=>l.apply&&l.itemId&&byId[l.itemId]?.cost&&Math.abs(l.cost-byId[l.itemId].cost)/byId[l.itemId].cost>.25).length;
  if(big)warns.push(`${big} price${big>1?"s":""} changed by more than 25%. Worth a second look before saving.`);
  $("#revWarn").innerHTML=warns.length?`<div class="note warn"><ul style="margin:0;padding-left:18px">${warns.map(w=>`<li>${esc(w)}</li>`).join("")}</ul></div>`:"";
  const n=review.lines.filter(l=>l.apply&&l.itemId&&l.cost>0).length;
  $("#revSummary").textContent=`${review.lines.length} lines · ${n} price${n===1?"":"s"} to update`;
  $("#revSave").textContent=n?`Save invoice & update ${n} price${n===1?"":"s"}`:"Save invoice";
  $("#revBody").innerHTML=review.lines.map((l,k)=>{const it=byId[l.itemId];return `<tr data-k="${k}" class="${l.apply?"":"off"}">
    <td><input type="checkbox" data-f="apply" aria-label="Update this price" ${l.apply?"checked":""} ${it&&l.cost>0?"":"disabled"} style="width:18px;height:18px"></td>
    <td style="min-width:200px"><b>${esc(l.description)}</b>${l.working?`<br><span class="muted mono">${esc(l.working)}</span>`:""}${l.note?`<br><span class="${l.confidence==="low"?"conf-low":"muted"}" style="font-size:.8rem">${esc(l.note)}</span>`:(l.confidence==="low"?'<br><span class="conf-low" style="font-size:.8rem">Low confidence: check this line</span>':"")}</td>
    <td class="n">${fmtQ(l.qty)}</td><td class="n">${fmtR(l.unitPrice)}</td>
    <td style="min-width:220px"><input data-f="item" data-pick autocomplete="off" autocorrect="off" spellcheck="false" value="${it?esc(itemLabel(it)):""}" placeholder="Not on stock list" aria-label="Stock item"><span class="muted" style="font-size:.78rem">${it?"per "+esc(it.unit||"each"):""}</span></td>
    <td class="n"><input class="cost" data-f="cost" type="number" step="any" inputmode="decimal" value="${l.cost??""}" aria-label="New cost per unit"></td>
    <td class="n">${it&&it.cost?fmtR(it.cost):"—"}</td><td>${it?chgBadge(it.cost,l.cost):""}</td></tr>`}).join("");
}
$("#revBody").addEventListener("change",e=>{
  const tr=e.target.closest("tr[data-k]");if(!tr)return;const l=review.lines[Number(tr.dataset.k)],f=e.target.dataset.f;
  if(f==="apply")l.apply=e.target.checked;
  else if(f==="cost"){const v=Number(e.target.value);l.cost=v>0?R2(v):null;l.apply=!!(l.itemId&&l.cost)}
  else if(f==="item"){const v=e.target.value.trim();const it=items.find(i=>itemLabel(i)===v);l.itemId=it?it.id:null;l.apply=!!(it&&l.cost)}
  renderReview();
});
["rvNumber","rvSupplier","rvTotal"].forEach(id=>$("#"+id).addEventListener("change",()=>review&&renderReview()));
$("#revCancel").addEventListener("click",()=>{review=null;$("#revPanel").hidden=true});

// Save the page photos as compressed JPEGs, one document per page, kept under the store's 256 KB document limit.
async function savePages(invId){
  let n=0;
  for(const p of capPages){
    let side=1500,q=.62,url=toDataURL(pageCanvas(p,side),q);
    while(url.length>230000&&side>700){side-=200;q=Math.max(.45,q-.05);url=toDataURL(pageCanvas(p,side),q)}
    await db.doc(`invoices/${invId}/pages/p${n}`).set({n,img:url});n++;
  }
  return n;
}
async function saveInvoice(applyPrices){
  if(!db||!canWrite)return;
  const btns=["#revSave","#revSaveOnly","#invPhotoOnly"].map(s=>$(s));btns.forEach(b=>b.disabled=true);
  const id=rand(), r=review||{lines:[]};
  const head={supplier:$("#rvSupplier").value.trim()||r.supplier||"",invoiceNumber:$("#rvNumber").value.trim()||"",date:$("#rvDate").value||"",
    totalExcl:Number($("#rvTotal").value)||r.totalExcl||null,vat:r.vat||null,totalIncl:r.totalIncl||null};
  const toApply=applyPrices?r.lines.filter(l=>l.apply&&l.itemId&&l.cost>0):[];
  try{
    setInvStatus('<span class="spin"></span>Saving the photos…',"info");
    const pages=await savePages(id);
    await db.doc("invoices/"+id).set({...head,capturedAt:Date.now(),pages,read:!!review,
      lines:r.lines.map(l=>({description:l.description,qty:l.qty,unitPrice:l.unitPrice,lineTotal:l.lineTotal,itemId:l.itemId,cost:l.cost,working:l.working,applied:toApply.includes(l)})),
      pricesUpdated:toApply.length});
    if(toApply.length){
      setInvStatus(`<span class="spin"></span>Updating ${toApply.length} prices…`,"info");
      const src=`${head.supplier||"Invoice"}${head.invoiceNumber?" "+head.invoiceNumber:""}${head.date?", "+head.date:""}`;
      const byId=Object.fromEntries(items.map(i=>[i.id,i]));
      await runPool(toApply,l=>{const it=byId[l.itemId];const hist=(Array.isArray(it?.priceHist)?it.priceHist:[]).slice(-9);
        hist.push({c:l.cost,d:head.date||new Date().toISOString().slice(0,10),s:head.supplier||"",inv:id});
        const up={cost:l.cost,costSource:src+(l.working?": "+l.working:""),costInvoice:id,priceHist:hist};
        if(!it?.supplier&&head.supplier)up.supplier=head.supplier;
        return db.doc("items/"+l.itemId).update(up)});
    }
    resetCapture();
    setInvStatus(`Invoice saved${toApply.length?` and ${toApply.length} price${toApply.length>1?"s":""} updated`:""}.`,"info");
    toast("Invoice saved");
  }catch(e){
    setInvStatus(/^(quota_exceeded|resource-exhausted)$/.test(e&&e.code)?"The app's storage is full. Delete some old invoices and try again.":"Couldn't save: "+(e&&(e.message||e.code)||"unknown error")+". Nothing was lost on screen; press save again.","err");
  }finally{btns.forEach(b=>b.disabled=false)}
}
$("#revSave").addEventListener("click",()=>saveInvoice(true));
$("#revSaveOnly").addEventListener("click",()=>saveInvoice(false));
$("#invPhotoOnly").addEventListener("click",()=>{review=null;saveInvoice(false)});

function renderInvoices(){
  $("#invCount").textContent=`Saved invoices (${invoices.length})`;
  const el=$("#invList");
  if(!invoices.length){el.innerHTML='<div class="empty">No invoices captured yet. Take a photo above to start.</div>';return}
  el.innerHTML=invoices.slice().sort((a,b)=>String(b.date||"").localeCompare(String(a.date||""))||(b.capturedAt||0)-(a.capturedAt||0)).map(v=>`<button class="irow" data-id="${esc(v.id)}"><div class="in"><b>${esc(v.supplier||"Invoice")}${v.invoiceNumber?" · "+esc(v.invoiceNumber):""}</b>
    <span class="muted" style="font-size:.85rem">${esc(v.date||new Date(v.capturedAt).toLocaleDateString("en-ZA"))} · ${v.pages||0} page${v.pages===1?"":"s"}${v.read?` · ${(v.lines||[]).length} lines · ${v.pricesUpdated||0} prices updated`:" · photo only"}</span></div>
    <span class="num" style="font-weight:600">${v.totalExcl?fmtR(v.totalExcl):""}</span></button>`).join("");
}
let detailId=null, delInvArmed=false;
$("#invList").addEventListener("click",async e=>{
  const b=e.target.closest(".irow");if(!b)return;detailId=b.dataset.id;delInvArmed=false;
  const v=invoices.find(x=>x.id===detailId);if(!v)return;
  const byId=Object.fromEntries(items.map(i=>[i.id,i]));
  const d=$("#invDetail");d.hidden=false;
  d.innerHTML=`<div class="row" style="justify-content:space-between"><h3>${esc(v.supplier||"Invoice")}${v.invoiceNumber?" · "+esc(v.invoiceNumber):""}</h3>
    <div class="row"><button class="btn danger" id="invDel">Delete invoice</button><button class="btn ghost" id="invClose">Close</button></div></div>
    <p class="muted" style="margin:0">${esc(v.date||"")}${v.totalExcl?" · Total excl. VAT "+fmtR(v.totalExcl):""}${v.totalIncl?" · incl. "+fmtR(v.totalIncl):""}</p>${v.note?`<p class="note info" style="margin:8px 0 0">${esc(v.note)}</p>`:""}
    <div class="pages" id="invPages"><span class="muted"><span class="spin"></span>Loading photo…</span></div>
    ${(v.lines||[]).length?`<div class="tablewrap"><table><thead><tr><th>Line</th><th class="n">Qty</th><th class="n">Price</th><th>Stock item</th><th class="n">Cost used</th></tr></thead><tbody>
    ${v.lines.map(l=>`<tr><td>${esc(l.description)}${l.note?`<br><span class="muted" style="font-size:.8rem">${esc(l.note)}</span>`:""}</td><td class="n">${l.qty==null?"—":fmtQ(l.qty)}</td><td class="n">${fmtR(l.unitPrice||0)}</td><td>${l.itemId&&byId[l.itemId]?esc(byId[l.itemId].name):'<span class="muted">—</span>'}</td><td class="n">${l.applied?fmtR(l.cost):'<span class="muted">not applied</span>'}</td></tr>`).join("")}
    </tbody></table></div>`:""}`;
  d.scrollIntoView({behavior:"smooth",block:"start"});
  $("#invClose").onclick=()=>{d.hidden=true;detailId=null};
  $("#invDel").onclick=async()=>{
    if(!delInvArmed){delInvArmed=true;$("#invDel").textContent="Tap again to delete (prices stay)";return}
    try{for(let k=0;k<(v.pages||0);k++)await db.doc(`invoices/${v.id}/pages/p${k}`).delete();await db.doc("invoices/"+v.id).delete();d.hidden=true;toast("Invoice deleted")}catch(err){writeErr(err)}
  };
  try{
    const snap=await db.collection(`invoices/${v.id}/pages`).orderBy("n").get();
    if(detailId!==v.id)return;
    $("#invPages").innerHTML=snap.docs.length?snap.docs.map((p,k)=>`<img src="${esc(p.data().img)}" alt="Invoice page ${k+1}">`).join(""):'<span class="muted">No photo saved.</span>';
  }catch(err){$("#invPages").innerHTML='<span class="muted">Couldn\'t load the photo.</span>'}
});

/* ---------- errors & render ---------- */
function writeErr(e){
  const c=e&&e.code;
  if(c==="permission-denied"||c==="unauthenticated"){toast(canWrite?"You don't have access to change this. Ask the owner.":"You have view-only access");return}
  toast("Couldn't save: "+(e&&(e.message||e.code)||"unknown error"));
}
/* ---------- daily trading (GAAP Management Overview Report) ---------- */
const WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], MO=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function dayStart(iso){const [y,m,d]=String(iso).split("-").map(Number);return new Date(y,m-1,d).getTime()}
function dayLabel(iso,short){const t=new Date(dayStart(iso));return short?`${t.getDate()} ${MO[t.getMonth()]}`:`${WD[t.getDay()]} ${t.getDate()} ${MO[t.getMonth()]}`}
const R0=n=>n==null?"—":(n<0?"−":"")+"R "+Math.round(Math.abs(n)).toLocaleString("en-ZA");
const P1=n=>n==null?"—":(Math.round(n*10)/10).toLocaleString("en-ZA",{minimumFractionDigits:1,maximumFractionDigits:1})+"%";
const N0=n=>n==null?"—":Number(n).toLocaleString("en-ZA",{maximumFractionDigits:2});
const avgOf=(arr,f)=>{const v=arr.map(f).filter(x=>x!=null&&Number.isFinite(x));return v.length?v.reduce((a,b)=>a+b,0)/v.length:null};
function dWaste(d){return d.wastage==null?null:Math.abs(d.wastage)}
function dWastePct(d){return d.actualSales?dWaste(d)/d.actualSales*100:null}
function dCashDiff(d){return d.cashup==null||d.bankable==null?null:Math.round((d.cashup+d.bankable)*100)/100}
function dLabour(d){const t=(d.staff||[]).find(s=>s.role==="Total");return t||null}
// Thresholds for "Needs a look". Percentages are of the day's turnover incl. VAT, as GAAP prints them.
function dayFlags(d,others){
  const f=[],x=d.exc||{},abs=Math.abs;
  const cosAvg=avgOf(others.filter(o=>!o.stockVar),o=>o.cosPct);
  if(!d.stockVar&&d.cosPct!=null&&(d.cosPct>=35||(cosAvg!=null&&d.cosPct-cosAvg>=3)))f.push(["hi","Cost of sales "+P1(d.cosPct),`${R0(d.cos)} against ${R0(d.actualSales)} sales`+(cosAvg!=null?`; the other loaded days average ${P1(cosAvg)}.`:".")+" Daily cost of sales moves with when invoices and counts are posted, so also check the period figure."]);
  if(x.changeStaff&&x.changeStaff.p>=10)f.push(["hi",`Change staff ${R0(x.changeStaff.v)} (${P1(x.changeStaff.p)} of turnover)`,`${x.changeStaff.q} bills moved to another waiter. A high value usually means bills were taken over at shift change; check who moved what.`]);
  if(x.voids&&x.voids.p>=3)f.push(["hi",`Voids ${R0(x.voids.v)} (${P1(x.voids.p)})`,`${x.voids.q} voids. Ask for the void report and the reasons in GAAP.`]);
  if(x.priceOverrides&&abs(x.priceOverrides.p)>=3)f.push(["hi",`Price overrides ${R0(x.priceOverrides.v)} (${P1(x.priceOverrides.p)})`,`${x.priceOverrides.q} price changes at the till. Check each one has a reason.`]);
  if(x.negInvoices&&x.negInvoices.v&&x.negInvoices.p>=1)f.push(["hi",`Negative invoice ${R0(x.negInvoices.v)} (${P1(x.negInvoices.p)})`,`${x.negInvoices.q} refund or reversal${x.negInvoices.q>1?"s":""}. Confirm who authorised it.`]);
  if(x.tableTransfers&&x.tableTransfers.p>=5)f.push(["md",`Table transfers ${R0(x.tableTransfers.v)} (${P1(x.tableTransfers.p)})`,`${x.tableTransfers.q} transfers between tables.`]);
  const cd=dCashDiff(d);if(cd!=null&&abs(cd)>=10)f.push([abs(cd)>=100?"hi":"md",`Cash-up off by ${fmtR(abs(cd))}`,`GAAP's final cash-up result (${fmtR(d.cashup)}) doesn't mirror the bankable cash (${fmtR(d.bankable)}) on this day, which it does on most days. Check the cash-up sheet and the safe for that day.`]);
  if(d.stockVar)f.push(["md",`Stocktake adjustment ${d.stockVar>0?"+":"−"}${fmtR(abs(d.stockVar))}`,"A stock count was posted in GAAP this day, so this day's cost of sales and profit aren't comparable with other days. Use the period figures at the top of the tab."]);
  if(d.bankable!=null&&d.bankable<0)f.push(["md","Bankable cash negative "+fmtR(d.bankable),`Card tips paid out in cash (${fmtR(d.tips)}) were more than the cash taken (${fmtR(d.cashTaken)}).`]);
  const wp=dWastePct(d);if(wp!=null&&(wp>=2||dWaste(d)>=1000))f.push([wp>=3?"hi":"md",`Wastage ${fmtR(dWaste(d))} (${P1(wp)} of sales excl. VAT)`,"Booked in GAAP that day. Check what was written off on the Waste tab or in GAAP."]);
  if(d.staffLogEdit>=3)f.push(["md",`${d.staffLogEdit} staff clock-in edits`,"Clock times were changed after the fact."]);
  return f;
}
// rows for the day-by-day table: [label, fn(d) -> value, fmt, judge(d)->""|"warn"|"bad"]
const D_ROWS=[
  ["Sales"],
  ["Turnover incl. VAT",d=>d.tto,R0],
  ["Sales excl. VAT",d=>d.actualSales,R0],
  ["Customers",d=>d.customers,N0],
  ["Spend per customer",d=>d.perCustomer,R0],
  ["Tables",d=>d.tables,N0],
  ["Spend per table",d=>d.perTable,R0],
  ["Breakfast 05h–11h",d=>(d.sessions||[])[0]?.rec,R0],
  ["Lunch 11h–17h",d=>(d.sessions||[])[1]?.rec,R0],
  ["Evening 17h–05h",d=>(d.sessions||[])[2]?.rec,R0],
  ["Take-out",d=>d.takeOut?.v,R0],
  ["Delivery",d=>d.delivery?.v,R0],
  ["Stock & profit"],
  ["Purchases booked",d=>d.stock?.purchases,R0],
  ["Cost of sales",d=>d.cos,R0],
  ["Cost of sales %",d=>d.cosPct,P1,d=>d.cosPct>=35?"bad":""],
  ["Gross profit",d=>d.gp,R0],
  ["Gross profit %",d=>d.gpPct,P1],
  ["Expenses",d=>d.expenses,R0],
  ["Nett profit",d=>d.nett,R0],
  ["Stocktake adjustment",d=>d.stockVar||0,R0,d=>d.stockVar?"warn":""],
  ["Wastage",d=>dWaste(d),R0,d=>dWastePct(d)>=3?"bad":dWastePct(d)>=2?"warn":""],
  ["Closing stock value",d=>d.stock?.closing,R0],
  ["Cash"],
  ["Card",d=>d.pay?.card,R0],
  ["Cash taken",d=>d.cashTaken,R0],
  ["Tips",d=>d.tips,R0],
  ["Bankable cash",d=>d.bankable,fmtR,d=>d.bankable<0?"warn":""],
  ["Final cash-up result",d=>d.cashup,fmtR],
  ["Cash-up difference",d=>dCashDiff(d),fmtR,d=>Math.abs(dCashDiff(d))>=100?"bad":Math.abs(dCashDiff(d))>=10?"warn":""],
  ["Till exceptions"],
  ["Voids",d=>d.exc?.voids?.v,R0,d=>d.exc?.voids?.p>=3?"bad":""],
  ["Price overrides",d=>d.exc?.priceOverrides?.v,R0,d=>Math.abs(d.exc?.priceOverrides?.p)>=3?"bad":""],
  ["Negative invoices",d=>d.exc?.negInvoices?.v,R0,d=>d.exc?.negInvoices?.p>=1?"bad":""],
  ["Table transfers",d=>d.exc?.tableTransfers?.v,R0,d=>d.exc?.tableTransfers?.p>=5?"warn":""],
  ["Change staff",d=>d.exc?.changeStaff?.v,R0,d=>d.exc?.changeStaff?.p>=10?"bad":""],
  ["Staff"],
  ["Staff on shift",d=>dLabour(d)?.qty,N0],
  ["Staff hours",d=>dLabour(d)?.hours,N0],
  ["Turnover per staff hour",d=>dLabour(d)?.ttoHr,R0],
  ["Kitchen hours",d=>(d.staff||[]).find(s=>s.role==="Kitchen Staff")?.hours,N0],
];
function renderDaily(){
  const days=daily.slice().sort((a,b)=>a.date<b.date?1:-1); // newest first
  $("#dEmpty").hidden=!!days.length;$("#dMain").hidden=!days.length;$("#dCsv").disabled=!days.length;
  if(!days.length){$("#dDays").innerHTML="";return}
  if(!dSel||!days.some(d=>d.date===dSel))dSel=days[0].date;
  $("#dDays").innerHTML=days.map(d=>`<button class="chip dchip" data-day="${esc(d.date)}" aria-pressed="${d.date===dSel}"><span>${esc(dayLabel(d.date))}</span><small>${R0(d.tto)}</small></button>`).join("");
  const d=days.find(x=>x.date===dSel), others=days.filter(x=>x.date!==dSel);
  const prev=days.find(x=>x.date<dSel);
  const delta=(cur,old,fmt,goodUp=true)=>{if(cur==null||old==null)return"";const df=cur-old;if(Math.abs(df)<1e-9)return` · same as ${esc(dayLabel(prev.date,true))}`;const good=goodUp?df>0:df<0;return ` · <b class="${good?"up":"dn"}">${df>0?"+":"−"}${fmt(Math.abs(df))}</b> vs ${esc(dayLabel(prev.date,true))}`};
  const T=(lbl,v,sub,cls)=>`<div class="tile${cls?" "+cls:""}"><div class="lbl">${lbl}</div><div class="v">${v}</div>${sub?`<div class="sub">${sub}</div>`:""}</div>`;
  const wp=dWastePct(d), lab=dLabour(d);
  { const asc0=days.slice().reverse(), sum=f=>asc0.reduce((t,x)=>t+(Number(f(x))||0),0);
    const sales=sum(x=>x.actualSales), cos=sum(x=>x.cos), sv=sum(x=>x.stockVar), w=sum(x=>dWaste(x)), hrs=sum(x=>dLabour(x)?.hours), cu=sum(x=>x.customers), ses=sum(x=>(x.sessions||[]).reduce((t,s)=>t+(s.rec||0),0));
    $("#dPeriodTitle").textContent=`All loaded days · ${dayLabel(asc0[0].date,true)} to ${dayLabel(asc0[asc0.length-1].date,true)} (${asc0.length} day${asc0.length>1?"s":""})`;
    $("#dPeriod").innerHTML=
      T("Turnover incl. VAT",R0(sum(x=>x.tto)),`${R0(sum(x=>x.tto)/asc0.length)} a day on average`)+
      T("Cost of sales",sales?P1(cos/sales*100):"—",sv?`${P1((cos+sv)/sales*100)} before the stocktake adjustment of ${R0(sv)}`:`${R0(cos)} on ${R0(sales)} sales`)+
      T("Wastage",R0(w),sales?`${P1(w/sales*100)} of sales excl. VAT`:"")+
      T("Customers",N0(cu),cu?`${R0(ses/cu)} average spend`:"")+
      T("Staff hours",N0(Math.round(hrs)),hrs?`${R0(sum(x=>x.tto)/hrs)} turnover per staff hour`:"")+
      T("Expenses booked",R0(sum(x=>x.expenses)),"As booked in GAAP on these days");
    $("#dDayTitle").textContent="Selected day · "+dayLabel(d.date);
  }
  $("#dTiles").innerHTML=
    T("Turnover incl. VAT",R0(d.tto),`Excl. VAT ${R0(d.actualSales)}`+(prev?delta(d.tto,prev.tto,R0):""))+
    T("Cost of sales",P1(d.cosPct),`${R0(d.cos)}`+(prev?delta(d.cosPct,prev.cosPct,P1,false):""),d.cosPct>=35?"short":"")+
    T("Gross profit",R0(d.gp),`${P1(d.gpPct)} of sales`)+
    T("Wastage",R0(dWaste(d)),wp!=null?`${P1(wp)} of sales excl. VAT`:"",wp>=2?"short":"")+
    T("Customers",N0(d.customers),`${R0(d.perCustomer)} each · ${N0(d.tables)} tables`)+
    T("Cash-up difference",fmtR(dCashDiff(d)??0),`Bankable ${fmtR(d.bankable)} · GAAP result ${fmtR(d.cashup)}`,Math.abs(dCashDiff(d))>=100?"short":"")+
    T("Staff hours",N0(lab?.hours),lab?`${N0(lab.qty)} people · ${R0(lab.ttoHr)} turnover per hour`:"")+
    T("Closing stock value",R0(d.stock?.closing),`Opening ${R0(d.stock?.opening)}`);
  const fl=dayFlags(d,others);
  $("#dFlags").innerHTML=fl.length?fl.sort((a,b)=>(a[0]==="hi"?0:1)-(b[0]==="hi"?0:1)).map(([s,t,x])=>`<div class="flag"><span class="sev ${s}">${s==="hi"?"High":"Check"}</span><div><b>${esc(t)}</b><span class="d">${esc(x)}</span></div></div>`).join(""):`<div class="flag"><span class="sev" style="background:var(--accent-soft);color:var(--accent)">OK</span><div><b>Nothing unusual on ${esc(dayLabel(d.date))}</b><span class="d">Cost of sales, cash-up, wastage and till exceptions are inside the normal range.</span></div></div>`;
  // comparison table, oldest to newest
  const asc=days.slice().reverse();
  $("#dCmpHead").innerHTML=`<tr><th>Figure</th>${asc.map(x=>`<th class="n${x.date===dSel?" sel":""}">${esc(dayLabel(x.date))}</th>`).join("")}${asc.length>1?'<th class="n">Average</th>':""}</tr>`;
  $("#dCmpBody").innerHTML=D_ROWS.map(r=>{
    if(r.length===1)return `<tr class="grp"><td colspan="${asc.length+(asc.length>1?2:1)}">${esc(r[0])}</td></tr>`;
    const [lbl,fn,fmt,judge]=r;const a=avgOf(asc,fn);
    return `<tr><td>${esc(lbl)}</td>${asc.map(x=>{let v;try{v=fn(x)}catch(e){v=null}const j=judge&&v!=null?(judge(x)||""):"";return `<td class="n${x.date===dSel?" sel":""}${j?" "+j:""}">${v==null?"—":fmt(v)}</td>`}).join("")}${asc.length>1?`<td class="n muted">${a==null?"—":fmt(a)}</td>`:""}</tr>`}).join("");
  // gaps between loaded days
  const miss=[];for(let k=1;k<asc.length;k++){let t=dayStart(asc[k-1].date)+864e5;const end=dayStart(asc[k].date);while(t<end){const dt=new Date(t);miss.push(`${WD[dt.getDay()]} ${dt.getDate()} ${MO[dt.getMonth()]}`);t+=864e5}}
  $("#dGap").textContent=miss.length?`No report loaded yet for ${miss.join(", ")}.`:"";
  // full report for the selected day
  $("#dDetailTitle").textContent="Full report · "+dayLabel(d.date);
  const kv=rows=>`<dl class="kv">${rows.map(([k,v,tot])=>`<dt${tot?' class="tot"':""}>${esc(k)}</dt><dd${tot?' class="tot"':""}>${v}</dd>`).join("")}</dl>`;
  const p=d.pay||{},s=d.stock||{},x=d.exc||{},pp=d.purchPay||{},ac=d.accounts||{};
  const EX=[["Voids","voids"],["Discounts","discounts"],["Maxi Club","maxiClub"],["Price overrides","priceOverrides"],["Table transfers","tableTransfers"],["Negative invoices","negInvoices"],["Non-banking","nonBanking"],["Change staff","changeStaff"]];
  const ch=[["Eat-in",d.eatIn,"var(--accent)"],["Take-out",d.takeOut,"var(--over)"],["Delivery",d.delivery,"var(--warn)"]];
  const ses=d.sessions||[];
  $("#dDetail").innerHTML=`
  <details open><summary>Takings &amp; cash-up <span>${R0(d.tto)} turnover</span></summary><div class="dbody">
    ${kv([["Cash",fmtR(p.cash)],["Cheque",fmtR(p.cheque)],["Credit card",fmtR(p.card)],["Account",fmtR(p.account)],["Non-banking",fmtR(p.nonBank)],["Total pay types",fmtR(p.total),1],["Less non-bank + reimbursements",fmtR(p.nonBank)],["Less tips",fmtR(d.tips)],["Less service charge",fmtR(d.serviceCharge||0)],["Turnover incl. VAT",fmtR(d.tto),1],["Less VAT",fmtR(d.tax)],["Turnover excl. VAT",fmtR(d.toExcl),1]])}
    ${kv([["Credit card levy",fmtR(d.ccLevy)],["Add breakages",fmtR(d.breakages)],["Add levy",fmtR(d.levy||0)],["Less tips",fmtR(d.tips)],["Less payouts",fmtR(d.payouts||0)],["Less earnings",fmtR(d.earnings||0)],["Less cash taken",fmtR(d.cashTaken)],["Bankable cash",fmtR(d.bankable),1],["Final cash-up result",fmtR(d.cashup),1]])}
  </div></details>
  <details><summary>Stock &amp; profit <span>${P1(d.cosPct)} cost of sales</span></summary><div class="dbody">
    ${kv([["Opening stock",fmtR(s.opening)],["Add purchases",fmtR(s.purchases)],["Add stock transfers in",fmtR(s.transIn||0)],["Less stock transfers out",fmtR(s.transOut||0)],["Add GRV invoice adjustments",fmtR(s.grvAdj||0)],["Less closing stock",fmtR(s.closing)],["Cost of sales",fmtR(d.cos),1]])}
    ${kv([["Menu item sales",fmtR(d.menuSales)],["Less non-bank + reimbursements",fmtR(d.nonBankReimb)],["Actual sales",fmtR(d.actualSales),1],["Less cost of sales",`${fmtR(d.cos)} (${P1(d.cosPct)})`],["Gross profit",`${fmtR(d.gp)} (${P1(d.gpPct)})`,1],["Less expenses",fmtR(d.expenses)],["Nett profit",fmtR(d.nett),1]])}
    ${kv([["Purchases on account",fmtR(pp.accounts||0)],["Purchases paid cash",fmtR(pp.cash||0)],["Stock variances",fmtR(d.stockVar||0)],["Wastage",fmtR(d.wastage)],["GRV claims",fmtR(d.grvClaims||0)],["Debtors invoiced",fmtR(ac.debtorsInv||0)],["Creditors invoiced",fmtR(ac.creditorsInv||0)]])}
  </div></details>
  <details><summary>Till exceptions <span>${N0(EX.reduce((t,[,k])=>t+(x[k]?.q||0),0))} entries</span></summary><div class="dbody">
    <div class="tablewrap"><table><thead><tr><th>Exception</th><th class="n">Qty</th><th class="n">Value</th><th class="n">% of turnover</th></tr></thead><tbody>
    ${EX.map(([l,k])=>{const e=x[k]||{q:0,v:0,p:0};const bad=(k==="voids"&&e.p>=3)||(k==="priceOverrides"&&Math.abs(e.p)>=3)||(k==="negInvoices"&&e.p>=1)||(k==="changeStaff"&&e.p>=10);return `<tr><td>${l}</td><td class="n">${N0(e.q)}</td><td class="n${bad?" ux":""}">${fmtR(e.v)}</td><td class="n${bad?" ux":""}">${P1(e.p)}</td></tr>`}).join("")}
    </tbody></table></div>
    <p class="muted" style="margin:0;font-size:.85rem">Bill prints after the first: ${N0(d.billPrintExc)} · Staff clock edits: ${N0(d.staffLogEdit)} · Price level changes: ${N0(d.pLevelAct)} · Day-end stock edits: ${N0(d.dEndStockEdit)}</p>
  </div></details>
  <details><summary>Customers &amp; sessions <span>${N0(d.customers)} customers</span></summary><div class="dbody">
    ${kv([["Invoices",`${N0(d.invoices)} · ${R0(d.perInvoice)} each`],["Customers",`${N0(d.customers)} · ${R0(d.perCustomer)} each`],["Tables",`${N0(d.tables)} · ${R0(d.perTable)} each`],["Tables per hour",N0(d.tablesPerHr)],["Minutes per table",N0(d.minsPerTable)],["Trading hours",N0(d.hours)]])}
    <div class="tablewrap"><table><thead><tr><th>Session</th><th class="n">Recorded</th><th class="n">%</th><th class="n">Ordered</th><th class="n">%</th></tr></thead><tbody>
    ${ses.map(r=>`<tr><td>${esc(r.name)}</td><td class="n">${fmtR(r.rec)}</td><td class="n">${P1(r.recPct)}</td><td class="n">${fmtR(r.ord)}</td><td class="n">${P1(r.ordPct)}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="splitbar" role="img" aria-label="Eat-in, take-out and delivery split">${ch.map(([,c,col])=>`<i style="width:${Math.max(0,c?.p||0)}%;background:${col}"></i>`).join("")}</div>
    <div class="legend">${ch.map(([l,c,col])=>`<span><i style="background:${col}"></i>${l} ${R0(c?.v)} (${P1(c?.p)})</span>`).join("")}</div>
  </div></details>
  <details><summary>Staff <span>${N0(lab?.hours)} hours</span></summary><div class="dbody">
    <div class="tablewrap"><table><thead><tr><th>Role</th><th class="n">People</th><th class="n">Hours</th><th class="n">Staff turnover</th><th class="n">Turnover / person</th><th class="n">Turnover / hour</th><th class="n">Hours / person</th></tr></thead><tbody>
    ${(d.staff||[]).map(r=>`<tr${r.role==="Total"?' style="font-weight:600"':""}><td>${esc(r.role)}</td><td class="n">${N0(r.qty)}</td><td class="n">${N0(r.hours)}</td><td class="n">${R0(r.sto)}</td><td class="n">${R0(r.ttoPer)}</td><td class="n">${R0(r.ttoHr)}</td><td class="n">${N0(r.hoursPer)}</td></tr>`).join("")}
    </tbody></table></div>
  </div></details>
  <p class="muted" style="margin:0;font-size:.82rem">Report no. ${esc(d.drn)}, printed ${esc(d.printed||"")}. Stock deducted up to ${esc(d.lastDeduct||"")}.</p>`;
}
$("#dDays").addEventListener("click",e=>{const b=e.target.closest("[data-day]");if(!b)return;dSel=b.dataset.day;renderDaily()});
$("#dCsv").addEventListener("click",()=>{
  const asc=daily.slice().sort((a,b)=>a.date<b.date?-1:1);if(!asc.length)return;
  const rows=D_ROWS.filter(r=>r.length>1);
  const lines=[["Date","Day",...rows.map(r=>r[0])].map(csvCell).join(",")];
  asc.forEach(d=>lines.push([d.date,WD[new Date(dayStart(d.date)).getDay()],...rows.map(r=>{let v;try{v=r[1](d)}catch(e){v=null}return v==null?"":Math.round(v*100)/100})].map(csvCell).join(",")));
  offer("ou-meul-daily-trading.csv",lines.join("\r\n"));
});

/* ---------- staff hours (GAAP staff hours report) ---------- */
// staff/{id}: {name, role, rate (R/hour), active}; shifts/{id}: {date, staffId, name, role, in, out, hours, source}
// settings/main.roleRates: {role: R/hour} — fallback rate, and used to estimate days that only have the Management Overview role hours.
const ROLES=["Managers","Waiters","Bar Staff","Kitchen Staff","Owners"];
let staff=[], shifts=[], sPeriodSel=ls.get("om-speriod")||null, sRmArmed=null;
const H1=n=>n==null?"—":(Math.round(n*100)/100).toLocaleString("en-ZA",{maximumFractionDigits:2});
const roleRate=r=>{const v=Number((settings.roleRates||{})[r]);return v>0?v:null};
// South African public holidays (a holiday on a Sunday moves to the Monday). Editable in Pay rates.
const DEFAULT_HOLS=["2026-01-01","2026-03-21","2026-04-03","2026-04-06","2026-04-27","2026-05-01","2026-06-16","2026-08-10","2026-09-24","2026-12-16","2026-12-25","2026-12-26","2027-01-01","2027-03-22","2027-03-26","2027-03-29","2027-04-27","2027-05-01","2027-06-16","2027-08-09","2027-09-24","2027-12-16","2027-12-25","2027-12-27"];
const baseRate=()=>{const v=Number(settings.baseRate);return v>0?v:null};
// Managers are not on the standard rate: they need their own rate or a Managers role rate.
const fallbackRate=role=>roleRate(role)??(role==="Managers"?null:baseRate());
// Monthly-salaried people (staff.pay==="salary"): hours are tracked, but they are left out of hourly pay and labour cost.
const isSal=p=>!!p&&p.pay==="salary";
const shiftSal=(x,byId)=>isSal(byId[x.staffId]);
const premX=()=>{const v=Number(settings.sundayX);return v>=1?v:1.5};
const holSet=()=>new Set(Array.isArray(settings.holidays)?settings.holidays:DEFAULT_HOLS);
const isHol=d=>holSet().has(d);
const isSun=d=>new Date(dayStart(d)).getDay()===0;
const dayMult=d=>(isSun(d)||isHol(d))?premX():1;
const dayType=d=>isHol(d)?"Public holiday":isSun(d)?"Sunday":"Normal";
const staffById=()=>Object.fromEntries(staff.map(p=>[p.id,p]));
function rateFor(sh,byId){const p=byId[sh.staffId];const v=p&&Number(p.rate)>0?Number(p.rate):null;return v??fallbackRate((p&&p.role)||sh.role)}
function shiftPay(x,byId){if(shiftSal(x,byId))return null;const r=rateFor(x,byId);return r==null?null:(Number(x.hours)||0)*r*dayMult(x.date)}
function weekStart(iso){const t=new Date(dayStart(iso));const k=(t.getDay()+6)%7;t.setDate(t.getDate()-k);return t}
const isoOf=t=>`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`;
function sAllDates(){const s=new Set();daily.forEach(d=>s.add(d.date));shifts.forEach(x=>x.date&&s.add(x.date));return [...s].sort()}
function sPeriods(){
  const ds=sAllDates();if(!ds.length)return [];
  const out=[],wk=new Map(),mo=new Map();
  ds.forEach(d=>{const w=isoOf(weekStart(d));wk.set(w,true);mo.set(d.slice(0,7),true)});
  [...wk.keys()].sort().reverse().forEach(w=>{const e=new Date(dayStart(w));e.setDate(e.getDate()+6);out.push({id:"w:"+w,label:`Week ${dayLabel(w,true)} – ${dayLabel(isoOf(e),true)}`,from:w,to:isoOf(e)})});
  [...mo.keys()].sort().reverse().forEach(m=>{const [y,mm]=m.split("-").map(Number);const last=new Date(y,mm,0).getDate();out.push({id:"m:"+m,label:`${MO[mm-1]} ${y}`,from:m+"-01",to:`${m}-${String(last).padStart(2,"0")}`})});
  out.push({id:"all",label:"All loaded days",from:ds[0],to:ds[ds.length-1]});
  return out;
}
// one day's labour: clock hours when a staff hours report is loaded, otherwise an estimate from the GAAP role hours
function dayLab(date,byId){
  const d=daily.find(x=>x.date===date)||null, sh=shifts.filter(x=>x.date===date);
  const gaapHours=d?(d.staff||[]).find(r=>r.role==="Total")?.hours??null:null;
  const sales=d?d.actualSales:null;
  if(sh.length){
    let hours=0,cost=0,noRate=0,sal=0;const ppl=new Set();
    sh.forEach(x=>{const h=Number(x.hours)||0;hours+=h;ppl.add(x.staffId||x.name);if(shiftSal(x,byId)){sal+=h;return}const r=rateFor(x,byId);if(r==null){if(h>0)noRate+=h}else cost+=h*r*dayMult(date)});
    return {date,basis:"clock",hours,cost,noRate,sal,people:ppl.size,gaapHours,sales,d,sh};
  }
  if(d&&(d.staff||[]).length){
    let hours=0,cost=0,noRate=0,sal=0,people=0;
    d.staff.filter(r=>r.role!=="Total").forEach(r=>{const h=Number(r.hours)||0;hours+=h;people+=Number(r.qty)||0;const rr=fallbackRate(r.role);if(rr==null){if(r.role==="Managers"||r.role==="Owners")sal+=h;else if(h>0)noRate+=h}else cost+=h*rr*dayMult(date)});
    return {date,basis:"est",hours,cost,noRate,sal,people,gaapHours,sales,d,sh};
  }
  return {date,basis:"none",hours:0,cost:0,noRate:0,sal:0,people:0,gaapHours,sales,d,sh};
}
function renderStaff(){
  const per=sPeriods();
  $("#sNewRole").innerHTML=ROLES.map(r=>`<option>${esc(r)}</option>`).join("");
  const payFocus=[$("#sBaseRate"),$("#sSunX"),$("#sHols")].includes(document.activeElement);
  if(!payFocus){$("#sBaseRate").value=baseRate()??"";$("#sSunX").value=premX();$("#sHols").value=[...holSet()].sort().join(", ")}
  [$("#sBaseRate"),$("#sSunX"),$("#sHols")].forEach(i=>i.disabled=!canWrite);
  if(!$("#sRoleRates").contains(document.activeElement))$("#sRoleRates").innerHTML=ROLES.map(r=>`<div class="field"><label for="rr-${esc(r)}">${esc(r)}</label><input id="rr-${esc(r)}" data-role="${esc(r)}" type="number" step="any" min="0" inputmode="decimal" value="${roleRate(r)??""}"${canWrite?"":" disabled"}></div>`).join("");
  $("#sSaveRates").disabled=!canWrite;$("#sAdd").disabled=!canWrite;$("#sAddWrap").hidden=!canWrite;
  if(!per.length){
    $("#sPeriod").innerHTML='<option>No days loaded yet</option>';
    $("#sTiles").innerHTML="";$("#sDayBody").innerHTML='<tr><td colspan="9" class="muted">No staff hours or daily reports loaded yet. The owner loads them from the Team tab (Import data).</td></tr>';
    $("#sFlags").innerHTML="";$("#sGridWrap").hidden=true;$("#sPayWrap").hidden=true;$("#sRepHead").innerHTML="";$("#sRepBody").innerHTML='<tr><td class="muted">No staff hours loaded yet.</td></tr>';renderStaffPeople(null,{});return;
  }
  if(!per.some(p=>p.id===sPeriodSel))sPeriodSel=(per.find(p=>shifts.some(x=>x.date>=p.from&&x.date<=p.to))||per[0]).id;
  $("#sPeriod").innerHTML=per.map(p=>`<option value="${esc(p.id)}"${p.id===sPeriodSel?" selected":""}>${esc(p.label)}</option>`).join("");
  const P=per.find(p=>p.id===sPeriodSel), byId=staffById();
  const dates=sAllDates().filter(d=>d>=P.from&&d<=P.to);
  const labs=dates.map(d=>dayLab(d,byId));
  const sum=f=>labs.reduce((t,x)=>t+(Number(f(x))||0),0);
  const hrs=sum(x=>x.hours), cost=sum(x=>x.cost), noRate=sum(x=>x.noRate), salH=sum(x=>x.sal);
  const salesDays=labs.filter(x=>x.sales!=null), sales=salesDays.reduce((t,x)=>t+x.sales,0);
  const costSales=labs.filter(x=>x.sales!=null).reduce((t,x)=>t+x.cost,0);
  const nClock=labs.filter(x=>x.basis==="clock").length, nEst=labs.filter(x=>x.basis==="est").length;
  const pct=sales&&costSales?costSales/sales*100:null;
  const T=(lbl,v,sub,cls)=>`<div class="tile${cls?" "+cls:""}"><div class="lbl">${lbl}</div><div class="v">${v}</div>${sub?`<div class="sub">${sub}</div>`:""}</div>`;
  const anyRate=baseRate()!=null||ROLES.some(r=>roleRate(r)!=null)||staff.some(p=>Number(p.rate)>0);
  $("#sTiles").innerHTML=
    T("Labour cost",anyRate?R0(cost):"—",anyRate?(noRate?`${H1(noRate)} hours have no rate yet`:"Hourly staff · Sundays & public holidays ×"+N0(premX()))+(salH?` · excludes ${H1(salH)} salaried hours`:""):"Add hourly rates below")+
    T("Labour % of sales",pct==null?"—":P1(pct),sales?`On ${R0(sales)} sales excl. VAT`:"No sales loaded for these days",pct!=null&&pct>=35?"short":"")+
    T("Staff hours",H1(hrs),`${labs.length} day${labs.length===1?"":"s"} · ${H1(labs.filter(x=>dayMult(x.date)>1).reduce((t,x)=>t+x.hours,0))} on Sundays & public holidays`)+
    T("Sales per staff hour",hrs&&sales?R0(sales/hrs):"—","Sales excl. VAT ÷ hours")+
    T("Hours from",`${nClock} / ${labs.length}`,nClock===labs.length?"All days from the staff hours report":`${nEst} day${nEst===1?"":"s"} estimated from GAAP role hours`);
  // day by day
  $("#sDayBody").innerHTML=labs.slice().reverse().map(x=>{
    const lp=x.sales&&x.cost?x.cost/x.sales*100:null;
    const b=x.basis==="clock"?'<span class="basis clock">Clock report</span>':x.basis==="est"?'<span class="basis est">Estimate</span>':'<span class="muted">—</span>';
    const gd=x.basis==="clock"&&x.gaapHours!=null?x.hours-x.gaapHours:null;
    return `<tr><td>${esc(dayLabel(x.date))}</td><td>${b}</td><td class="n">${N0(x.people)}</td><td class="n">${H1(x.hours)}</td><td class="n${gd!=null&&Math.abs(gd)>=2?" ux":""}">${H1(x.gaapHours)}</td><td class="n">${anyRate?R0(x.cost):"—"}</td><td class="n">${R0(x.sales)}</td><td class="n${lp!=null&&lp>=35?" ux":""}">${P1(lp)}</td><td class="n">${x.hours&&x.sales?R0(x.sales/x.hours):"—"}</td></tr>`}).join("");
  $("#sDayNote").textContent="Labour % is labour cost ÷ sales excl. VAT. Estimated days use the role hours GAAP prints on the Management Overview Report × the role rate."+(nClock?" GAAP role hours are shown next to clock-report days so the two can be checked against each other.":"");
  // hours per person grid (clock-report days only)
  const shP=shifts.filter(x=>x.date>=P.from&&x.date<=P.to);
  $("#sGridWrap").hidden=!shP.length;
  if(shP.length){
    const cd=[...new Set(shP.map(x=>x.date))].sort();
    const keyOf=x=>x.staffId||("n:"+x.name);
    const ppl=new Map();shP.forEach(x=>{const k=keyOf(x);if(!ppl.has(k)){const p=byId[x.staffId];ppl.set(k,{k,name:p?.name||x.name||"?",role:p?.role||x.role||"Other"})}});
    const order=[...ROLES,"Other"];
    const rows=[...ppl.values()].sort((a,b)=>(order.indexOf(a.role)+1||99)-(order.indexOf(b.role)+1||99)||a.name.localeCompare(b.name));
    $("#sGridHead").innerHTML=`<tr><th>Person</th>${cd.map(d=>`<th class="n">${esc(dayLabel(d))}</th>`).join("")}<th class="n">Hours</th><th class="n">Cost</th></tr>`;
    let lastRole=null;
    $("#sGridBody").innerHTML=rows.map(r=>{
      const grp=r.role!==lastRole?`<tr class="rgrp"><td colspan="${cd.length+3}">${esc(r.role)}</td></tr>`:"";lastRole=r.role;
      let th=0,tc=0;
      const cells=cd.map(d=>{const xs=shP.filter(x=>x.date===d&&keyOf(x)===r.k);if(!xs.length)return '<td class="n off">·</td>';const h=xs.reduce((t,x)=>t+(Number(x.hours)||0),0);th+=h;xs.forEach(x=>{const pv=shiftPay(x,byId);if(pv!=null)tc+=pv});const tip=xs.map(x=>`${x.in||"?"}–${x.out||"?"}`).join(", ");return `<td class="n${h>12?" long":""}" title="${esc(tip)}">${H1(h)}</td>`}).join("");
      return grp+`<tr><td>${esc(r.name)}</td>${cells}<td class="n"><b>${H1(th)}</b></td><td class="n">${anyRate?R0(tc):"—"}</td></tr>`}).join("");
  }
  renderPaySheet(P,byId);renderDayReport(P,byId);
  // flags
  const f=[];
  shP.forEach(x=>{const h=Number(x.hours)||0,nm=byId[x.staffId]?.name||x.name;if(!x.out||!h)f.push(["hi",`No clock-out: ${nm}, ${dayLabel(x.date)}`,`Clocked in ${x.in||"?"} with no clock-out on the report. Check the clock record in GAAP before paying.`]);else if(h>12)f.push(["md",`Long shift: ${nm} ${H1(h)} hours on ${dayLabel(x.date)}`,`${x.in||"?"} to ${x.out||"?"}. Check it wasn't a missed clock-out.`])});
  labs.forEach(x=>{if(x.basis==="clock"&&x.gaapHours!=null&&Math.abs(x.hours-x.gaapHours)>=2)f.push(["md",`${dayLabel(x.date)}: staff report ${H1(x.hours)} h vs GAAP ${H1(x.gaapHours)} h`,"The staff hours report and the Management Overview don't agree for this day. One of the two may be missing a person or a clock-out."]);
    const lp=x.sales&&x.cost?x.cost/x.sales*100:null;if(lp!=null&&lp>=35)f.push(["md",`Labour ${P1(lp)} of sales on ${dayLabel(x.date)}`,`${R0(x.cost)} labour on ${R0(x.sales)} sales excl. VAT.`])});
  const ed=labs.filter(x=>x.d&&x.d.staffLogEdit>=1);
  if(ed.length){const n=ed.reduce((t,x)=>t+x.d.staffLogEdit,0);f.push([ed.some(x=>x.d.staffLogEdit>=3)?"hi":"md",`${n} clock-time edit${n>1?"s":""} in this period`,ed.map(x=>`${dayLabel(x.date,true)}: ${x.d.staffLogEdit}`).join(" · ")+". Clock times were changed after the fact (GAAP staff log edits). Check who changed what."])}
  if(noRate)f.push(["md",`${H1(noRate)} hours have no hourly rate`,"Add a rate for the role or the person below so the labour cost is complete."]);
  $("#sFlags").innerHTML=f.length?f.sort((a,b)=>(a[0]==="hi"?0:1)-(b[0]==="hi"?0:1)).map(([s,t,x])=>`<div class="flag"><span class="sev ${s}">${s==="hi"?"High":"Check"}</span><div><b>${esc(t)}</b><span class="d">${esc(x)}</span></div></div>`).join(""):`<div class="flag"><span class="sev" style="background:var(--accent-soft);color:var(--accent)">OK</span><div><b>Nothing unusual in this period</b><span class="d">No missed clock-outs, long shifts or clock edits.</span></div></div>`;
  renderStaffPeople(P,byId);
}
function repData(P,byId){
  const shP=shifts.filter(x=>x.date>=P.from&&x.date<=P.to);
  const dates=[...new Set(shP.map(x=>x.date))].sort();
  const rates=new Map(); // key -> {rate, prem}
  const rows=dates.map(d=>{const r={date:d,by:{},sal:0,hrs:0,val:0};
    shP.filter(x=>x.date===d).forEach(x=>{const h=Number(x.hours)||0;r.hrs+=h;
      if(shiftSal(x,byId)){r.sal+=h;return}
      const base=rateFor(x,byId);if(base==null){r.by.none=(r.by.none||{h:0,v:0});r.by.none.h+=h;rates.set("none",{rate:null,prem:false});return}
      const er=base*dayMult(d),k=er.toFixed(4);if(!rates.has(k))rates.set(k,{rate:er,prem:dayMult(d)>1});
      const c=r.by[k]=r.by[k]||{h:0,v:0};c.h+=h;c.v+=h*er;r.val+=h*er});
    return r});
  const keys=[...rates.keys()].sort((a,b)=>(rates.get(a).rate??1e9)-(rates.get(b).rate??1e9));
  return {rows,keys,rates,anySal:rows.some(r=>r.sal>0)};
}
function renderDayReport(P,byId){
  const {rows,keys,rates,anySal}=repData(P,byId);
  if(!rows.length){$("#sRepHead").innerHTML="";$("#sRepBody").innerHTML='<tr><td class="muted">No staff hours loaded for this period yet. The owner loads them from the Team tab (Import data).</td></tr>';$("#sRepNote").textContent="";return}
  const lbl=k=>{const r=rates.get(k);return r.rate==null?'No rate<span class="rt">set a rate</span>':`${fmtR(r.rate)}/h<span class="rt">${r.prem?"Sunday & public holiday":"Normal"}</span>`};
  $("#sRepHead").innerHTML=`<tr><th rowspan="2">Day</th>${keys.map(k=>`<th class="n${rates.get(k).prem?" prem":""}" colspan="2">${lbl(k)}</th>`).join("")}${anySal?'<th class="n" rowspan="2">Salaried<span class="rt">hours</span></th>':""}<th class="n" colspan="2">Total</th></tr>
  <tr>${keys.map(k=>`<th class="n${rates.get(k).prem?" prem":""}">Hours</th><th class="n${rates.get(k).prem?" prem":""}">Value</th>`).join("")}<th class="n">Hours</th><th class="n">Value</th></tr>`;
  const T={by:{},sal:0,hrs:0,val:0};
  const cell=(c,prem)=>c?`<td class="n${prem?" prem":""}">${H1(c.h)}</td><td class="n${prem?" prem":""}">${c.v?fmtR(c.v):"—"}</td>`:`<td class="n off${prem?" prem":""}">·</td><td class="n off${prem?" prem":""}">·</td>`;
  $("#sRepBody").innerHTML=rows.map(r=>{
    keys.forEach(k=>{if(r.by[k]){const t=T.by[k]=T.by[k]||{h:0,v:0};t.h+=r.by[k].h;t.v+=r.by[k].v}});T.sal+=r.sal;T.hrs+=r.hrs;T.val+=r.val;
    return `<tr><td class="dl">${esc(dayLabel(r.date))}${isHol(r.date)?' <span class="muted" style="font-weight:400">(public holiday)</span>':""}</td>${keys.map(k=>cell(r.by[k],rates.get(k).prem)).join("")}${anySal?`<td class="n${r.sal?"":" off"}">${r.sal?H1(r.sal):"·"}</td>`:""}<td class="n"><b>${H1(r.hrs)}</b></td><td class="n pay">${fmtR(r.val)}</td></tr>`}).join("")+
    `<tr class="tot"><td>Total</td>${keys.map(k=>cell(T.by[k],rates.get(k).prem)).join("")}${anySal?`<td class="n">${H1(T.sal)}</td>`:""}<td class="n">${H1(T.hrs)}</td><td class="n pay">${fmtR(T.val)}</td></tr>`;
  $("#sRepNote").textContent=`${rows.length} day${rows.length===1?"":"s"} with hours loaded. Value = hours × rate. Sundays and public holidays are paid at ×${N0(premX())}.`+(anySal?" Salaried staff (managers, Enock) show hours only.":"");
}
function renderPaySheet(P,byId){
  const shP=shifts.filter(x=>x.date>=P.from&&x.date<=P.to);
  $("#sPayWrap").hidden=!shP.length;if(!shP.length){$("#sPay").innerHTML="";return}
  const X=premX(),br=baseRate();
  $("#sPayNote").textContent=`Hours from the GAAP clock report. Normal days at each person's rate${br?` (standard ${fmtR(br)}/hour)`:""}; Sundays and public holidays at ×${N0(X)}${br?` (${fmtR(br*X)}/hour)`:""}. Shaded columns are Sundays or public holidays.`;
  const weeks=[...new Set(shP.map(x=>isoOf(weekStart(x.date))))].sort().reverse();
  const keyOf=x=>x.staffId||("n:"+x.name);
  $("#sPay").innerHTML=weeks.map(w=>{
    const days=[...Array(7)].map((_,k)=>{const t=new Date(dayStart(w));t.setDate(t.getDate()+k);return isoOf(t)});
    const ws=shP.filter(x=>x.date>=days[0]&&x.date<=days[6]);
    const ppl=new Map();ws.forEach(x=>{const k=keyOf(x);if(!ppl.has(k)){const p=byId[x.staffId];ppl.set(k,{k,name:p?.name||x.name||"?",role:p?.role||x.role||""})}});
    const rows=[...ppl.values()].sort((a,b)=>a.name.localeCompare(b.name));
    const colT=days.map(()=>0);let gN=0,gP=0,gNP=0,gPP=0;
    const body=rows.map(r=>{
      let nh=0,ph=0,np=0,pp=0,rate=null,noR=false;const salaried=isSal(byId[(r.k||"")]);
      const cells=days.map((d,k)=>{const xs=ws.filter(x=>x.date===d&&keyOf(x)===r.k);const prem=dayMult(d)>1;
        if(!xs.length)return `<td class="n off${prem?" prem":""}">·</td>`;
        const h=xs.reduce((t,x)=>t+(Number(x.hours)||0),0);colT[k]+=h;
        xs.forEach(x=>{const rt=salaried?null:rateFor(x,byId);if(rt!=null)rate=rt;else noR=true;const pv=shiftPay(x,byId)||0;if(prem){ph+=Number(x.hours)||0;pp+=pv}else{nh+=Number(x.hours)||0;np+=pv}});
        const tip=xs.map(x=>`${x.in||"?"}–${x.out||"?"}${x.hms?` (${x.hms})`:""}`).join(", ");
        return `<td class="n${prem?" prem":""}${h>12?" ux":""}" title="${esc(tip)}">${H1(h)}</td>`}).join("");
      gN+=nh;gP+=ph;gNP+=np;gPP+=pp;
      const pf=v=>salaried?'<span class="muted">monthly salary</span>':noR&&rate==null?'<span class="muted">rate not set</span>':fmtR(v);
      return `<tr><td>${esc(r.name)}${r.role==="Managers"?' <span class="muted" style="font-size:.78rem">manager</span>':""}</td><td class="n">${salaried?'<span class="muted">Salary</span>':rate!=null?fmtR(rate):'<span class="muted">—</span>'}</td>${cells}<td class="n">${H1(nh)}</td><td class="n prem">${H1(ph)}</td><td class="n">${pf(np)}</td><td class="n prem">${pf(pp)}</td><td class="n pay">${pf(np+pp)}</td></tr>`}).join("");
    const e=new Date(dayStart(days[6]));
    return `<div style="display:grid;gap:6px"><div class="spayhead"><h4>Week ${esc(dayLabel(days[0],true))} – ${esc(dayLabel(days[6],true))}</h4><span>${rows.length} ${rows.length===1?"person":"people"} · ${H1(gN+gP)} hours · ${fmtR(gNP+gPP)}</span></div>
    <div class="tablewrap"><table class="spay"><thead><tr><th>Name</th><th class="n">Rate</th>${days.map(d=>`<th class="n${dayMult(d)>1?" prem":""}">${esc(dayLabel(d))}${isHol(d)?" (PH)":""}</th>`).join("")}<th class="n">Normal hrs</th><th class="n prem">Sun/PH hrs</th><th class="n">Normal pay</th><th class="n prem">Sun/PH pay ×${N0(X)}</th><th class="n">Total pay</th></tr></thead>
    <tbody>${body}<tr class="tot"><td>Total</td><td></td>${colT.map((h,k)=>`<td class="n${dayMult(days[k])>1?" prem":""}">${h?H1(h):"·"}</td>`).join("")}<td class="n">${H1(gN)}</td><td class="n prem">${H1(gP)}</td><td class="n">${fmtR(gNP)}</td><td class="n prem">${fmtR(gPP)}</td><td class="n pay">${fmtR(gNP+gPP)}</td></tr></tbody></table></div></div>`}).join("");
}
function renderStaffPeople(P,byId){
  const shP=P?shifts.filter(x=>x.date>=P.from&&x.date<=P.to):[];
  const list=staff.filter(p=>p.active!==false).sort((a,b)=>(ROLES.indexOf(a.role)+1||99)-(ROLES.indexOf(b.role)+1||99)||(a.name||"").localeCompare(b.name||""));
  $("#sPplTitle").textContent=`People (${list.length})`;
  if($("#sPplBody").contains(document.activeElement))return;
  $("#sPplBody").innerHTML=list.length?list.map(p=>{
    const xs=shP.filter(x=>x.staffId===p.id),h=xs.reduce((t,x)=>t+(Number(x.hours)||0),0),days=new Set(xs.map(x=>x.date)).size;
    const pays=xs.map(x=>shiftPay(x,byId)),pay=pays.some(v=>v!=null)?pays.reduce((t,v)=>t+(v||0),0):null;
    const dis=canWrite?"":" disabled";
    return `<tr data-sid="${esc(p.id)}"><td>${esc(p.name)}</td><td><select data-f="role"${dis}>${[...ROLES,...(ROLES.includes(p.role)?[]:[p.role||"Other"])].map(r=>`<option${r===p.role?" selected":""}>${esc(r)}</option>`).join("")}</select></td><td><select data-f="pay"${dis}><option value="hourly"${isSal(p)?"":" selected"}>Hourly</option><option value="salary"${isSal(p)?" selected":""}>Monthly salary</option></select></td><td class="n">${isSal(p)?'<span class="muted">—</span>':`<input class="srate" data-f="rate" type="number" step="any" min="0" inputmode="decimal" value="${Number(p.rate)>0?p.rate:""}" placeholder="${fallbackRate(p.role)??"not set"}"${dis}>`}</td><td class="n">${N0(days)}</td><td class="n">${H1(h)}</td><td class="n">${isSal(p)?'<span class="muted">salary</span>':pay!=null?fmtR(pay):"—"}</td><td>${canWrite?`<button class="btn ghost" data-rm="${esc(p.id)}">${sRmArmed===p.id?"Tap again":"Remove"}</button>`:""}</td></tr>`}).join("")
    :'<tr><td colspan="8" class="muted">No people yet. They are added automatically from the first GAAP staff hours report, or add them here.</td></tr>';
}
$("#sPeriod").addEventListener("change",e=>{sPeriodSel=e.target.value;ls.set("om-speriod",sPeriodSel);renderStaff()});
$("#sSaveRates").addEventListener("click",async()=>{
  const rr={};document.querySelectorAll("#sRoleRates input[data-role]").forEach(i=>{const v=Number(i.value);if(i.value!==""&&v>0)rr[i.dataset.role]=v});
  const hols=$("#sHols").value.split(/[\s,;]+/).map(x=>x.trim()).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x));
  const br=Number($("#sBaseRate").value),sx=Number($("#sSunX").value);
  settings={...settings,roleRates:rr,baseRate:br>0?br:0,sundayX:sx>=1?sx:1.5,holidays:[...new Set(hols)].sort()};
  if(db&&canWrite)try{await db.doc("settings/pay").set(paySettings());toast("Pay rates saved")}catch(err){writeErr(err)}
  renderStaff();
});
$("#sPplBody").addEventListener("change",async e=>{
  const el=e.target.closest("[data-f]");if(!el||!canWrite)return;const id=el.closest("tr").dataset.sid;
  const val=el.dataset.f==="rate"?(el.value===""?0:Number(el.value)):el.value;
  if(el.dataset.f==="rate"&&!(val>=0))return;
  try{await db.doc("staff/"+id).update({[el.dataset.f]:val});toast("Saved")}catch(err){writeErr(err)}
});
$("#sPplBody").addEventListener("click",async e=>{
  const b=e.target.closest("[data-rm]");if(!b||!canWrite)return;const id=b.dataset.rm;
  if(sRmArmed!==id){sRmArmed=id;renderStaff();return}
  sRmArmed=null;try{await db.doc("staff/"+id).update({active:false});toast("Removed from the list (past hours are kept)")}catch(err){writeErr(err)}
});
$("#sAdd").addEventListener("click",async()=>{
  const name=$("#sNewName").value.trim();if(!name||!canWrite){if(!name)toast("Type a name first");return}
  const id=name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||("p"+Date.now());
  const ex=staff.find(p=>p.id===id);
  const rate=Number($("#sNewRate").value)||0;
  const base={...(ex||{})};delete base.id;
  try{await db.doc("staff/"+id).set({...base,name,role:$("#sNewRole").value,rate,active:true});$("#sNewName").value="";$("#sNewRate").value="";toast(ex?"Person updated":"Person added")}catch(err){writeErr(err)}
});
$("#sCsv").addEventListener("click",()=>{
  const per=sPeriods(),P=per.find(p=>p.id===sPeriodSel);if(!P)return;const byId=staffById();
  const {rows,keys,rates,anySal}=repData(P,byId);if(!rows.length){toast("No staff hours in this period");return}
  const rl=k=>{const r=rates.get(k);return r.rate==null?"No rate":`R${(r.rate+1e-9).toFixed(2)}/h${r.prem?" Sun/PH":""}`};
    const f=n=>Math.round(n*100)/100;
  const dayRows=[["Date","Day",...keys.flatMap(k=>[rl(k)+" hours",rl(k)+" value (R)"]),...(anySal?["Salaried hours"]:[]),"Total hours","Total value (R)"]];
  const T={by:{},sal:0,hrs:0,val:0};
  rows.forEach(r=>{keys.forEach(k=>{if(r.by[k]){const t=T.by[k]=T.by[k]||{h:0,v:0};t.h+=r.by[k].h;t.v+=r.by[k].v}});T.sal+=r.sal;T.hrs+=r.hrs;T.val+=r.val;
    dayRows.push([r.date,WD[new Date(dayStart(r.date)).getDay()]+(isHol(r.date)?" (public holiday)":""),...keys.flatMap(k=>r.by[k]?[f(r.by[k].h),f(r.by[k].v)]:["",""]),...(anySal?[r.sal?f(r.sal):""]:[]),f(r.hrs),f(r.val)])});
  dayRows.push(["Total","",...keys.flatMap(k=>T.by[k]?[f(T.by[k].h),f(T.by[k].v)]:["",""]),...(anySal?[f(T.sal)]:[]),f(T.hrs),f(T.val)]);
  // per person
  const shP=shifts.filter(x=>x.date>=P.from&&x.date<=P.to);
  const pm=new Map();
  shP.forEach(x=>{const p=byId[x.staffId];const k=x.staffId||x.name;const o=pm.get(k)||{name:p?.name||x.name,role:p?.role||x.role||"",sal:isSal(p),rate:null,days:new Set(),nh:0,ph:0,np:0,pp:0};
    const h=Number(x.hours)||0;o.days.add(x.date);const prem=dayMult(x.date)>1;
    if(!o.sal){const r=rateFor(x,byId);if(r!=null)o.rate=r;const v=shiftPay(x,byId)||0;if(prem){o.ph+=h;o.pp+=v}else{o.nh+=h;o.np+=v}}else{if(prem)o.ph+=h;else o.nh+=h}
    pm.set(k,o)});
  const pRows=[["Name","Role","Pay","Rate (R/hour)","Days worked","Normal hours","Normal pay (R)","Sun/PH hours","Sun/PH pay (R)","Total hours","Total pay (R)"]];
  let tn=0,tp=0,tnp=0,tpp=0;
  [...pm.values()].sort((a,b)=>(a.sal-b.sal)||a.name.localeCompare(b.name)).forEach(o=>{tn+=o.nh;tp+=o.ph;if(!o.sal){tnp+=o.np;tpp+=o.pp}
    pRows.push([o.name,o.role,o.sal?"Monthly salary":"Hourly",o.sal?"":(o.rate??""),o.days.size,f(o.nh),o.sal?"":f(o.np),f(o.ph),o.sal?"":f(o.pp),f(o.nh+o.ph),o.sal?"":f(o.np+o.pp)])});
  pRows.push(["Total","","","","",f(tn),f(tnp),f(tp),f(tpp),f(tn+tp),f(tnp+tpp)]);
  // every shift
  const sRows=[["Date","Day","Name","Role","Clock in","Clock out","Hours","Day type","Rate (R/hour)","Multiplier","Pay (R)"]];
  shP.slice().sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:(a.name||"").localeCompare(b.name||"")).forEach(x=>{const p=byId[x.staffId],sal=isSal(p),r=sal?null:rateFor(x,byId),h=Number(x.hours)||0;
    sRows.push([x.date,WD[new Date(dayStart(x.date)).getDay()],p?.name||x.name,p?.role||x.role||"",x.in||"",x.out||"",f(h),dayType(x.date),sal?"Salary":(r??""),dayMult(x.date),sal?"":(r!=null?f(h*r*dayMult(x.date)):"")])});
  offerXlsx(`ou-meul-staff-hours-${P.id.replace(/[^a-z0-9-]/gi,"")}.xlsx`,[["Day by day",dayRows],["Per person",pRows],["Shifts",sRows]]);
});

function renderAll(){
  renderSessions();
  if(tab==="count"){renderChips();renderCountList()}
  else if(tab==="variance")renderVariance();
  else if(tab==="sheets")renderSheets();
  else if(tab==="order")renderOrderTab();
  else if(tab==="waste")renderWaste();
  else if(tab==="daily")renderDaily();
  else if(tab==="staff")renderStaff();
  else if(tab==="roster"){window.OM_ROSTER&&window.OM_ROSTER.render()}
  else if(tab==="invoices"){renderInvoices();renderThumbs();$("#capPanel").hidden=!canWrite}
  else if(tab==="team"){window.OM_ADMIN&&window.OM_ADMIN.render&&window.OM_ADMIN.render()}
  else renderItems();
}

/* ---------- boot ---------- */
renderAll();

// Called by backend.js once the person is signed in and approved.
window.OM_START=function(backend){
  db=backend.db;user=backend.user;downloads=backend.downloads;sample=null;myId=backend.user.id;
  canWrite=backend.user.canWrite!==false;
  const allowed=new Set([...backend.user.tabs,...(backend.user.isOwner?["team"]:[])]);
  const has=t=>allowed.has(t);

  // Only show the tabs this person may use, and open the first one.
  document.querySelectorAll(".tabs button").forEach(b=>{b.hidden=!allowed.has(b.dataset.tab)});
  const first=[...document.querySelectorAll(".tabs button")].find(b=>!b.hidden);
  if(first)first.click();
  // Counting-only people don't see the stocktake management buttons they can't use.
  if(!has("count")&&!has("variance")){$("#newSessionBtn").hidden=true;$("#delSessionBtn").hidden=true}

  $("#invRead").hidden=true;
  setInvStatus("Invoices are saved as photos. Enter new prices on the Items tab (or ask the owner to import them).","");
  if(!canWrite)note("You have view-only access. Ask the owner if you need to make changes.","warn");
  renderThumbs();

  db.collection("items").limit(1000).onSnapshot(snap=>{
    items=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(tab==="count"){renderChips();renderCountList()}else renderAll();
  },e=>note("Items stopped updating ("+e.code+"). Reload the page.","err"));
  db.collection("lists").limit(100).onSnapshot(snap=>{
    lists=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>((a.order??99)-(b.order??99))||(a.name||"").localeCompare(b.name||""));
    if(!$("#newSessionPanel").hidden)renderNewLists();
    renderFormLists();
    renderAll();
  },e=>note("Stock lists stopped updating ("+e.code+"). Reload the page.","err"));
  db.doc("settings/main").onSnapshot(snap=>{
    if(snap.exists)settings={...settings,...snap.data()};
    if(tab==="count"){renderChips();renderCountList()}else if(tab==="variance")renderVariance();else if(tab==="staff")renderStaff();
  },()=>{});
  if(has("staff"))db.doc("settings/pay").onSnapshot(snap=>{
    if(snap.exists)settings={...settings,...snap.data()};
    if(tab==="staff")renderStaff();
  },()=>{});
  db.collection("waste").orderBy("at","desc").limit(1000).onSnapshot(snap=>{
    waste=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(tab==="waste")renderWaste();else if(tab==="variance")renderVariance();
  },e=>note("Waste log stopped updating ("+e.code+"). Reload the page.","err"));
  if(has("daily")||has("staff")||has("waste"))db.collection("daily").limit(400).onSnapshot(snap=>{
    daily=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(tab==="daily")renderDaily();else if(tab==="waste")renderWaste();else if(tab==="staff")renderStaff();
  },e=>note("Daily reports stopped updating ("+e.code+"). Reload the page.","err"));
  if(has("staff"))db.collection("staff").limit(300).onSnapshot(snap=>{
    staff=snap.docs.map(d=>({...d.data(),id:d.id}));
    if(tab==="staff")renderStaff();
  },e=>note("Staff list stopped updating ("+e.code+"). Reload the page.","err"));
  if(has("roster")&&window.OM_ROSTER)window.OM_ROSTER.init(backend,{toast,writeErr,offerXlsx});
  if(has("staff"))db.collection("shifts").orderBy("date","desc").limit(1000).onSnapshot(snap=>{
    shifts=snap.docs.map(d=>({...d.data(),id:d.id}));
    if(tab==="staff")renderStaff();
  },e=>note("Staff hours stopped updating ("+e.code+"). Reload the page.","err"));
  if(has("order"))db.collection("orderSheets").limit(50).onSnapshot(snap=>{
    sheets=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>((a.order??99)-(b.order??99))||(a.name||"").localeCompare(b.name||""));
    if(tab==="order"&&ordMode==="sheets")renderOS();
  },e=>note("Order sheets stopped updating ("+e.code+"). Reload the page.","err"));
  if(has("order"))db.collection("orderLog").orderBy("at","desc").limit(200).onSnapshot(snap=>{
    orderLog=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(tab==="order"&&ordMode==="sheets")renderOS();
  },e=>note("Past orders stopped updating ("+e.code+"). Reload the page.","err"));
  if(has("invoices"))db.collection("invoices").orderBy("capturedAt","desc").limit(200).onSnapshot(snap=>{
    invoices=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(tab==="invoices")renderInvoices();
  },e=>note("Invoices stopped updating ("+e.code+"). Reload the page.","err"));
  db.collection("sessions").orderBy("startedAt","desc").limit(50).onSnapshot(snap=>{
    const prevSid=sid, wasOpen=isOpen();
    sessions=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(!session()){const open=sessions.find(s=>s.status!=="closed");sid=(open||sessions[0]||{}).id||null;}
    renderSessions();
    if(tab==="count"){
      if(prevSid!==sid||wasOpen!==isOpen()){renderChips();renderCountList()}
      else{snap.docChanges().length&&items.forEach(i=>patchRow(i.id));renderChips();renderProgress()}
    }else renderAll();
  },e=>note("Stocktakes stopped updating ("+e.code+"). Reload the page.","err"));
};
})();


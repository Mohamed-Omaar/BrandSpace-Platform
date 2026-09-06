document.body.style.visibility = "hidden";
(() => { const s = document.createElement("script"); s.src = "../access-gate.js"; s.onerror = () => { document.body.style.visibility = "visible"; }; document.head.appendChild(s); })();

const postData={launch:["New collection launch","Instagram","12 Mar · 09:00","NEW<br>CHAPTER","gradient-a"],story:["Founder story","LinkedIn","13 Mar · 13:30","BUILT<br>WITH CARE","gradient-b"],tips:["Three useful tips","Facebook","14 Mar · 18:00","THREE<br>IDEAS","gradient-c"],reel:["Studio Reel","TikTok","15 Mar · 11:00","BEHIND<br>THE SCENES","gradient-b"],offer:["Weekend offer","Instagram","19 Mar · 18:00","WEEKEND<br>OFFER","gradient-d"],recap:["Monthly recap","LinkedIn","25 Mar · 10:00","MARCH<br>RECAP","gradient-a"],team:["Meet the team","Instagram","27 Mar · 15:00","MEET<br>THE TEAM","gradient-c"],guide:["Product guide","Facebook","29 Mar · 12:00","QUICK<br>GUIDE","gradient-d"],acme:["Acme Studio","Workspace","Active","ACME","gradient-a"],north:["North Star","Workspace","Trial","NORTH","gradient-b"],luma:["Luma Retail","Workspace","Active","LUMA","gradient-d"]};
function openPost(id){const p=postData[id]||postData.launch;openDrawer(`<div class="drawer-head"><span class="section-kicker">Post details</span><button class="drawer-close" data-close>×</button></div><div class="drawer-art ${p[4]}"><span>${p[3]}</span></div><span class="status">Scheduled</span><h2>${p[0]}</h2><p style="color:var(--muted);line-height:1.6">A polished preview of the real detail page. Review, edit, reschedule or open the item in its library context.</p><div class="drawer-meta"><div><small>Channel</small><b>${p[1]}</b></div><div><small>Publish date</small><b>${p[2]}</b></div><div><small>Campaign</small><b>Spring collection</b></div><div><small>Approval</small><b>Ready</b></div></div><div class="drawer-actions"><button class="ghost-button" data-drawer-go="posts">View in library</button><button class="dark-button" data-drawer-go="composer">Edit post</button></div>`)}
function openCopilot(){const context=(meta[state.view]||["Workspace","Current page"])[1];openDrawer(`<div class="drawer-head"><span class="section-kicker">AI marketing team</span><button class="drawer-close" data-close>×</button></div><div style="padding:36px 0 22px"><span class="label-pill">✦ Context: ${context}</span><h2 style="font-size:38px;line-height:.95;letter-spacing:-.055em">What would you like to move forward?</h2><p style="color:var(--muted);line-height:1.6">I understand the page you are on. I can explain it, improve its content, plan next steps or prepare a reviewable action—nothing is applied without your confirmation.</p></div><div class="quick-grid"><button class="quick-card demo-action"><span>□</span><b>Plan next week</b><small>Draft a reviewable calendar</small></button><button class="quick-card demo-action"><span>✎</span><b>Improve this page</b><small>Preview every change</small></button><button class="quick-card demo-action"><span>↗</span><b>Use analytics</b><small>Find what to repeat</small></button><button class="quick-card demo-action"><span>✦</span><b>Create campaign</b><small>Ideas to deliverables</small></button></div><label class="copilot-input" style="margin-top:25px"><input placeholder="Ask Copilot about ${context}…"><button>↑</button></label>`)}
function openDrawer(html){$("#drawerContent").innerHTML=html;$("#sideDrawer").classList.add("open");$("#drawerBackdrop").classList.add("open");$("#sideDrawer").setAttribute("aria-hidden","false");$$('[data-close]').forEach(b=>b.addEventListener("click",closeDrawer));$$('[data-drawer-go]').forEach(b=>b.addEventListener("click",()=>showView(b.dataset.drawerGo)));$$('.demo-action').forEach(b=>b.addEventListener("click",notify))}
function closeDrawer(){$("#sideDrawer").classList.remove("open");$("#drawerBackdrop").classList.remove("open");$("#sideDrawer").setAttribute("aria-hidden","true")}
function notify(){const t=$("#toast");t.textContent="Interactive preview — production logic arrives in its approved phase.";t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200)}
function bindPage(){$$('[data-view-target]').forEach(b=>b.addEventListener("click",()=>showView(b.dataset.viewTarget)));$$('[data-post-id]').forEach(b=>b.addEventListener("click",()=>openPost(b.dataset.postId)));$$('[data-drawer="copilot"]').forEach(b=>b.addEventListener("click",openCopilot));$$('.demo-action').forEach(b=>b.addEventListener("click",notify));const cap=$("#caption");if(cap)cap.addEventListener("input",()=>{$("#previewCaption").textContent=cap.value});$$('.toggle').forEach(b=>b.addEventListener("click",()=>b.classList.toggle("on")));const map=$("[data-special=map]");if(map)map.addEventListener("click",()=>showView("map"))}
function closeMobile(){sidebar.classList.remove("mobile-open");$("#mobileBackdrop").classList.remove("open");$("#mobileMenu").setAttribute("aria-expanded","false")}
$("#collapseSidebar").addEventListener("click",e=>{state.collapsed=!state.collapsed;appShell.classList.toggle("sidebar-collapsed",state.collapsed);e.currentTarget.setAttribute("aria-expanded",String(!state.collapsed))});$("#experienceButton").addEventListener("click",e=>{const m=$("#experienceMenu");m.classList.toggle("open");e.currentTarget.setAttribute("aria-expanded",String(m.classList.contains("open")))});$$('[data-mode]').forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.mode)));$("#mobileMenu").addEventListener("click",()=>{sidebar.classList.add("mobile-open");$("#mobileBackdrop").classList.add("open");$("#mobileMenu").setAttribute("aria-expanded","true")});$("#mobileBackdrop").addEventListener("click",closeMobile);$("#drawerBackdrop").addEventListener("click",closeDrawer);$("#copilotDock").addEventListener("click",openCopilot);$("#globalCreate").addEventListener("click",()=>state.mode==="customer"?showView("composer"):notify());$("#languageButton").addEventListener("click",()=>{state.lang=state.lang==="en"?"ar":"en";document.documentElement.dir=state.lang==="ar"?"rtl":"ltr";document.documentElement.lang=state.lang;$("#languageButton").textContent=state.lang==="ar"?"EN":"AR";notify()});
function commandItems(){return Object.entries(experiences).flatMap(([mode,e])=>e.groups.flatMap(g=>g[1].map(x=>({mode,id:x[0],label:x[2]}))))}function openSearch(){$("#commandBackdrop").classList.add("open");$("#commandInput").value="";renderResults("");setTimeout(()=>$("#commandInput").focus(),20)}function closeSearch(){$("#commandBackdrop").classList.remove("open")}function renderResults(q){const items=commandItems().filter(x=>x.label.toLowerCase().includes(q.toLowerCase())).slice(0,8);$("#commandResults").innerHTML=items.map(x=>`<button class="command-result" data-command="${x.mode}/${x.id}"><b>${x.label}</b><small>${experiences[x.mode].name}</small></button>`).join("");$$('[data-command]').forEach(b=>b.addEventListener("click",()=>{const[m,id]=b.dataset.command.split("/");state.mode=m;$("#experienceName").textContent=experiences[m].name;$("#experienceIcon").textContent=experiences[m].icon;$("#profileRole").textContent=experiences[m].role;showView(id);closeSearch()}))}
$("#openSearch").addEventListener("click",openSearch);$("#commandInput").addEventListener("input",e=>renderResults(e.target.value));$("#commandBackdrop").addEventListener("click",e=>{if(e.target===$("#commandBackdrop"))closeSearch()});document.addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();openSearch()}if(e.key==="Escape"){closeDrawer();closeSearch();closeMobile()}});const initial=location.hash.replace("#","").split("/");if(experiences[initial[0]]){state.mode=initial[0];state.view=meta[initial[1]]?initial[1]:experiences[state.mode].start;$("#experienceName").textContent=experiences[state.mode].name;$("#experienceIcon").textContent=experiences[state.mode].icon;$("#profileRole").textContent=experiences[state.mode].role}render();

/* Integrated Brand Brain preview — stays inside the original product shell. */
(()=>{
  const BRAIN_URL="../brand-brain-preview/?embedded=1";
  meta["brand-brain"]=["Brand intelligence","Brand Brain"];

  function ensureBrainStyles(){
    if(document.getElementById("brandBrainIntegratedStyle"))return;
    const style=document.createElement("style");
    style.id="brandBrainIntegratedStyle";
    style.textContent=`
      .brand-brain-route{display:block;width:100%;min-height:980px;border:0;border-radius:28px;background:#f3f3f5;box-shadow:0 18px 55px rgba(30,22,54,.06)}
      @media(max-width:760px){.brand-brain-route{min-height:900px;border-radius:20px}}
    `;
    document.head.appendChild(style);
  }

  function resizeBrainFrame(frame,bdoc){
    const resize=()=>{
      const h=Math.max(900,bdoc.documentElement.scrollHeight,bdoc.body?.scrollHeight||0);
      frame.style.height=`${h}px`;
    };
    resize();
    if("ResizeObserver" in window){
      const ro=new ResizeObserver(resize);
      if(bdoc.body)ro.observe(bdoc.body);
    }
    setTimeout(resize,180);
    setTimeout(resize,600);
  }

  function prepareEmbeddedBrain(frame){
    const apply=()=>{
      let bdoc;
      try{bdoc=frame.contentDocument}catch(e){return}
      if(!bdoc||!bdoc.head)return;
      if(!bdoc.getElementById("brandBrainEmbeddedMode")){
        const style=bdoc.createElement("style");
        style.id="brandBrainEmbeddedMode";
        style.textContent=`
          html,body{background:transparent!important;overflow:visible!important}
          .app{display:block!important;grid-template-columns:1fr!important;padding:0!important;min-height:0!important}
          .side,.topbar{display:none!important}
          .main{display:block!important;width:100%!important;min-width:0!important}
          .content{max-width:none!important;margin:0!important;padding:4px 2px 100px!important}
          .copilot{position:absolute!important;right:22px!important;bottom:22px!important}
          @media(max-width:650px){.content{padding:0 0 78px!important}.page-head{margin-top:14px!important}.hero{border-radius:24px!important}.copilot{display:none!important}}
        `;
        bdoc.head.appendChild(style);
      }
      resizeBrainFrame(frame,bdoc);
    };
    frame.addEventListener("load",apply,{once:true});
    setTimeout(apply,80);
  }

  function activateBrainButton(btn){
    document.querySelectorAll(".nav-item").forEach(item=>{
      item.classList.remove("active");
      item.removeAttribute("aria-current");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-current","page");
  }

  function openBrandBrain(btn){
    ensureBrainStyles();
    state.view="brand-brain";
    location.hash="customer/brand-brain";
    activateBrainButton(btn);

    const eyebrow=document.getElementById("pageEyebrow");
    const title=document.getElementById("pageTitle");
    if(eyebrow)eyebrow.textContent="Brand intelligence";
    if(title)title.textContent="Brand Brain";

    const create=document.getElementById("globalCreate");
    if(create)create.innerHTML='+ <span>Add knowledge</span>';

    const view=document.getElementById("view");
    if(!view)return;
    view.innerHTML="";
    const frame=document.createElement("iframe");
    frame.id="brandBrainRouteFrame";
    frame.className="brand-brain-route";
    frame.src=BRAIN_URL;
    frame.title="Brand Brain";
    frame.setAttribute("loading","eager");
    view.appendChild(frame);
    prepareEmbeddedBrain(frame);
    closeMobile();
  }

  function addBrandBrainNav(){
    if(state.mode!=="customer")return;
    if(document.getElementById("brandBrainIntegratedNav"))return;
    const brandKit=document.querySelector('[data-view-target="brand"]');
    if(!brandKit)return;

    const btn=brandKit.cloneNode(true);
    btn.id="brandBrainIntegratedNav";
    btn.removeAttribute("data-view-target");
    btn.removeAttribute("aria-current");
    btn.setAttribute("data-label","Brand Brain");
    btn.classList.remove("active");
    const icon=btn.querySelector(".nav-icon");
    if(icon)icon.textContent="✦";
    const spans=btn.querySelectorAll("span");
    if(spans[1])spans[1].textContent="Brand Brain";
    const badge=btn.querySelector(".nav-badge");
    if(badge)badge.textContent="preview";
    btn.addEventListener("click",e=>{
      e.preventDefault();
      e.stopPropagation();
      openBrandBrain(btn);
    });
    brandKit.parentNode.insertBefore(btn,brandKit);
  }

  const nav=document.getElementById("navList");
  if(nav){
    new MutationObserver(()=>setTimeout(addBrandBrainNav,0)).observe(nav,{childList:true,subtree:true});
  }

  const create=document.getElementById("globalCreate");
  if(create){
    create.addEventListener("click",e=>{
      if(state.view!=="brand-brain")return;
      e.preventDefault();
      e.stopImmediatePropagation();
      notify();
    },true);
  }

  document.addEventListener("click",e=>{
    const target=e.target.closest?.("[data-view-target],[data-mode]");
    if(!target)return;
    if(state.view==="brand-brain"&&target.dataset.viewTarget){
      const create=document.getElementById("globalCreate");
      if(create)create.innerHTML='+ <span>Create</span>';
    }
    setTimeout(addBrandBrainNav,0);
  },true);

  addBrandBrainNav();
  if(location.hash==="#customer/brand-brain"){
    setTimeout(()=>{
      addBrandBrainNav();
      const btn=document.getElementById("brandBrainIntegratedNav");
      if(btn)openBrandBrain(btn);
    },60);
  }
})();
(() => {
  const brainAreas={
    identity:{title:'Identity',description:'The core facts that define who the brand is, what it stands for and how it should be positioned.'},
    audience:{title:'Audience',description:'Segments, needs, motivations, objections and behaviors that shape every message.'},
    offers:{title:'Products & Offers',description:'Products, services, benefits, differentiators and the promotional context AI may safely use.'},
    voice:{title:'Tone of Voice',description:'Approved Arabic and English tone, language rules, examples and phrases to avoid.'},
    learnings:{title:'Learnings',description:'Evidence-backed patterns approved from content and campaign performance.'},
    strategy:{title:'Strategy',description:'Goals, campaign decisions, priorities and strategic memory for the current cycle.'}
  };
  const chatReplies={
    all:{text:'Your Brand Brain currently has a strong foundation across identity, audience, offers, voice and strategy. Ask a specific question and I will answer only from approved knowledge.',sources:['Brand Guidelines 2026.pdf','Company Profile.pdf']},
    identity:{text:'Your positioning is built around a focused, AI-assisted marketing team that keeps every output aligned with approved brand knowledge.',sources:['Brand Guidelines 2026.pdf · Identity']},
    audience:{text:'The current audience knowledge contains four approved segments, including their motivations, pain points and purchase triggers.',sources:['Audience research · 4 segments']},
    offers:{text:'Six offers are active. I can explain their approved benefits and differentiators without inventing claims or pricing.',sources:['Services & Offers.docx']},
    voice:{text:'The approved voice is clear, confident and helpful in Arabic and English. I can draft content while following the active language rules.',sources:['Brand Guidelines 2026.pdf · Voice v4']},
    learnings:{text:'Eight performance learnings are approved. Educational content is currently outperforming promotional content.',sources:['Approved performance learnings']},
    strategy:{text:'The current strategy memory covers the Q4 priorities, campaign decisions and approved content direction.',sources:['Q4 strategy memory']}
  };
  let cleanupBrain=null;

  function markup(){
    return `<div class="brand-brain-page" id="brandBrainPage">
      <span class="bb-preview-tag">Preview / demo data</span>
      <div class="bb-page-head">
        <div><h2>Your brand,<br><strong>remembered.</strong></h2></div>
        <p>Brand Brain is the living knowledge layer behind every strategy, caption and recommendation. Review what BrandSpace knows, fix what is missing and approve what it learns.</p>
      </div>

      <section class="bb-hero">
        <div class="bb-orb-stage" id="bbOrbStage" aria-label="Interactive Brand Brain knowledge map">
          <canvas class="bb-orb-canvas" id="bbOrbCanvas"></canvas>
          <button class="bb-orb-center" id="bbOrbCenter" aria-label="Open Brand Brain chat"><span class="bb-orb-label" aria-hidden="true">Brand<br>Brain</span><span class="bb-sr-only">Open Brand Brain chat</span></button>
          <span class="bb-orb-hint">Move to react · Drop a file to map knowledge</span>
          <button class="bb-orbit-node" data-area="identity"><b>Identity</b><small>12 facts · complete</small></button>
          <button class="bb-orbit-node" data-area="audience"><b>Audience</b><small>4 segments · complete</small></button>
          <button class="bb-orbit-node" data-area="offers"><b>Offers</b><small>6 active offers</small></button>
          <button class="bb-orbit-node" data-area="voice"><b>Voice</b><small>AR + EN · active</small></button>
          <button class="bb-orbit-node" data-area="learnings"><b>Learnings</b><small>8 approved</small></button>
          <button class="bb-orbit-node" data-area="strategy"><b>Strategy</b><small>Q4 memory</small></button>
          <input class="bb-file-input" id="bbGlobalBrainFile" type="file" accept=".pdf,.doc,.docx,.txt,.csv,.ppt,.pptx,image/*">
        </div>

        <div class="bb-hero-stats" id="bbBrainPanel">
          <div class="bb-stats-view" id="bbStatsView">
            <div class="bb-completion">
              <small>Brand Brain completion</small>
              <div class="bb-completion-big"><b id="bbCompletionValue">82%</b><span>Strong foundation</span></div>
              <div class="bb-progress"><i id="bbCompletionBar"></i></div>
              <div class="bb-ingest-status" id="bbIngestStatus"><b id="bbIngestTitle">Reading source…</b><span id="bbIngestCopy">Mapping facts to the right knowledge areas.</span></div>
            </div>
            <div class="bb-health">
              <div class="bb-mini"><small>Knowledge items</small><b id="bbKnowledgeCount">128</b><span>+14 this month</span></div>
              <div class="bb-mini"><small>Source documents</small><b id="bbSourceCount">4</b><span>All processed</span></div>
            </div>
            <div class="bb-attention"><b>3 areas need attention</b><p>Competitor context is incomplete, one offer has not been reviewed recently, and your Arabic glossary needs 4 confirmations.</p></div>
          </div>

          <section class="bb-brain-chat" id="bbBrainChat" aria-hidden="true" aria-label="Chat with your Brand Brain">
            <header class="bb-brain-chat-head">
              <div class="bb-brain-chat-brand"><i>✦</i><span><small>BrandSpace intelligence</small><b>Talk to your Brand Brain</b></span></div>
              <button class="bb-chat-close" id="bbCloseBrainChat" type="button" aria-label="Back to Brand Brain overview">×</button>
            </header>
            <div class="bb-chat-context-row"><span class="bb-chat-context" id="bbChatContext">All Brand Brain knowledge</span><button class="bb-chat-area-details" id="bbChatAreaDetails" type="button" hidden>View area details</button></div>
            <div class="bb-chat-messages" id="bbChatMessages" aria-live="polite"></div>
            <div class="bb-chat-suggestions">
              <button type="button" data-chat-prompt="What does our brand stand for?">Brand positioning</button>
              <button type="button" data-chat-prompt="What important knowledge is missing?">Find knowledge gaps</button>
              <button type="button" data-chat-prompt="Write a social post in our approved tone of voice.">Create in our voice</button>
            </div>
            <form class="bb-chat-compose" id="bbBrainChatForm">
              <button class="bb-chat-attach" id="bbChatUpload" type="button" aria-label="Attach a source">+</button>
              <input class="bb-file-input" id="bbChatBrainFile" type="file" accept=".pdf,.doc,.docx,.txt,.csv,.ppt,.pptx,image/*">
              <input class="bb-chat-input" id="bbBrainChatInput" type="text" autocomplete="off" placeholder="Ask about your brand…" aria-label="Message your Brand Brain">
              <button class="bb-chat-send" type="submit" aria-label="Send message">↑</button>
            </form>
            <small class="bb-chat-disclaimer">Prototype answers use approved demo sources. Suggested knowledge is never saved without review.</small>
          </section>
        </div>
      </section>

      <div class="bb-section-title"><div><h3>What BrandSpace knows</h3><p>Structured, reviewable and versioned knowledge.</p></div><p>Click any card to preview the detail view.</p></div>
      <section class="bb-grid">
        <button class="bb-card" data-bb-title="Identity" data-bb-desc="The core facts that define who the brand is and how it should be positioned."><span class="bb-icon">◇</span><h4>Identity</h4><p>Positioning, mission, value proposition, brand description and business context.</p><footer><span class="bb-status">Complete</span><span class="bb-count">12 items</span></footer></button>
        <button class="bb-card" data-bb-title="Audience" data-bb-desc="Audience segments and the needs, motivations and objections that shape communication."><span class="bb-icon">◎</span><h4>Audience</h4><p>Primary segments, motivations, pain points, behaviors and purchase triggers.</p><footer><span class="bb-status">Complete</span><span class="bb-count">4 segments</span></footer></button>
        <button class="bb-card" data-bb-title="Tone of Voice" data-bb-desc="How the brand sounds in Arabic and English, including examples and language rules."><span class="bb-icon">✎</span><h4>Tone of Voice</h4><p>Personality, language rules, Arabic and English tone, examples and phrases to avoid.</p><footer><span class="bb-status">Active · v4</span><span class="bb-count">AR + EN</span></footer></button>
        <button class="bb-card" data-bb-title="Products & Offers" data-bb-desc="Products and services BrandSpace can reference when planning strategy or generating content."><span class="bb-icon">▦</span><h4>Products & Offers</h4><p>Services, benefits, differentiators, proof points and approved promotional context.</p><footer><span class="bb-status">Complete</span><span class="bb-count">6 offers</span></footer></button>
        <button class="bb-card" data-bb-title="Proof Points" data-bb-desc="Approved evidence and reasons to believe that AI may safely use in communication."><span class="bb-icon">✓</span><h4>Proof Points</h4><p>Credentials, achievements, validated claims, expertise and reasons to believe.</p><footer><span class="bb-status">Complete</span><span class="bb-count">9 facts</span></footer></button>
        <button class="bb-card" data-bb-title="Do / Don't Rules" data-bb-desc="Explicit constraints that keep generated content aligned with the brand."><span class="bb-icon">↔</span><h4>Do / Don’t</h4><p>Mandatory rules, prohibited phrases, claim restrictions and brand-safe guidance.</p><footer><span class="bb-status">Complete</span><span class="bb-count">17 rules</span></footer></button>
        <button class="bb-card" data-bb-title="Competitors" data-bb-desc="Competitive context that helps strategy and positioning stay differentiated."><span class="bb-icon">⌁</span><h4>Competitors</h4><p>Competitor profiles, positioning differences and areas BrandSpace should not imitate.</p><footer><span class="bb-status warn">Needs review</span><span class="bb-count">3 profiles</span></footer></button>
        <button class="bb-card" data-bb-title="Glossary" data-bb-desc="Approved naming, spelling and translation rules that protect consistency across languages."><span class="bb-icon">Aa</span><h4>Glossary</h4><p>Product names, approved terminology, Arabic/English translations and capitalization rules.</p><footer><span class="bb-status warn">4 pending</span><span class="bb-count">28 terms</span></footer></button>
      </section>

      <section class="bb-bottom">
        <div class="bb-intel">
          <div class="bb-intel-head"><h4>Brand Intelligence</h4><span class="bb-badge">AI suggestion</span></div>
          <div class="bb-learning"><small>Recent learning</small><b>Educational content is outperforming promotional content.</b><p>Across the latest approved performance signals, educational posts are generating stronger engagement. BrandSpace suggests increasing their share in the next strategy cycle.</p><div class="bb-learning-actions"><button class="accept demo-action">Review suggestion</button><button class="later demo-action">Dismiss for now</button></div></div>
          <div class="bb-learning"><small>Knowledge health</small><b>One offer may be outdated.</b><p>The “Summer Package” has not been confirmed recently. BrandSpace will not silently update it — an owner or approved editor must review the source.</p></div>
        </div>
        <div class="bb-source">
          <div class="bb-source-head"><h4>Knowledge sources</h4><button class="soft-button compact" id="bbUploadSource">+ Upload</button></div>
          <div class="bb-source-list">
            <div class="bb-doc"><i>PDF</i><span><b>Brand Guidelines 2026.pdf</b><small>24 pages · processed</small></span><span>Ready</span></div>
            <div class="bb-doc"><i>DOC</i><span><b>Services & Offers.docx</b><small>18 sections · processed</small></span><span>Ready</span></div>
            <div class="bb-doc"><i>PDF</i><span><b>Company Profile.pdf</b><small>31 pages · processed</small></span><span>Ready</span></div>
            <div class="bb-doc"><i>FAQ</i><span><b>Customer FAQ</b><small>42 entries · structured</small></span><span>Ready</span></div>
          </div>
        </div>
      </section>
    </div>`;
  }

  function markNavActive(){
    document.querySelectorAll('.nav-item').forEach(item=>{item.classList.remove('active');item.removeAttribute('aria-current')});
    const btn=document.getElementById('brandBrainIntegratedNav');
    if(btn){btn.classList.add('active');btn.setAttribute('aria-current','page')}
  }

  function openDetail(title,description){
    if(typeof openDrawer==='function'){
      openDrawer(`<div class="drawer-head"><span class="section-kicker">Brand Brain knowledge</span><button class="drawer-close" data-close>×</button></div><div style="padding:34px 0 14px"><span class="label-pill">Approved knowledge</span><h2 style="font-size:36px;line-height:1;letter-spacing:-.05em;margin:18px 0 10px">${title}</h2><p style="color:var(--muted);line-height:1.65">${description}</p></div><div class="drawer-meta"><div><small>Status</small><b>Active · Version 4</b></div><div><small>Last reviewed</small><b>Recently</b></div><div><small>Source</small><b>Approved workspace knowledge</b></div><div><small>Used by AI</small><b>Yes · traceable</b></div></div>`);
    }
  }

  function initBrain(){
    if(cleanupBrain)cleanupBrain();
    const stage=document.getElementById('bbOrbStage'),canvas=document.getElementById('bbOrbCanvas');
    if(!stage||!canvas)return;
    const ctx=canvas.getContext('2d'),nodes=[...document.querySelectorAll('.bb-orbit-node')],panel=document.getElementById('bbBrainPanel'),chat=document.getElementById('bbBrainChat'),messages=document.getElementById('bbChatMessages'),context=document.getElementById('bbChatContext'),areaDetails=document.getElementById('bbChatAreaDetails'),form=document.getElementById('bbBrainChatForm'),input=document.getElementById('bbBrainChatInput'),globalFile=document.getElementById('bbGlobalBrainFile'),chatFile=document.getElementById('bbChatBrainFile');
    let active=true,chatArea=null,pointer={x:-999,y:-999,inside:false},tilt={x:0,y:0,tx:0,ty:0},particles=[],raf=0;const orbScale=1.3;

    function buildSphere(count,radius,isInner){const golden=(1+Math.sqrt(5))/2;for(let i=0;i<count;i++){const ratio=i/(count-1),inclination=Math.acos(1-2*ratio),azimuth=2*Math.PI*golden*i;let color='#7935fe';if(i%3===0)color='#ffdd15';if(i%7===0)color='#111114';particles.push({x:radius*Math.sin(inclination)*Math.cos(azimuth),y:radius*Math.sin(inclination)*Math.sin(azimuth),z:radius*Math.cos(inclination),color,isInner,seed:Math.random()*Math.PI*2,energy:0})}}
    function buildParticles(){const r=stage.getBoundingClientRect(),unit=Math.min(r.width,r.height);particles=[];buildSphere(r.width<650?130:180,unit*.32*orbScale,false);buildSphere(r.width<650?55:78,unit*.15*orbScale,true)}
    function size(){if(!active||!stage.isConnected)return;const r=stage.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(r.width*d);canvas.height=Math.round(r.height*d);canvas.style.width=r.width+'px';canvas.style.height=r.height+'px';ctx.setTransform(d,0,0,d,0,0);buildParticles()}
    function glow(x,y,radius,color,intensity){if(intensity<.06)return;const rgb=color==='#ffdd15'?'255,221,21':'121,53,254',g=ctx.createRadialGradient(x,y,0,x,y,radius*4);g.addColorStop(0,'rgba('+rgb+','+(intensity*.42)+')');g.addColorStop(1,'rgba('+rgb+',0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,radius*4,0,Math.PI*2);ctx.fill()}
    function positionNodes(t){const rect=stage.getBoundingClientRect(),radius=Math.min(rect.width,rect.height)*.41*orbScale,rx=radius*.72,ry=radius*.72,orbit=t*.000012,angles=[3.55,5.42,.3,2.83,1.62,4.7];nodes.forEach((node,i)=>{const a=angles[i]+orbit,x=rect.width/2+Math.cos(a)*rx,y=rect.height/2+Math.sin(a)*ry,z=(Math.sin(a)+1)/2,scale=.82+z*.22;node.style.left=x+'px';node.style.top=y+'px';node.style.opacity=String(.7+z*.3);node.style.transform='translate(-50%,-50%) scale('+scale+')';node.style.zIndex=String(5+Math.round(z*3))})}
    function draw(t){if(!active||!stage.isConnected)return;const rect=stage.getBoundingClientRect(),cx=rect.width/2,cy=rect.height/2,unit=Math.min(rect.width,rect.height),outerRadius=unit*.32*orbScale,holeRadius=outerRadius*.27;ctx.clearRect(0,0,rect.width,rect.height);tilt.x+=(tilt.tx-tilt.x)*.025;tilt.y+=(tilt.ty-tilt.y)*.025;const ay=t*.000055+tilt.x,ax=-.08+tilt.y,cosX=Math.cos(ax),sinX=Math.sin(ax),cosY=Math.cos(ay),sinY=Math.sin(ay),projected=[];for(const p of particles){if(Math.random()<.00035)p.energy=1;p.energy*=.965;const rx=p.x*cosY-p.z*sinY,rz=p.x*sinY+p.z*cosY,ry=p.y*cosX-rz*sinX,finalZ=p.y*sinX+rz*cosX,scale=700/(700+finalZ);let px=cx+rx*scale,py=cy+ry*scale;const dx=px-pointer.x,dy=py-pointer.y,dist=Math.hypot(dx,dy);if(!p.isInner&&pointer.inside&&dist<105*orbScale){const force=Math.pow((105*orbScale-dist)/(105*orbScale),2)*28*orbScale;px+=dx/(dist||1)*force;py+=dy/(dist||1)*force}projected.push({x:px,y:py,z:finalZ,scale,color:p.color,isInner:p.isInner,energy:p.energy,seed:p.seed})}projected.sort((a,b)=>b.z-a.z);ctx.lineCap='round';ctx.lineJoin='round';for(let i=0;i<projected.length;i++){const p1=projected[i],maxDistance=(p1.isInner?unit*.145:unit*.11)*orbScale*p1.scale;for(let j=i+1;j<Math.min(i+24,projected.length);j++){const p2=projected[j];if(p1.isInner!==p2.isInner)continue;const distance=Math.hypot(p1.x-p2.x,p1.y-p2.y);if(distance>=maxDistance)continue;const energy=Math.max(p1.energy,p2.energy),alpha=Math.min(.52,(1-distance/maxDistance)*p1.scale*(p1.isInner?.38:.25)+energy*.2);ctx.beginPath();ctx.moveTo(p1.x,p1.y);if(p1.isInner)ctx.lineTo(p2.x,p2.y);else{const mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2,bend=Math.sin(p1.seed)*4;ctx.quadraticCurveTo(mx+bend,my-bend,p2.x,p2.y)}ctx.strokeStyle=p1.isInner?'rgba(255,221,21,'+alpha+')':'rgba(121,53,254,'+alpha+')';ctx.lineWidth=Math.max(.3,(p1.isInner?1.25:.8)*p1.scale);ctx.stroke()}}for(const p of projected){const radius=Math.max(.65,(p.isInner?2.7:2)*p.scale),alpha=Math.min(1,Math.max(.24,p.scale*.86+p.energy*.35));if(p.energy>.1)glow(p.x,p.y,radius,p.color,p.energy*p.scale);ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);ctx.fillStyle=p.energy>.58?'rgba(255,255,255,'+alpha+')':p.color==='#7935fe'?'rgba(121,53,254,'+alpha+')':p.color==='#ffdd15'?'rgba(255,221,21,'+alpha+')':'rgba(17,17,20,'+alpha+')';ctx.fill()}ctx.save();ctx.globalCompositeOperation='destination-out';ctx.beginPath();ctx.arc(cx,cy,holeRadius,0,Math.PI*2);ctx.fill();ctx.restore();positionNodes(t);raf=requestAnimationFrame(draw)}
    function localPointer(e){const r=stage.getBoundingClientRect();pointer.x=e.clientX-r.left;pointer.y=e.clientY-r.top;pointer.inside=true;tilt.tx=(pointer.x/r.width-.5)*.24;tilt.ty=(pointer.y/r.height-.5)*.16}
    function addMessage(text,role,sources){const m=document.createElement('div');m.className='bb-chat-message '+role;m.textContent=text;if(sources&&sources.length){const list=document.createElement('div');list.className='bb-chat-sources';sources.forEach(source=>{const chip=document.createElement('span');chip.className='bb-chat-source';chip.textContent='↗ '+source;list.appendChild(chip)});m.appendChild(list)}messages.appendChild(m);messages.scrollTop=messages.scrollHeight;return m}
    function openChat(key){chatArea=key||null;context.textContent=chatArea?brainAreas[chatArea].title:'All Brand Brain knowledge';areaDetails.hidden=!chatArea;messages.innerHTML='';addMessage(chatArea?'You are now talking to your Brand Brain about '+brainAreas[chatArea].title+'. Ask me anything about this area or attach a source.':'Ask me anything about your brand. My answers stay grounded in approved knowledge and show the sources used.','brain',[]);panel.classList.add('chat-open');chat.setAttribute('aria-hidden','false');setTimeout(()=>input.focus(),120)}
    function closeChat(){panel.classList.remove('chat-open');chat.setAttribute('aria-hidden','true')}
    function answer(){const typing=addMessage('Checking approved brand knowledge…','brain',[]);typing.classList.add('typing');input.disabled=true;setTimeout(()=>{if(!active)return;typing.remove();const reply=chatReplies[chatArea||'all'];addMessage(reply.text,'brain',reply.sources);input.disabled=false;input.focus()},650)}
    function processFile(file,key){const status=document.getElementById('bbIngestStatus'),title=document.getElementById('bbIngestTitle'),copy=document.getElementById('bbIngestCopy');status.classList.add('show');title.textContent='Reading '+file.name;copy.textContent='Extracting trusted facts for '+(key?brainAreas[key].title:'the right knowledge areas')+'…';setTimeout(()=>{if(!active)return;title.textContent='Ready for review';copy.textContent='14 suggested facts mapped for review. Nothing was applied silently.';document.getElementById('bbCompletionValue').textContent='92%';document.getElementById('bbCompletionBar').style.width='92%';document.getElementById('bbKnowledgeCount').textContent='142';document.getElementById('bbSourceCount').textContent='5'},900)}

    stage.addEventListener('pointermove',localPointer);stage.addEventListener('pointerleave',()=>{pointer.inside=false;tilt.tx=0;tilt.ty=0});
    document.getElementById('bbOrbCenter').addEventListener('click',()=>openChat(null));
    document.getElementById('bbCloseBrainChat').addEventListener('click',closeChat);
    form.addEventListener('submit',e=>{e.preventDefault();const q=input.value.trim();if(!q)return;addMessage(q,'user',[]);input.value='';answer()});
    document.querySelectorAll('[data-chat-prompt]').forEach(button=>button.addEventListener('click',()=>{input.value=button.dataset.chatPrompt;form.requestSubmit()}));
    areaDetails.addEventListener('click',()=>{if(chatArea)openDetail(brainAreas[chatArea].title,brainAreas[chatArea].description)});
    document.getElementById('bbChatUpload').addEventListener('click',()=>chatFile.click());
    chatFile.addEventListener('change',()=>{const file=chatFile.files[0];if(!file)return;addMessage(file.name,'user',[]);addMessage('I will extract suggested facts from this source. You will review every change before it is saved.','brain',['Attached source · '+file.name]);processFile(file,chatArea);chatFile.value=''});
    document.getElementById('bbUploadSource').addEventListener('click',()=>globalFile.click());
    globalFile.addEventListener('change',()=>{const file=globalFile.files[0];if(file)processFile(file,null);globalFile.value=''});
    nodes.forEach(node=>{node.addEventListener('click',()=>openChat(node.dataset.area));node.addEventListener('dragover',e=>{e.preventDefault();node.classList.add('dragging')});node.addEventListener('dragleave',()=>node.classList.remove('dragging'));node.addEventListener('drop',e=>{e.preventDefault();node.classList.remove('dragging');const file=e.dataTransfer.files[0];if(file){openChat(node.dataset.area);processFile(file,node.dataset.area)}})});
    ['dragenter','dragover'].forEach(type=>stage.addEventListener(type,e=>{e.preventDefault();stage.classList.add('dragging')}));
    ['dragleave','drop'].forEach(type=>stage.addEventListener(type,e=>{e.preventDefault();stage.classList.remove('dragging')}));
    stage.addEventListener('drop',e=>{const file=e.dataTransfer.files[0];if(file)processFile(file,null)});
    document.querySelectorAll('.bb-card').forEach(card=>card.addEventListener('click',()=>openDetail(card.dataset.bbTitle,card.dataset.bbDesc)));
    document.querySelectorAll('.brand-brain-page .demo-action').forEach(button=>button.addEventListener('click',()=>{if(typeof notify==='function')notify()}));

    const ro=new ResizeObserver(size);ro.observe(stage);size();raf=requestAnimationFrame(draw);
    cleanupBrain=()=>{active=false;cancelAnimationFrame(raf);ro.disconnect()};
  }

  function renderNativeBrandBrain(btn){
    const existingFrame=document.getElementById('brandBrainRouteFrame');if(existingFrame)existingFrame.remove();
    if(cleanupBrain)cleanupBrain();
    state.mode='customer';state.view='brand-brain';
    history.replaceState(null,'','#customer/brand-brain');
    const eyebrow=document.getElementById('pageEyebrow'),title=document.getElementById('pageTitle'),create=document.getElementById('globalCreate'),target=document.getElementById('view');
    if(eyebrow)eyebrow.textContent='Brand intelligence';
    if(title)title.textContent='Brand Brain';
    if(create)create.innerHTML='+ <span>Add knowledge</span>';
    if(!target)return;
    target.innerHTML=markup();
    markNavActive();
    if(btn){btn.classList.add('active');btn.setAttribute('aria-current','page')}
    initBrain();
    if(typeof closeDrawer==='function')closeDrawer();
    if(typeof closeMobile==='function')closeMobile();
    const main=document.querySelector('.main-panel');if(main)main.scrollTo({top:0,behavior:'auto'});
    document.documentElement.classList.remove('brand-brain-boot');
    window.__brandBrainInitial=false;
  }

  document.addEventListener('click',e=>{
    const btn=e.target.closest?.('#brandBrainIntegratedNav');
    if(!btn)return;
    e.preventDefault();e.stopImmediatePropagation();
    renderNativeBrandBrain(btn);
  },true);

  document.addEventListener('click',e=>{
    if(state.view!=='brand-brain')return;
    const target=e.target.closest?.('[data-view-target],[data-mode],[data-special="map"]');
    if(!target)return;
    if(cleanupBrain)cleanupBrain();
  },true);

  window.addEventListener('hashchange',()=>{
    if(location.hash==='#customer/brand-brain'){
      setTimeout(()=>renderNativeBrandBrain(document.getElementById('brandBrainIntegratedNav')),0);
    }
  });

  function boot(){
    const frame=document.getElementById('brandBrainRouteFrame');if(frame)frame.remove();
    if(window.__brandBrainInitial||location.hash==='#customer/brand-brain'){
      setTimeout(()=>renderNativeBrandBrain(document.getElementById('brandBrainIntegratedNav')),0);
    }else{
      document.documentElement.classList.remove('brand-brain-boot');
    }
  }
  boot();
})();
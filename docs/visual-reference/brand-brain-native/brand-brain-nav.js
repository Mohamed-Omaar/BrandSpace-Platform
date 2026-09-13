(() => {
  /* Brand Brain orb cleanup: keep the network continuous through the center. */
  if(!document.getElementById('brandBrainOrbCleanupStyle')){
    const style=document.createElement('style');
    style.id='brandBrainOrbCleanupStyle';
    style.textContent=`
      .brand-brain-page .bb-orb-label{display:none!important}
      .brand-brain-page .bb-orb-center{background:transparent!important;box-shadow:none!important;border:0!important;color:transparent!important}
    `;
    document.head.appendChild(style);
  }

  /* The native canvas clears a circular hole using destination-out.
     Skip that one fill operation only for the Brand Brain canvas. */
  if(!window.__brandBrainOrbFillPatched){
    window.__brandBrainOrbFillPatched=true;
    const nativeFill=CanvasRenderingContext2D.prototype.fill;
    CanvasRenderingContext2D.prototype.fill=function(...args){
      if(this.canvas?.id==='bbOrbCanvas'&&this.globalCompositeOperation==='destination-out')return;
      return nativeFill.apply(this,args);
    };
  }

  function addBrandBrainNav(){
    if(typeof state==='undefined'||state.mode!=='customer')return;
    if(document.getElementById('brandBrainIntegratedNav'))return;
    const brandKit=document.querySelector('[data-view-target="brand"]');
    if(!brandKit)return;
    const btn=brandKit.cloneNode(true);
    btn.id='brandBrainIntegratedNav';
    btn.removeAttribute('data-view-target');
    btn.removeAttribute('aria-current');
    btn.setAttribute('data-label','Brand Brain');
    btn.classList.remove('active');
    const icon=btn.querySelector('.nav-icon');if(icon)icon.textContent='✦';
    const spans=btn.querySelectorAll('span');if(spans[1])spans[1].textContent='Brand Brain';
    const badge=btn.querySelector('.nav-badge');if(badge)badge.textContent='preview';
    brandKit.parentNode.insertBefore(btn,brandKit);
  }
  const nav=document.getElementById('navList');
  if(nav)new MutationObserver(()=>setTimeout(addBrandBrainNav,0)).observe(nav,{childList:true,subtree:true});
  document.addEventListener('click',e=>{
    if(e.target.closest?.('[data-mode],[data-view-target]'))setTimeout(addBrandBrainNav,0);
    const create=e.target.closest?.('#globalCreate');
    if(!create||typeof state==='undefined'||state.view!=='brand-brain')return;
    e.preventDefault();e.stopImmediatePropagation();
    const input=document.getElementById('bbGlobalBrainFile');
    if(input)input.click();else if(typeof notify==='function')notify();
  },true);
  addBrandBrainNav();
})();

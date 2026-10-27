/* One persistent hologram. Native scroll owns the story; manual camera offsets
   are independent and can be reset. No old wireframe/demo controller is used. */
(() => {
  'use strict';
  const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
  const scenes=$$('.story-scene'),menu=$('#scene-menu'),toggle=$('.scene-menu-toggle');
  const media=matchMedia('(max-width:850px)'),reduced=matchMedia('(prefers-reduced-motion:reduce)');
  const query=new URLSearchParams(location.search);
  let reading=query.get('view')==='reading'||media.matches||reduced.matches;
  let started=false,ready=false,paused=false,active=0,stepHeight=1200,dirty=true;
  let scene,camera,renderer,optics,world,objects,routes,data,labels=[],materials=new Map(),boxes=new Map(),samples=new Map();
  let desiredProgress=0,progress=0,lastFrame=0,elapsed=0,frameCount=0;
  const manual={yaw:0,pitch:0,zoom:1,panX:0,panY:0,panZ:0};
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
  const smooth=v=>{v=clamp(v);return v*v*(3-2*v);};
  const angles=[0,12,-18,25,-12,12,18,0];
  const elevations=[8,8,8,-16,-8,-8,6,8];
  const presentations=new Map(),radii=new Map();
  const regions=[-1,1,2,3,4,0,2,1];
  let currentTarget,currentPosition,drag=null,swipe=null,cameraMoving=false,hoveredId='';
  let revealIndex=-1,revealStart=0,revealAge=0,orbitEpoch=0,lastOcclusionCheck=-1;
  const labelRay=new THREE.Raycaster(),occluders=[];
  let scrollIdle=0,lastWheel=0,wheelAmount=0,wheelUsed=false,stepLock=0;

  function closeMenu(focus=false){menu.hidden=true;toggle.setAttribute('aria-expanded','false');if(focus)toggle.focus();}
  toggle.addEventListener('click',()=>{const open=menu.hidden;menu.hidden=!open;toggle.setAttribute('aria-expanded',String(open));});
  document.addEventListener('click',event=>{if(!menu.hidden&&!menu.contains(event.target)&&!toggle.contains(event.target))closeMenu();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeMenu(true);$('.services').open=false;}});
  function setSceneText(index){
    active=index;const el=scenes[index];
    $('#scene-title').innerHTML=el.querySelector('h1,h2').innerHTML;
    $('#scene-description').replaceChildren(...[...el.querySelectorAll('p')].map((p,i)=>{const copy=p.cloneNode(true);copy.style.setProperty('--paragraph-delay',(i*220)+'ms');return copy;}));
    $('#current-scene').textContent=el.dataset.name;
    toggle.setAttribute('aria-label','Explore the story. Current scene: '+el.dataset.name);
    for(const a of menu.querySelectorAll('a[href^="#"]')){if(a.hash==='#'+el.id)a.setAttribute('aria-current','step');else a.removeAttribute('aria-current');}
  }
  function goTo(index,animate=true){
    index=clamp(index,0,scenes.length-1);closeMenu();
    resetCamera();
    if(reading)scenes[index].scrollIntoView({behavior:'auto',block:'start'});
    else {stepLock=performance.now()+850;window.scrollTo({top:(index+.55)*stepHeight,behavior:animate?'smooth':'auto'});}
    history.replaceState(null,'','#'+scenes[index].id);setSceneText(index);dirty=true;
  }
  for(const a of $$('a[href^="#"]')){
    const index=scenes.findIndex(s=>'#'+s.id===a.getAttribute('href'));
    if(index>=0)a.addEventListener('click',event=>{event.preventDefault();goTo(index);});
  }
  function setReading(value){
    reading=Boolean(value||media.matches||reduced.matches);
    document.body.classList.toggle('immersive',ready&&!reading);
    $('#explanation').hidden=reading||!ready;$('#scene-controls').hidden=reading||!ready;
    $('#scroll-cue').hidden=reading||!ready||active!==0;
    $('#reading-toggle').textContent=reading?'Immersive view':'Reading view';
    $('#reading-toggle').disabled=media.matches||reduced.matches;
    $('#load-status').hidden=reading||ready;
    if(ready){resize();if(reading)scenes[active].scrollIntoView({block:'start'});else window.scrollTo(0,(active+.55)*stepHeight);}
    else if(!reading&&!started)start();
    dirty=true;
  }
  $('#reading-toggle').addEventListener('click',()=>{
    closeMenu();setReading(!reading);const url=new URL(location.href);
    if(reading)url.searchParams.set('view','reading');else url.searchParams.delete('view');
    history.replaceState(null,'',url);
  });
  media.addEventListener('change',()=>setReading(media.matches||reduced.matches||query.get('view')==='reading'));
  reduced.addEventListener('change',()=>setReading(reduced.matches||media.matches));
  $('#pause-motion').addEventListener('click',()=>{
    paused=!paused;const b=$('#pause-motion');b.setAttribute('aria-pressed',String(paused));b.setAttribute('aria-label',paused?'Resume motion':'Pause motion');b.title=paused?'Resume motion':'Pause motion';dirty=true;
  });
  function resetCamera(){Object.assign(manual,{yaw:0,pitch:0,zoom:1,panX:0,panY:0,panZ:0});dirty=true;}
  function panCamera(dx,dy){
    const right=new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion);
    const up=new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion);
    const delta=right.multiplyScalar(-dx*.008).addScaledVector(up,dy*.008);
    manual.panX+=delta.x;manual.panY+=delta.y;manual.panZ+=delta.z;dirty=true;
  }
  function advance(direction){
    if(reading||!ready||performance.now()<stepLock)return;
    goTo(clamp(Math.round(desiredProgress-.55)+direction,0,7));
  }
  addEventListener('wheel',event=>{
    if(reading||!ready||event.ctrlKey||event.target.closest?.('#scene-menu,.menu-panel'))return;
    event.preventDefault();if(!event.deltaY)return;const now=performance.now();
    // A heavy frame can delay a continuous trackpad stream past 350ms.
    // Keep that stream latched until a real pause or direction change.
    if(now-lastWheel>650||Math.sign(wheelAmount)!==Math.sign(event.deltaY)){wheelAmount=0;wheelUsed=false;}
    lastWheel=now;wheelAmount+=event.deltaY*(event.deltaMode===1?16:1);
    if(!wheelUsed&&Math.abs(wheelAmount)>24&&now>=stepLock){wheelUsed=true;advance(Math.sign(wheelAmount));}
  },{passive:false});
  addEventListener('keydown',event=>{
    if(reading||!ready||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!menu.hidden||event.target.closest?.('input,select,textarea,[contenteditable="true"]'))return;
    if(event.key===' '&&event.target.closest?.('a,button,summary'))return;
    if(['ArrowDown','PageDown',' '].includes(event.key)){event.preventDefault();advance(1);}
    else if(['ArrowUp','PageUp'].includes(event.key)){event.preventDefault();advance(-1);}
    else if(event.key==='Home'){event.preventDefault();goTo(0);}
    else if(event.key==='End'){event.preventDefault();goTo(7);}
  });
  addEventListener('pointerdown',event=>{
    if(event.pointerType==='mouse'||reading||!ready||event.target.closest?.('a,button,input,select,textarea,summary,#scene-menu'))return;
    if(!event.isPrimary){swipe=null;return;}
    swipe={id:event.pointerId,startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY};
  });
  addEventListener('pointermove',event=>{if(swipe?.id===event.pointerId){swipe.x=event.clientX;swipe.y=event.clientY;}});
  addEventListener('pointerup',event=>{
    if(swipe?.id!==event.pointerId)return;
    const dx=swipe.x-swipe.startX,dy=swipe.y-swipe.startY,travel=Math.abs(dy)>=Math.abs(dx)?dy:dx;
    if(Math.abs(travel)>44)advance(travel<0?1:-1);swipe=null;
  });
  addEventListener('pointercancel',()=>{swipe=null;});
  $('#scene-controls').addEventListener('keydown',event=>{
    if(!event.shiftKey||!event.key.startsWith('Arrow'))return;
    event.preventDefault();panCamera(event.key==='ArrowLeft'?-32:event.key==='ArrowRight'?32:0,event.key==='ArrowUp'?-32:event.key==='ArrowDown'?32:0);
  });
  for(const button of $$('[data-camera]'))button.addEventListener('click',()=>{
    switch(button.dataset.camera){
      case'left':manual.yaw-=.22;break;case'right':manual.yaw+=.22;break;
      case'up':manual.pitch=clamp(manual.pitch+.12,-1.35,1.15);break;
      case'down':manual.pitch=clamp(manual.pitch-.12,-1.35,1.15);break;
      case'in':manual.zoom=clamp(manual.zoom*.9,.65,1.6);break;
      case'out':manual.zoom=clamp(manual.zoom/ .9,.65,1.6);break;
      default:resetCamera();orbitEpoch=elapsed;
    }dirty=true;
  });
  function onScroll(){
    desiredProgress=clamp(scrollY/stepHeight,0,7.999);dirty=true;
    clearTimeout(scrollIdle);
    if(!reading&&ready)scrollIdle=setTimeout(function settleScroll(){
      if(performance.now()<stepLock){scrollIdle=setTimeout(settleScroll,stepLock-performance.now()+30);return;}
      const index=clamp(Math.round(desiredProgress-.55),0,7),target=index+.55;
      if(Math.abs(desiredProgress-target)>.008)goTo(index);
    },220);
  }
  addEventListener('scroll',onScroll,{passive:true});
  addEventListener('resize',()=>{if(ready)resize();dirty=true;});
  function resize(){
    const oldStep=stepHeight;stepHeight=Math.max(1000,innerHeight*1.45);
    document.documentElement.style.setProperty('--scene-height',stepHeight+'px');
    if(renderer){renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight,false);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();}
    if(ready&&!reading&&Math.abs(stepHeight-oldStep)>1){clearTimeout(scrollIdle);window.scrollTo({top:(active+.55)*stepHeight,behavior:'instant'});desiredProgress=active+.55;}
    onScroll();
  }
  function objectStage(id){return data.objectStages[id]??99;}
  function topicStage(id){return data.focusStages?.[id]??objectStage(id);}
  function positionOf(object){return object.getWorldPosition(new THREE.Vector3());}
  function driver(object){return object.userData.presentation||object;}
  function groupFor(index){
    const ids=[...objects.keys()].filter(id=>(index===3?objectStage(id)===3:topicStage(id)===index)&&!id.includes('-person'));
    if(!ids.includes('enterprise-brain'))ids.push('enterprise-brain');
    if(index>=3&&!ids.includes('mcp'))ids.push('mcp');return ids;
  }
  function fit(ids,yaw,pitch,padding=1.03){
    const points=[],bounds=new THREE.Box3();
    for(const id of ids){const o=objects.get(id);if(!o)continue;const p=positionOf(o),radius=(radii.get(id)||.7)*1.12;for(const axis of [new THREE.Vector3(radius,0,0),new THREE.Vector3(0,radius,0),new THREE.Vector3(0,0,radius)]){points.push(p.clone().add(axis),p.clone().sub(axis));}bounds.expandByPoint(p.clone().addScalar(radius));bounds.expandByPoint(p.clone().addScalar(-radius));}
    const target=bounds.getCenter(new THREE.Vector3()),direction=new THREE.Vector3(Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch));
    const right=new THREE.Vector3(0,1,0).cross(direction).normalize(),up=direction.clone().cross(right).normalize();
    const pane=$('#explanation').getBoundingClientRect(),usableH=Math.max(.3,(innerWidth-pane.right-36)/innerWidth),usableV=(innerHeight-155)/innerHeight;
    const tanV=Math.tan(THREE.MathUtils.degToRad(camera.fov/2)),tanH=tanV*camera.aspect;let distance=1;
    for(const p of points){const v=p.clone().sub(target),z=v.dot(direction);distance=Math.max(distance,Math.abs(v.dot(right))/(tanH*usableH)+z,Math.abs(v.dot(up))/(tanV*usableV)+z);}
    return{target,direction,distance:distance*padding};
  }
  function cameraPose(index,local){
    const before=Math.max(0,index-1),entry=smooth(local/.42),yaw=THREE.MathUtils.lerp(angles[before],angles[index],entry)*Math.PI/180+manual.yaw;
    const pitch=clamp(THREE.MathUtils.lerp(elevations[before],elevations[index],entry)*Math.PI/180+manual.pitch,-1.22,1.30);
    const focus=fit(groupFor(index),yaw,pitch),prior=fit(groupFor(before),yaw,pitch);
    if(index>0&&entry<1){focus.target.lerp(prior.target,1-entry);focus.distance=THREE.MathUtils.lerp(prior.distance,focus.distance,entry);}
    if(index===7){const all=fit([...objects.keys()].filter(id=>!id.includes('-person')),yaw,pitch);focus.target.copy(all.target);focus.distance=all.distance;}
    focus.distance*=manual.zoom*1.25;
    const right=new THREE.Vector3(0,1,0).cross(focus.direction).normalize(),up=focus.direction.clone().cross(right).normalize();
    const pane=$('#explanation').getBoundingClientRect();focus.target.addScaledVector(right,-focus.distance*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))*camera.aspect*(pane.right/innerWidth));
    focus.target.x+=manual.panX;focus.target.y+=manual.panY;focus.target.z+=manual.panZ;
    return{target:focus.target,position:focus.target.clone().addScaledVector(focus.direction,focus.distance),up};
  }
  function configureMaterials(id,object){
    const isBrain=id.includes('brain'),row=data.brains.find(x=>x.id===id);
    MTWHolograms.setMaterial(object,isBrain?1:.32,row?.materialGain??1,'surface',-1);
    const list=[];object.traverse(o=>{for(const m of(Array.isArray(o.material)?o.material:[o.material]))if(m?.uniforms){list.push(m);if(id.startsWith('best-work-')){if(m.uniforms.gain)m.uniforms.gain.value=.30;if(!m.userData.light){m.uniforms.solid.value=1;m.uniforms.surface.value=1;m.depthWrite=true;}}}});
    if(/Person|Seated/.test(object.userData.asset||''))for(const m of list){if(m.uniforms.rimGain)m.uniforms.rimGain.value=Math.max(5,m.uniforms.rimGain.value);if(m.uniforms.energy)m.uniforms.energy.value*=1.6;}
    materials.set(id,list);
    const shell=object.children.find(o=>o.userData.occlusionMask)||object.children.find(o=>o.isMesh&&!o.material?.userData.light);if(shell)occluders.push({id,object,shell});
  }
  function buildLabels(){
    const host=$('#world-labels');
    labels=data.labels.map((row,index)=>{const el=document.createElement('span');el.className='world-label';el.textContent=row.text;el.dataset.label=String(index);host.append(el);const o=objects.get(row.anchor),offset=new THREE.Vector3(...row.position).sub(o.userData.restPosition).applyQuaternion(o.userData.restQuaternion.clone().invert()).divide(o.userData.baseScaleVector);return{el,anchor:row.anchor,offset,stage:row.stage??0,text:row.text,w:Math.max(60,row.text.length*8.3),h:24,slot:0,occluded:false};});
    document.fonts.ready.then(()=>{for(const l of labels){l.w=l.el.offsetWidth;l.h=l.el.offsetHeight;}dirty=true;});
  }
  function updateLabels(index){
    const pane=$('#explanation').getBoundingClientRect(),used=[],check=elapsed-lastOcclusionCheck>.18;if(check)lastOcclusionCheck=elapsed;
    const intersects=(a,b)=>a.x<b.x+b.w+6&&a.x+a.w+6>b.x&&a.y<b.y+b.h+4&&a.y+a.h+4>b.y;
    const focus=new Set(groupFor(index));
    if(index===1)for(const[id]of objects)if(id.startsWith('best-work-'))focus.delete(id);
    if(index===3)for(const[id]of objects)if(id.startsWith('agent-')||id.startsWith('human-'))focus.delete(id);
    if(index===7){focus.clear();focus.add('enterprise-brain');focus.add('mcp');for(const[id]of objects)if(id.endsWith('-cloud'))focus.add(id);}
    for(const l of labels){const anchor=objects.get(l.anchor);if(l.stage>index||!anchor.visible||(anchor.userData.revealOpacity??0)<.5||(!focus.has(l.anchor)&&l.anchor!==hoveredId)){l.el.hidden=true;continue;}
      const point=anchor.localToWorld(l.offset.clone()),center=positionOf(anchor);
      if(check){const same=id=>id===l.anchor||id.startsWith(l.anchor+'-')||(/-cloud$/.test(l.anchor)&&id.replace(/-(cloud|badge|symbol)$/,'')===l.anchor.replace(/-cloud$/,''));
        l.occluded=(l.anchor==='enterprise-brain'?[point]:[center,point]).some(probe=>{labelRay.set(camera.position,probe.clone().sub(camera.position).normalize());labelRay.far=camera.position.distanceTo(probe)-.1;return occluders.some(o=>!same(o.id)&&o.object.visible&&(o.object.userData.focused||o.id.includes('brain'))&&(o.object.userData.revealOpacity??1)>.8&&labelRay.intersectObject(o.shell,false).length);});}
      if(l.occluded){l.el.hidden=true;continue;}
      const p=point.project(camera);if(p.z>1||p.z< -1){l.el.hidden=true;continue;}
      const x=clamp((p.x*.5+.5)*innerWidth-l.w/2,pane.right+12,innerWidth-l.w-12),y=clamp((-p.y*.5+.5)*innerHeight-l.h-4,78,innerHeight-l.h-64);
      let box={x,y:y+l.slot,w:l.w,h:l.h};
      if(used.some(b=>intersects(box,b))||box.y<78||box.y+box.h>innerHeight-64){
        for(const dy of [0,-28,28,-56,56]){const candidate={x,y:clamp(y+dy,78,innerHeight-l.h-64),w:l.w,h:l.h};if(!used.some(b=>intersects(candidate,b))){box=candidate;l.slot=box.y-y;break;}}
      }
      used.push(box);l.el.hidden=false;l.el.style.transform=`translate(${box.x.toFixed(1)}px,${box.y.toFixed(1)}px)`;
      const input=l.anchor.startsWith('best-work-');l.el.style.opacity=String(input?.48:1);l.el.classList.toggle('is-focus',!input);
    }
  }
  function revealDelay(id,index){
    if(index===1)return id.startsWith('knowledge-')?.15:id.startsWith('operator-')?1.85:id.startsWith('best-work-')?3.55:0;
    if(index===3)return id==='mcp'?.15:id.startsWith('human-')?1.85:id.startsWith('agent-')?3.55:0;
    return .15;
  }
  function revealAmount(id,index){const stage=objectStage(id);return stage<index?1:stage>index?0:index===0?1:smooth((revealAge-revealDelay(id,index))/1.45);}
  function updateWorld(index,local,time){
    const assembled=index===7&&local>.50;
    for(const[id,object]of objects){
      const stage=objectStage(id),isBrain=id.includes('brain'),central=id==='enterprise-brain';
      const entering=revealAmount(id,index);object.userData.revealOpacity=entering;
      const visible=stage<=index&&id!=='atmosphere'&&entering>.001;object.visible=visible;if(!visible)continue;
      const focused=topicStage(id)===index||central||id==='mcp'||index===3&&stage===3;
      object.userData.focused=focused;
      const human=/Person|Seated/.test(object.userData.asset||'');
      const input=id.startsWith('best-work-'),presentation=driver(object),depthFade=presentation.userData.depthGain??1;object.userData.depthFade=depthFade;
      const gain=(input?.25:isBrain?(central?1:.88):human?(focused?1.55:.70):focused?1:.40)*entering*(isBrain?Math.max(.72,depthFade):depthFade);
      for(const m of materials.get(id)||[]){
        if(m.uniforms.gain)m.uniforms.gain.value=gain;
        if(m.uniforms.focus)m.uniforms.focus.value=input?0:central?0:(focused&&!isBrain?.08:0);
        if(m.uniforms.selection)m.uniforms.selection.value=central?regions[index]:-1;
        if(m.uniforms.articulation)m.uniforms.articulation.value=id.startsWith('operator-')&&(id.endsWith('-person')||id==='operator-manual')&&/Human/.test(m.userData.source?.name||'')?Math.sin(time*3.6+stage)*.018:0;
        if(m.uniforms.surface&&m.userData.light)m.uniforms.surface.value=.95*entering;
        if(m.uniforms.surface&&!m.userData.light)m.uniforms.surface.value=isBrain?1:input?entering:.32*THREE.MathUtils.lerp(.48,1,presentation.userData.depthWeight??.5)*entering*(focused?1:.32);
      }
      object.renderOrder=10000+Math.round(positionOf(presentation).applyMatrix4(camera.matrixWorldInverse).z*100)+(human?2:0);
      object.traverse(o=>{if(o.userData.occlusionMask)o.material.opacity=(human?.95:presentations.has(id)?.68:.90)*entering*(focused||input?1:.22);});
    }
    for(const[id,route]of routes){
      const stage=data.routeStages[id]??99;
      const anchors=route.userData.record;const delay=Math.max(revealDelay(anchors.startAnchor||'',index),revealDelay(anchors.endAnchor||'',index))+.35;
      const amount=stage<index?1:stage===index?smooth((revealAge-delay)/1.6)*Math.min(revealAmount(anchors.startAnchor,index),revealAmount(anchors.endAnchor,index)):0;
      MTWHolograms.revealRoute(route,amount);
      const record=route.userData.record,start=objects.get(record.startAnchor),end=objects.get(record.endAnchor);
      route.userData.startDelta=start?positionOf(start).sub(start.userData.restPosition):new THREE.Vector3();
      route.userData.endDelta=end?positionOf(end).sub(end.userData.restPosition):new THREE.Vector3();
      if(record.arrow){const group=data.orbitGroups.find(g=>g.id==='environments'),stretch=group?.ellipseX||1;route.matrixAutoUpdate=false;route.matrix.makeScale(stretch,1,1).multiply(new THREE.Matrix4().makeRotationY((time-orbitEpoch)*(group?.speed??-.032))).multiply(new THREE.Matrix4().makeScale(1/stretch,1,1));route.userData.startDelta.set(0,0,0);route.userData.endDelta.set(0,0,0);}
      for(const m of materials.get('route:'+id)||[]){m.uniforms.routeStartDelta?.value.copy(route.userData.startDelta);m.uniforms.routeEndDelta?.value.copy(route.userData.endDelta);}
      for(const m of materials.get('route:'+id)||[])if(m.uniforms.gain)m.uniforms.gain.value=id.startsWith('input-')?.13:stage===index?(route.userData.record.arrow?.6:.36):.075;
      MTWHolograms.animateRoute(route,time,true);
      if(route.userData.packetMesh){route.userData.packetMesh.material.opacity=id.startsWith('input-')?.20:stage===index?.55:.14;}
    }
    return assembled;
  }
  function buildPresentations(){
    for(const[id,o]of objects){
      const asset=o.userData.asset||'',cloud=id.endsWith('-cloud');if(!cloud&&!/reader|agent code|^(Claude|Codex|SharePoint) operator$/i.test(asset))continue;
      const g=new THREE.Group();g.name=id+' presentation';g.position.copy(o.userData.restPosition);g.userData.restPosition=o.userData.restPosition.clone();g.userData.owner=id;world.add(g);presentations.set(id,g);
      g.add(o);o.position.set(0,0,0);o.quaternion.identity();o.userData.presentation=g;o.userData.presentationLead=true;
      for(const[childId,child]of objects){const person=childId.startsWith(id+'-person'),cloudPart=cloud&&childId.replace(/-(badge|symbol)$/,'')===id.replace(/-cloud$/,'')&&childId!==id;if(!person&&!cloudPart)continue;
        g.add(child);child.userData.presentation=g;child.userData.presentationLead=false;
        if(person){const n=Number(childId.split('-person-')[1]||0);child.position.set(id.startsWith('operator-')?.72:-.54+n*.43,-.22,1.15);child.quaternion.copy(child.userData.restQuaternion);}
        else{child.position.copy(child.userData.restPosition).sub(o.userData.restPosition);child.quaternion.identity();}
      }
    }
  }
  function orbitObjects(time){
    const axis=new THREE.Vector3(0,1,0);
    for(const group of data.orbitGroups||[])for(const id of group.objects){const o=objects.get(id);if(!o||o.userData.presentation&&!o.userData.presentationLead)continue;const d=driver(o),stretch=group.ellipseX||1;d.position.copy(d.userData.restPosition);d.position.x/=stretch;d.position.applyAxisAngle(axis,time*group.speed);d.position.x*=stretch;}
  }
  function presentSubjects(){
    for(const[id,o]of objects){if(o.userData.presentation&&!o.userData.presentationLead)continue;const d=driver(o),rest=d.userData.restPosition,pos=d.position;
      const c=new THREE.Vector3(0,rest.y,0).applyMatrix4(camera.matrixWorldInverse),p=pos.clone().applyMatrix4(camera.matrixWorldInverse),radius=Math.max(2,Math.hypot(rest.x,rest.z));
      const weight=clamp(.5+(p.z-c.z)/(2*radius)),size=id==='enterprise-brain'?1:THREE.MathUtils.lerp(.80,1.12,weight),depth=id==='enterprise-brain'?1:THREE.MathUtils.lerp(.38,1.22,weight);
      d.userData.depthWeight=weight;d.userData.depthGain=depth;d.userData.scaleFactor=size;
      if(presentations.has(id)){d.quaternion.copy(camera.quaternion);if(!id.endsWith('-cloud'))d.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(.04,-.20,0)));d.scale.setScalar(size);}
      else{const faces=id==='mcp'||/knowledge-|best-work-|-(file|badge|symbol)$/.test(id);if(faces){o.quaternion.copy(camera.quaternion);if(id.startsWith('knowledge-'))o.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(.04,-.24,0)));}o.scale.copy(o.userData.baseScaleVector).multiplyScalar(size);}
    }
  }
  function loop(now){
    requestAnimationFrame(loop);const dt=Math.min(.05,(now-lastFrame)/1000||.016);lastFrame=now;
    if(!ready||reading||document.hidden)return;
    if(paused&&!dirty&&!cameraMoving&&Math.abs(progress-desiredProgress)<.001)return;
    if(!paused)elapsed+=dt;
    orbitObjects(elapsed-orbitEpoch);world.updateMatrixWorld(true);
    const rate=1-Math.exp(-dt*12);progress+= (desiredProgress-progress)*rate;
    if(Math.abs(progress-desiredProgress)<.0005)progress=desiredProgress;
    const index=clamp(Math.floor(progress),0,7),local=progress-index;
    if(index!==revealIndex){revealIndex=index;revealStart=elapsed;}revealAge=elapsed-revealStart;
    if(index!==active)setSceneText(index);
    const pose=cameraPose(index,local);
    currentTarget.lerp(pose.target,rate);currentPosition.lerp(pose.position,rate);
    cameraMoving=currentTarget.distanceToSquared(pose.target)+currentPosition.distanceToSquared(pose.position)>.000001;
    camera.position.copy(currentPosition);camera.up.lerp(pose.up,rate).normalize();camera.lookAt(currentTarget);camera.updateMatrixWorld();
    presentSubjects();world.updateMatrixWorld(true);
    const assembled=updateWorld(index,local,elapsed);
    renderer.info.reset();optics.render(scene,camera);updateLabels(index,local,assembled);
    $('#scroll-cue').hidden=index!==0;
    frameCount++;dirty=false;
  }
  async function start(){
    if(started)return;started=true;$('#load-status').hidden=false;
    try{
      await MTWHolograms.load();data=window.MTW_ENTERPRISE;
      renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
      renderer.setClearColor(0x030b0e,1);renderer.toneMapping=THREE.AgXToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.info.autoReset=false;
      renderer.domElement.setAttribute('aria-hidden','true');renderer.domElement.title='Scroll or swipe to the next scene. Drag to rotate; Shift-drag to pan.';$('#world').prepend(renderer.domElement);
      renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();setReading(true);$('#load-status').textContent='The 3D view paused. Continue with the full story below.';$('#load-status').hidden=false;});
      scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(37,innerWidth/innerHeight,.1,160);camera.up.set(0,1,0);
      world=MTWHolograms.enterprise();scene.add(world);objects=world.userData.objects;routes=world.userData.routes;
      const glyphs=world.getObjectByName('World labels');if(glyphs)glyphs.visible=false;
      world.updateMatrixWorld(true);
      for(const[id,o]of objects){
        o.userData.restQuaternion=o.quaternion.clone();configureMaterials(id,o);const box=new THREE.Box3().setFromObject(o);boxes.set(id,box);radii.set(id,box.getBoundingSphere(new THREE.Sphere()).radius);
        const points=[];
        o.traverse(child=>{
          if(!child.visible||!child.isMesh||!child.geometry?.attributes.position)return;
          const pos=child.geometry.attributes.position,stride=Math.max(1,Math.floor(pos.count/(id.includes('brain')?600:90)));
          for(let i=0;i<pos.count;i+=stride)points.push(new THREE.Vector3().fromBufferAttribute(pos,i).applyMatrix4(child.matrixWorld));
        });samples.set(id,points);
      }
      for(const[id,o]of routes){const mats=[];o.traverse(child=>{if(child.material?.uniforms)mats.push(child.material);});materials.set('route:'+id,mats);}
      buildPresentations();world.updateMatrixWorld(true);optics=MTWHologramOptics.create(renderer);buildLabels();resize();
      const selected=scenes.findIndex(s=>'#'+s.id===location.hash);if(selected>=0){progress=selected+.55;desiredProgress=progress;active=selected;}
      const initial=cameraPose(active,progress-active);currentTarget=initial.target.clone();currentPosition=initial.position.clone();
      ready=true;setReading(false);setSceneText(active);
      if(selected<0){progress=.55;desiredProgress=.55;window.scrollTo(0,.55*stepHeight);}
      renderer.domElement.addEventListener('pointerdown',event=>{
        if(event.pointerType!=='mouse')return;
        drag={x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,touch:event.pointerType!=='mouse',pan:event.shiftKey};renderer.domElement.setPointerCapture(event.pointerId);
      });
      renderer.domElement.addEventListener('pointermove',event=>{
        if(!drag){const pointer=new THREE.Vector3((event.clientX/innerWidth)*2-1,1-(event.clientY/innerHeight)*2,.5).unproject(camera);labelRay.set(camera.position,pointer.sub(camera.position).normalize());labelRay.far=Infinity;let nearest=Infinity,next='';for(const o of occluders)if(o.object.visible&&(o.object.userData.revealOpacity??0)>.8){const hit=labelRay.intersectObject(o.shell,false)[0];if(hit&&hit.distance<nearest){nearest=hit.distance;next=o.id.replace(/-person(?:-\d+)?$/,'');}}hoveredId=next;dirty=true;}
        if(!drag)return;if(drag.touch){drag.x=event.clientX;drag.y=event.clientY;return;}const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
        if(drag.pan)panCamera(dx,dy);
        else{manual.yaw-=dx*.004;manual.pitch=clamp(manual.pitch+dy*.003,-1.35,1.15);}
        drag.x=event.clientX;drag.y=event.clientY;dirty=true;
      });
      renderer.domElement.addEventListener('pointerup',()=>{
        if(drag?.touch){const dx=drag.x-drag.startX,dy=drag.y-drag.startY,travel=Math.abs(dy)>=Math.abs(dx)?dy:dx;if(Math.abs(travel)>44)advance(travel<0?1:-1);}
        drag=null;
      });
      for(const type of['pointercancel','lostpointercapture'])renderer.domElement.addEventListener(type,()=>{drag=null;});
      requestAnimationFrame(loop);
      // Read-only evidence for repeatable browser verification, never used as a
      // second scene controller. Tests scroll/click the real controls.
      window.enterpriseEvidence=()=>({ready,reading,paused,active,progress,frameCount,elapsed,revealAge,hoveredId,subjectScreens:[...objects].filter(([,o])=>o.visible).map(([id,o])=>{const p=positionOf(o).project(camera);return{id,x:(p.x*.5+.5)*innerWidth,y:(.5-p.y*.5)*innerHeight};}),camera:{position:camera.position.toArray(),target:currentTarget.toArray(),yaw:manual.yaw,pitch:manual.pitch,zoom:manual.zoom,pan:[manual.panX,manual.panY,manual.panZ]},
        reveals:[...objects].map(([id,o])=>({id,amount:o.userData.revealOpacity,mask:o.children.find(c=>c.userData.occlusionMask)?.material.opacity})),
        visibleObjects:[...objects].filter(([,o])=>o.visible).map(([id])=>id),
        routes:[...routes].map(([id,o])=>({id,visible:o.visible,progress:o.userData.progress,packets:o.userData.packetMesh.visible,firstPacket:Array.from(o.userData.packetMesh.instanceMatrix.array.slice(12,15))})),
        brainSurfaces:(materials.get('enterprise-brain')||[]).filter(m=>!m.userData.light).map(m=>({opacity:m.uniforms.surface.value,depthWrite:m.depthWrite,region:m.uniforms.selection.value})),
        labels:labels.filter(l=>!l.el.hidden).map(l=>({text:l.text,rect:JSON.parse(JSON.stringify(l.el.getBoundingClientRect())),opacity:l.el.style.opacity,anchor:l.anchor})),
        occludedLabels:labels.filter(l=>l.stage<=active&&l.occluded).map(l=>l.text),
        operatorPresentation:[...objects].filter(([id])=>id.startsWith('operator-')&&id.endsWith('-person')).map(([id,o])=>({id,frontDistance:positionOf(o).sub(positionOf(objects.get(id.replace('-person','')))).dot(new THREE.Vector3(0,0,1).applyQuaternion(camera.quaternion))})),
        orbitalObjects:[...objects].filter(([id])=>id.includes('brain')||id.startsWith('operator-')).map(([id,o])=>({id,position:positionOf(o).toArray(),parent:o.parent.name,scale:driver(o).userData.scaleFactor,surface:(materials.get(id)||[]).filter(m=>!m.userData.light).map(m=>m.uniforms.surface?.value),gain:(materials.get(id)||[])[0]?.uniforms.gain?.value,depthFade:o.userData.depthFade})),
        triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls,source:data.source,sourceHash:data.source_sha256,orbitGroups:data.orbitGroups,presentations:[...presentations].map(([id,g])=>({id,children:g.children.map(o=>o.name),position:g.position.toArray(),baseScale:objects.get(id).userData.baseScaleVector.toArray(),front:new THREE.Vector3(0,0,1).applyQuaternion(g.quaternion).toArray(),scale:g.scale.x})),cameraUp:camera.up.toArray(),worldUpOnScreen:new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion.clone().invert()).toArray(),bestWork:[...objects].filter(([id])=>id.startsWith('best-work-')).map(([id])=>({id,gain:materials.get(id)[0].uniforms.gain.value,focus:materials.get(id)[0].uniforms.focus.value}))});
    }catch(error){
      console.error(error);reading=true;document.body.classList.remove('immersive');$('#explanation').hidden=true;$('#scene-controls').hidden=true;
      $('#load-status').textContent='The 3D view couldn’t load. The complete story is available below.';
      $('#load-status').hidden=false;
    }
  }
  if(reading){$('#load-status').hidden=true;setReading(true);}else start();
})();

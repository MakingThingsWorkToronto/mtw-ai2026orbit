/* Versioned shared Blender geometry. Source holographic surfaces, real depth and curves. */
window.MTWHolograms=(()=>{
  let pending,binary;
  const scriptURL=document.currentScript.src;
  const geometryCache=new Map();
  async function load(){
    if(!pending)pending=(async()=>{
      const url=new URL('../models/enterprise-orbits-v12d.json',scriptURL);
      const response=await fetch(url);if(!response.ok)throw new Error('The hologram could not load.');
      window.MTW_ENTERPRISE=await response.json();
      const buffer=await fetch(new URL(window.MTW_ENTERPRISE.binary,url));if(!buffer.ok)throw new Error('The hologram geometry could not load.');
      binary=await buffer.arrayBuffer();window.MTW_BRAIN_PREVIEW=window.MTW_ENTERPRISE.brainBuffers;
    })();
    try{await pending;}catch(error){pending=null;throw error;}
  }
  function decode(value,Type=Float32Array){
    if(typeof value==='object')return new Type(binary,value.offset,value.length);
    return new Type(Uint8Array.from(atob(value),c=>c.charCodeAt(0)).buffer);
  }
  function geometry(part){
    if(geometryCache.has(part))return geometryCache.get(part);
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(decode(part.positions),3));
    if(part.normals)g.setAttribute('normal',new THREE.BufferAttribute(decode(part.normals),3));
    if(part.regions)g.setAttribute('region',new THREE.BufferAttribute(decode(part.regions),1));
    if(part.pathProgress)g.setAttribute('pathProgress',new THREE.BufferAttribute(decode(part.pathProgress),1));
    if(part.indices)g.setIndex(new THREE.BufferAttribute(decode(part.indices,Uint32Array),1));
    g.computeBoundingBox();g.computeBoundingSphere();geometryCache.set(part,g);return g;
  }
  const meshVertex=`
    attribute float region;attribute float pathProgress;uniform float edgeWidth;uniform float articulation;uniform vec3 routeStartDelta;uniform vec3 routeEndDelta;
    varying vec3 N;varying vec3 V;varying float R;varying float P;
    void main(){vec3 v=position+normal*edgeWidth;float forward=-.829*v.x+.559*v.z;float arm=smoothstep(.12,.29,forward)*(1.-smoothstep(.34,.43,v.y))*smoothstep(.22,.28,v.y);v.y+=articulation*arm;v+=mix(routeStartDelta,routeEndDelta,pathProgress);vec4 p=modelViewMatrix*vec4(v,1.);V=-p.xyz;N=normalMatrix*normal;R=region;P=pathProgress;gl_Position=projectionMatrix*p;}
  `;
  const meshFragment=`
    uniform vec3 tint;uniform vec3 emissionTint;
    uniform float surface;uniform float coverage;uniform float gain;uniform float selection;
    uniform float focus;uniform float solid;uniform float light;uniform float energy;
    uniform float rimGain;uniform float rimPower;uniform float backfaceFactor;uniform float routeProgress;uniform float rimAlpha;uniform float roughness;uniform float anatomy;
    varying vec3 N;varying vec3 V;varying float R;varying float P;
    void main(){
      if(P>routeProgress+.00001)discard;
      float selected=selection<0.?0.:1.-smoothstep(.25,.8,abs(R-selection));
      float emphasis=max(focus,selected);vec3 ice=vec3(.72,.94,1.);
      vec3 base=mix(tint,ice,emphasis*.22);vec3 glow=mix(emissionTint,ice,emphasis*.72);
      if(light>.5){gl_FragColor=vec4(glow*energy*gain*(1.+emphasis*.4),surface);return;}
      vec3 n=normalize(N),view=normalize(V);float facing=abs(dot(n,view));float rim=pow(1.-facing,rimPower);
      vec3 reflection=reflect(-view,n);
      float fold=.20+.80*max(0.,dot(n,normalize(vec3(-.45,.8,.6))));
      float strip=pow(max(0.,dot(reflection,normalize(vec3(-.65,.75,.55)))),90.);
      float secondStrip=pow(max(0.,dot(reflection,normalize(vec3(.7,.35,.45)))),120.);
      float sky=pow(max(0.,reflection.y),8.);
      float fresnel=.035+.965*pow(1.-facing,5.);
      vec3 studio=vec3(.52,.81,.90)*(strip*.95+secondStrip*.6+sky*.10);
      vec3 color=base*(.18+.50*fold)+glow*(energy+rim*rimGain*.62)+studio*(.4+.6*fresnel);
      color+=glow*emphasis*(.04+.28*rim);
      if(anatomy>.5){
        color=tint*(.5+fold)+glow*(energy+rim*rimGain)+studio*.05;
        color+=ice*selected*(.012+.16*rim);
      }
      float alpha=surface>=.999?1.:min(.88,surface/.32*(coverage+rim*rimAlpha+strip*.08));
      if(surface<=0.)alpha=0.;
      if(!gl_FrontFacing&&surface<.999)alpha*=backfaceFactor;
      if(solid>.5){alpha=surface;color=base*(.22+.78*fold)+glow*(energy+rim*rimGain*.18);}
      gl_FragColor=vec4(color*gain,alpha);
    }
  `;
  function material(info={},routeProgress={value:1}){
    const optical=info.optical||{},isLight=info.mode==='light';
    const result=new THREE.ShaderMaterial({
      vertexShader:meshVertex,fragmentShader:meshFragment,
      uniforms:{
        edgeWidth:{value:isLight&&/bevel|relief|document ink|shield edge/i.test(info.name||'')?.0024:0},
        articulation:{value:0},routeStartDelta:{value:new THREE.Vector3()},routeEndDelta:{value:new THREE.Vector3()},
        tint:{value:new THREE.Color(...(info.color||[.05,.45,.6]))},
        emissionTint:{value:new THREE.Color(...(info.emissionColor||info.color||[.025,.64,.86]))},
        surface:{value:isLight?.95:.32},coverage:{value:Math.max(info.coverage??.32,.08)},gain:{value:1},
        selection:{value:-1},focus:{value:0},solid:{value:0},light:{value:isLight?1:0},
        energy:{value:info.emissionEnergy??(isLight?1:.035)},
        rimGain:{value:optical.rimGain??(isLight?0:1.5)},rimPower:{value:optical.rimPower??2.6},
        backfaceFactor:{value:optical.backfaceFactor??.08},rimAlpha:{value:optical.rimAlpha??.25},roughness:{value:info.roughness??.22},anatomy:{value:info.anatomy?1:0},routeProgress
      },
      transparent:true,depthWrite:false,side:THREE.DoubleSide,
      blending:isLight?THREE.AdditiveBlending:THREE.NormalBlending,toneMapped:false
    });
    result.forceSinglePass=true;
    result.defaultAttributeValues={...result.defaultAttributeValues,region:[-100],pathProgress:[0]};
    result.userData={optical:true,light:isLight,baseOpacity:isLight?.95:.32,source:info};
    return result;
  }
  const filamentVertex=`
    attribute float region;varying float R;uniform float pointSize;
    void main(){R=region;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(pointSize/max(.1,-p.z),1.,8.);}
  `;
  const filamentFragment=`
    uniform vec3 tint;uniform float gain;uniform float surface;uniform float selection;uniform float focus;uniform float energy;uniform float point;
    varying float R;
    void main(){if(point>.5&&length(gl_PointCoord-vec2(.5))>.5)discard;
      float selected=selection<0.?0.:1.-smoothstep(.25,.8,abs(R-selection));float emphasis=max(focus,selected);
      gl_FragColor=vec4(mix(tint,vec3(.72,.94,1.),emphasis*.9)*energy*gain*(1.+emphasis*.5),surface);}
  `;
  function brainLight(color,opacity,points=false){
    const m=new THREE.ShaderMaterial({vertexShader:filamentVertex,fragmentShader:filamentFragment,
      uniforms:{tint:{value:new THREE.Color(...color)},gain:{value:1},surface:{value:opacity},selection:{value:-1},focus:{value:0},energy:{value:points?2.4:1.6},point:{value:points?1:0},pointSize:{value:90}},
      transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false});
    m.defaultAttributeValues={...m.defaultAttributeValues,region:[-100]};m.userData={light:true,baseOpacity:opacity,brainLight:true};return m;
  }
  function brain(){
    const data=window.MTW_BRAIN_PREVIEW,g=new THREE.Group();g.name='Brain v5';
    const shellMaterial=material({name:'Selected v5 cortex',mode:'glass',anatomy:true,color:[.001,.009,.012],emissionColor:[.03,.32,.38],emissionEnergy:.008,coverage:1,optical:{rimGain:2.2,rimPower:7.0,backfaceFactor:.08}});
    shellMaterial.side=THREE.FrontSide;
    const shell=new THREE.Mesh(geometry(data.shell),shellMaterial);shell.name='Selected v5 cortex';shell.renderOrder=5;g.add(shell);
    const fibers=new THREE.LineSegments(geometry(data.fibers),brainLight([.035,.4,.5],.34));fibers.name='Selected v5 source fibers';fibers.visible=false;g.add(fibers);
    const nodes=new THREE.Points(geometry(data.nodes),brainLight([.3,.82,.9],.7,true));nodes.name='Selected v5 source nodes';nodes.visible=false;g.add(nodes);
    g.userData={asset:'brain',selectedBrainBuffer:true};return g;
  }
  function partObject(part,routeProgress,assetName=''){
    if(part.type!=='mesh')throw new Error('Version 3 requires actual mesh thickness: '+part.name);
    let info=part.material||part;
    if(/Readable dimensional product marks/.test(info.name||'')){
      const accent=/Claude/.test(assetName)?[.72,.39,.28]:/Codex|ChatGPT/.test(assetName)?[.46,.72,.65]:/Copilot/.test(assetName)?[.40,.56,.78]:null;
      if(accent)info={...info,color:accent,emissionColor:accent};
    }
    if(assetName==='SharePoint operator'&&/^SharePoint/.test(info.name||''))info={...info,color:[.055,.39,.43],emissionColor:[.13,.62,.66]};
    if(assetName==='Copilot reader'&&info.name==='Readable dimensional product marks')info={...info,mode:'glass',color:[.004,.05,.065],emissionColor:[.09,.70,.80],emissionEnergy:.035,coverage:.08,optical:{rimGain:3.8,rimPower:2.8,rimAlpha:.65,backfaceFactor:.10}};
    const m=material(info,routeProgress),o=new THREE.Mesh(geometry(part),m);
    o.name=part.name;o.userData.sourceObjects=part.sourceObjects||[];
    o.renderOrder=m.userData.light?2:1;return o;
  }
  function asset(name){
    if(name==='brain')return brain();
    const parts=window.MTW_ENTERPRISE.assets[name];if(!parts)throw new Error('Unknown hologram asset: '+name);
    const g=new THREE.Group();g.name=name;
    for(const part of parts){
      g.add(partObject(part,undefined,name));
      if(name==='Copilot reader'&&part.material?.name==='Readable dimensional product marks'){
        const edgeMaterial=brainLight([.24,.82,.92],.88);edgeMaterial.uniforms.energy.value=2.2;
        const edge=new THREE.LineSegments(new THREE.EdgesGeometry(geometry(part),28),edgeMaterial);edge.name='Preserved Copilot ribbon boundaries';g.add(edge);
      }
    }
    const shell=parts.find(p=>/pale substantial paper/.test(p.material?.name||''))||parts.filter(p=>p.material?.mode!=='light').sort((a,b)=>(b.indices?.length||0)-(a.indices?.length||0))[0];
    if(shell){const mask=new THREE.Mesh(geometry(shell),new THREE.MeshBasicMaterial({color:0x030b0e,transparent:true,opacity:.90,depthWrite:false,side:THREE.FrontSide,toneMapped:false}));mask.name='Foreground silhouette mask';mask.renderOrder=-1;mask.userData.occlusionMask=true;g.add(mask);}
    g.userData={asset:name,bounds:window.MTW_ENTERPRISE.assetBounds?.[name],excludeFromBounds:name==='Quiet spatial field'};return g;
  }
  let sharedPacketGeometry,packetTransform;
  const packetGeometry=()=>sharedPacketGeometry||(sharedPacketGeometry=new THREE.SphereGeometry(.026,12,8));
  function connection(record){
    if(!record)throw new Error('Unknown connection');
    const g=new THREE.Group(),routeProgress={value:1};g.name=record.id;
    for(const part of record.parts||[])g.add(partObject(part,routeProgress));
    const pts=record.points.map(p=>new THREE.Vector3(...p));
    const packetMaterial=new THREE.MeshBasicMaterial({color:new THREE.Color(.48,.90,1).multiplyScalar(4.5),transparent:true,opacity:.85,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false});
    packetMaterial.userData={light:true,baseOpacity:.85,baseColor:packetMaterial.color.clone(),sourceEnergy:4.5,currentGain:1,focus:0};
    const packets=new THREE.InstancedMesh(packetGeometry(),packetMaterial,record.arrow?1:3);packets.name='Route activity';packets.frustumCulled=false;g.add(packets);
    g.userData={record,points:pts,filaments:(record.filaments||[record.points]).map(f=>f.map(p=>new THREE.Vector3(...p))),packetMesh:packets,drawables:g.children.filter(o=>o!==packets),progress:1,routeProgress,bounds:record.bounds};
    animateRoute(g,0,false);return g;
  }
  function revealRoute(g,amount){
    const progress=Math.max(0,Math.min(1,Number.isFinite(amount)?amount:0));
    g.visible=progress>0;g.userData.progress=progress;g.userData.routeProgress.value=progress;
    // Every material batch clips the same normalized coordinate on every strand.
    // No draw range can accidentally reveal one entire strand before the next.
  }
  function animateRoute(g,time,motion=true){
    const d=g.userData;if(!d.packetMesh)return;
    d.packetMesh.visible=Boolean(g.visible&&motion&&d.progress>=.999);if(!d.packetMesh.visible)return;
    const n=d.points.length-1;if(n<1)return;
    if(!packetTransform)packetTransform=new THREE.Object3D();
    for(let j=0;j<d.packetMesh.count;j++){
      let t=((time*.20+j/d.packetMesh.count)%1+1)%1;if(d.record.reverse&&j%2)t=1-t;
      const strand=d.filaments[j%d.filaments.length], last=strand.length-1,q=t*last,i=Math.min(last-1,Math.floor(q));
      packetTransform.position.copy(strand[i]).lerp(strand[i+1],q-i);
      if(d.startDelta)packetTransform.position.addScaledVector(d.startDelta,1-t).addScaledVector(d.endDelta,t);
      packetTransform.scale.setScalar(t<=d.progress?(j===0?1:.68):0);packetTransform.updateMatrix();d.packetMesh.setMatrixAt(j,packetTransform.matrix);
    }
    d.packetMesh.instanceMatrix.needsUpdate=true;
  }
  function applyTransform(g,row){
    g.position.fromArray(row.position);g.userData.restPosition=g.position.clone();
    if(row.quaternion)g.quaternion.fromArray(row.quaternion);else g.rotation.y=row.rotation||0;
    const scale=row.scale3||[row.scale??1,row.scale??1,row.scale??1];
    g.scale.fromArray(scale);g.userData.baseScaleVector=new THREE.Vector3(...scale);g.userData.baseScale=row.scale??scale[0];
  }
  function enterprise(){
    const root=new THREE.Group(),objects=new Map(),routes=new Map(),data=window.MTW_ENTERPRISE;root.name='Enterprise scene';
    for(const row of data.brains){const g=brain();g.name=row.id;applyTransform(g,row);root.add(g);objects.set(row.id,g);}
    for(const row of data.instances){const g=asset(row.asset);g.name=row.id;applyTransform(g,row);root.add(g);objects.set(row.id,g);}
    for(const record of data.routes){const g=connection(record);root.add(g);routes.set(record.id,g);}
    if(data.labelGeometry?.length){const labels=new THREE.Group();labels.name='World labels';for(const part of data.labelGeometry){const o=partObject(part);o.position.fromArray(part.anchor);o.userData.label=part.label;labels.add(o);}root.add(labels);}
    root.userData={objects,routes,labels:data.labels,camera:data.camera,version:data.exportVersion};return root;
  }
  function setMaterial(root,opacity=.32,gain=1,profile='surface',region=-1){
    const coverage=profile==='solid'?1:Math.max(0,Math.min(1,opacity));
    root.traverse(o=>{
      for(const m of (Array.isArray(o.material)?o.material:[o.material])){
        if(!m)continue;
        if(m.uniforms?.surface){
          if(m.userData.light){m.uniforms.surface.value=m.userData.baseOpacity;}
          else{m.uniforms.surface.value=profile==='translucent'?coverage*.22:coverage;m.uniforms.solid.value=profile==='solid'?1:0;const opaque=coverage>=.999;if(m.depthWrite!==opaque){m.depthWrite=opaque;m.transparent=!opaque;m.needsUpdate=true;}}
          m.uniforms.gain.value=Math.max(0,gain);if(m.uniforms.selection)m.uniforms.selection.value=region;
        }else if(m.userData?.light&&m.userData.baseColor){m.userData.currentGain=Math.max(0,gain);updatePacketColor(m);}
      }
    });
  }
  function updatePacketColor(m){
    m.color.copy(m.userData.baseColor).lerp(new THREE.Color(.72,.94,1).multiplyScalar(m.userData.sourceEnergy||1),(m.userData.focus||0)*.9).multiplyScalar(m.userData.currentGain??1);
  }
  function focusObject(root,amount){
    root.traverse(o=>{for(const m of(Array.isArray(o.material)?o.material:[o.material])){
      if(m?.uniforms?.focus)m.uniforms.focus.value=amount;
      else if(m?.userData?.baseColor){m.userData.focus=amount;updatePacketColor(m);}
    }});
  }
  function highlight(world,ids=[]){
    const selected=new Set(ids instanceof Set?ids:Array.isArray(ids)?ids:[ids]);
    if(world.userData.objects){
      for(const[id,object]of world.userData.objects)focusObject(object,selected.has(id)?1:0);
      for(const[id,route]of world.userData.routes)focusObject(route,selected.has(id)||selected.has('route:'+id)?1:0);
    }else focusObject(world,selected.size&&(!selected.has(null))?1:0);
    world.userData.highlightedIds=[...selected];
  }
  function choices(){
    const knowledge={'knowledge-0':'Facts','knowledge-1':'Procedures','knowledge-2':'Rules','knowledge-3':'Workflow steps'};
    return[{id:'brain',name:'Brain v5'},{id:'enterprise',name:'Enterprise scene'},...Object.keys(window.MTW_ENTERPRISE.assets).map(name=>({id:name,name})),...window.MTW_ENTERPRISE.routes.map(r=>({id:'route:'+r.id,name:'Connection: '+(knowledge[r.id]||r.title)}))];
  }
  function create(id){if(id==='enterprise')return enterprise();if(id.startsWith('route:'))return connection(window.MTW_ENTERPRISE.routes.find(r=>r.id===id.slice(6)));return asset(id);}
  return{load,brain,asset,enterprise,create,choices,setMaterial,highlight,revealRoute,animateRoute,focusObject};
})();

"""Tight layered Enterprise hologram, authored from reusable source collections.

Versioned source only. Y is up; +Z is the default front. Existing assets survive.
"""
from pathlib import Path
import bpy, json, math, random, sys
from mathutils import Vector, Quaternion, Matrix

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'assets/blender/enterprise'
VERSION=sys.argv[sys.argv.index('--')+1] if '--' in sys.argv else 'v12'
DEST=OUT/f'enterprise-orbits-{VERSION}.blend'
if DEST.exists():raise FileExistsError(DEST)
bpy.ops.wm.read_factory_settings(use_empty=True)
s=bpy.context.scene
libraries=[
 (OUT/'modules/people-glass-v10c.blend',['Asset Person','Asset Person alternate','Asset Seated operator','Asset Claude reader','Asset ChatGPT reader','Asset Copilot reader','Asset Claude operator','Asset Codex operator']),
 (OUT/'modules/office-documents-v11b.blend',['Asset Word document','Asset Excel workbook','Asset PowerPoint presentation','Asset OneNote notebook','Asset Knowledge glass']),
 (OUT/'modules/agent-code-glass-v11b.blend',['Asset Claude agent code','Asset ChatGPT agent code','Asset Copilot agent code']),
 (OUT/'modules/cloud-mcp-v10.blend',['Asset Regional cloud','Asset Inference badge','Asset MCP gateway','Asset anthropic mark','Asset openai mark']),
 (OUT/'modules/environment-assets-v10.blend',['Asset Environment stack','Asset Wiki file']),
 (OUT/'enterprise-calibration-v4-review3.blend',['Asset bedrock mark','Asset foundry mark'])]
for source,names in libraries:
 if not source.is_file():raise FileNotFoundError(source)
 with bpy.data.libraries.load(str(source),link=False) as (available,loaded):
  missing=[n for n in names if n not in available.collections]
  if missing:raise RuntimeError(f'{source.name}: missing {missing}')
  loaded.collections=names+(['Asset Brain enterprise'] if source.name.startswith('enterprise-calibration') else [])
for c in bpy.data.collections:
 if c.name.startswith('Asset '):c.use_fake_user=True

objectStages={};routeStages={};labelStages={};semantic={};labels=[];routes=[]
def emit(name,color,energy):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
 nodes=m.node_tree.nodes;nodes.clear();e=nodes.new('ShaderNodeEmission');e.inputs['Color'].default_value=(*color,1);e.inputs['Strength'].default_value=energy
 out=nodes.new('ShaderNodeOutputMaterial');m.node_tree.links.new(e.outputs[0],out.inputs['Surface']);m['browser']='light'
 return m
def coll(name):
 c=bpy.data.collections.new(name);s.collection.children.link(c);return c
paths=coll('Animated connection paths');activity=coll('Animated connection activity');labelcol=coll('Scene labels')
def instance(id,asset,position,scale=1,yaw=0,tilt=0,stage=0):
 c=bpy.data.collections.get('Asset '+asset)
 if c is None or not len(c.all_objects):raise RuntimeError('Missing/empty reusable asset: '+asset)
 o=bpy.data.objects.new(id,None);s.collection.objects.link(o);o.instance_type='COLLECTION';o.instance_collection=c
 o.location=position;o.scale=(scale,)*3;o.rotation_mode='QUATERNION';o.rotation_quaternion=Quaternion((0,1,0),math.radians(yaw))@Quaternion((1,0,0),math.radians(tilt))
 o['semantic_id']=id;objectStages[id]=stage;semantic[id]=o;return o
def position(r,angle,y):
 a=math.radians(angle);return Vector((math.sin(a)*r*1.45,y,math.cos(a)*r))
def label(text,id,stage,offset=(0,.65,0)):
 labels.append((text,id,stage,offset));labelStages[text]=stage
def local_at(id,offset):return semantic[id].location+semantic[id].rotation_quaternion@Vector(offset)

import importlib.util
sp=importlib.util.spec_from_file_location('sharepoint_operator',ROOT/'tools/blender/sharepoint-operator-v10.py');spo=importlib.util.module_from_spec(sp);sp.loader.exec_module(spo);spo.build(ROOT)

# Five opaque anatomical subjects, with four domain brains around the enterprise.
domains=[('client','Client brain','Client Operator',-135,'Claude operator','Word document'),('project','Project brain','Project Operator',-45,'Codex operator','PowerPoint presentation'),('legal','Legal brain','Legal Operator',45,'SharePoint operator','Excel workbook'),('devops','DevOps brain','Developer Operator',135,'Claude operator','OneNote notebook')]
brain_rows=[('enterprise-brain','Enterprise brain',.90,0,0,4.05)]+[(key+'-brain',title,.47,2.60,angle,2.70) for key,title,owner,angle,app,doc in domains]
for id,title,scale,radius,angle,y in brain_rows:
 o=instance(id,'Brain enterprise',position(radius,angle,y),scale,stage=0 if radius==0 else 2)
 o.rotation_quaternion=Quaternion((1,0,0),-math.pi/2)
 o['surface_opacity']=1;o['material_gain']=1
 label(title,id,0 if radius==0 else 2,(0,1.42 if radius==0 else .77,0))
 for part in o.instance_collection.all_objects:
  for m in getattr(part.data,'materials',[]):
   if not m or 'shell' not in m.name.lower():continue
   m['coverage']=1;m['rim_gain']=.9;m['rim_power']=4.5
   for n in m.node_tree.nodes:
    if n.bl_idname=='ShaderNodeMixShader':
     for link in list(n.inputs[0].links):m.node_tree.links.remove(link)
     second=n.inputs[2].links[0].from_node if n.inputs[2].is_linked else None
     n.inputs[0].default_value=0 if second and second.bl_idname=='ShaderNodeBsdfTransparent' else 1
    if n.bl_idname=='ShaderNodeBsdfPrincipled':
     n.inputs['Base Color'].default_value=(.004,.042,.052,1);n.inputs['Transmission Weight'].default_value=0;n.inputs['Alpha'].default_value=1;n.inputs['Roughness'].default_value=.23

instance('mcp','MCP gateway',(0,-1.70,0),1.12,stage=3)
label('Scoped MCP','mcp',3,(0,1.04,0))
for i,name in enumerate(['Facts','Procedures','Rules','Workflow steps','Behaviors']):
 id='knowledge-'+str(i);instance(id,'Knowledge glass',position(1.90,-144+i*72,1.15),.85,stage=1);label(name,id,1,(0,.49,0))
for key,title,owner,angle,app,doc in domains:
 id='operator-'+key;instance(id,app,position(4.10,angle,-.40),1.05,stage=1)
 instance(id+'-person','Seated operator',local_at(id,(.82,-.22,.95)),.92,yaw=-12,stage=1)
 label(owner,id,1,(0,.88,0))
 instance('best-work-'+key,doc,position(5.75,angle,-.40),.52,stage=1)
 label('Your best work','best-work-'+key,1,(0,.58,0))
human_y=-2.5
human_groups=[('individual','Individuals',0,'ChatGPT reader',1),('executives','Executive management',90,'Copilot reader',3),('marketing','Marketing',180,'Claude reader',3),('sales','Sales',270,'Copilot reader',3),('devops','DevOps',315,'ChatGPT reader',3)]
for group,title,angle,app,count in human_groups:
 anchor='human-'+group;instance(anchor,app,position(5.0,angle,human_y),1.05,stage=3);label(title,anchor,3,(0,.88,0))
 for j in range(count):
  offset=(-.54+j*.43,-.22,.95)
  instance(anchor+'-person-'+str(j),'Person alternate' if j%2 else 'Person',local_at(anchor,offset),.75 if count>1 else .86,yaw=12,stage=3)
for key,title,angle,app in [('claude','Claude agent',45,'Claude agent code'),('chatgpt','ChatGPT agent',135,'ChatGPT agent code'),('copilot','Copilot agent',225,'Copilot agent code')]:
 id='agent-'+key;instance(id,app,position(5.0,angle,human_y),1.05,stage=3);label(title,id,3,(0,.88,0))
environments=[('development','Dev',-135),('test','Test',-45),('staging','Staging',45),('production','Prod',135)]
for i,(key,title,angle) in enumerate(environments):
 id=key+'-server';instance(id,'Environment stack',position(3.60,angle,-4.50),1.10,stage=6)
 instance(key+'-file','Wiki file',local_at(id,(.65,.03,.12)),.50,stage=6)
 instance(key+'-person','Person alternate' if i%2 else 'Person',local_at(id,(-.64,-.04,.08)),.62,stage=6)
 label(title,id,6,(0,.76,0))
providers=[('bedrock','AWS Bedrock',-90),('foundry','Azure Foundry',0),('anthropic','Anthropic',90),('openai','OpenAI',180)]
for key,title,angle in providers:
 id=key+'-cloud';instance(id,'Regional cloud',position(4.25,angle,5.75),.90,stage=7)
 instance(key+'-badge','Inference badge',local_at(id,(0,.02,.36)),.63,stage=7)
 instance(key+'-symbol',key+' mark',local_at(id,(0,.03,.56)),.75,stage=7)
 label(title,id,7,(0,.74,0))
# Dim guide filaments with stronger, sparse directional activity in the browser.
route_mats=[emit('V10 quiet route outer',(.016,.24,.29),.38),emit('V10 quiet route inner',(.025,.36,.43),.55)]
arrowmat=emit('V10 release direction',(.12,.63,.69),1.2)
def line(name,points,mat,radius=.0014):
 curve=bpy.data.curves.new(name,'CURVE');curve.dimensions='3D';curve.resolution_u=1;curve.bevel_depth=radius;curve.bevel_resolution=1
 spline=curve.splines.new('POLY');spline.points.add(len(points)-1)
 for p,v in zip(spline.points,points):p.co=(*v,1)
 o=bpy.data.objects.new(name,curve);paths.objects.link(o);curve.materials.append(mat);return o
def route(id,a,d,stage,bend=.15,count=3,bidir=False,points=None,arrow=False):
 a=Vector(a);d=Vector(d);rng=random.Random(id);delta=d-a;side=delta.cross(Vector((0,1,0)))
 if side.length<.01:side=Vector((1,0,0))
 side.normalize();strands=[]
 for j in range(count):
  values=[];spread=(j-(count-1)/2)*.025;phase=rng.uniform(0,math.pi*2)
  for n in range(81):
   t=n/80
   if points is None:
    b=a+delta*.30+side*bend;c=a+delta*.72+side*bend
    v=(1-t)**3*a+3*(1-t)**2*t*b+3*(1-t)*t*t*c+t**3*d
   else:v=Vector(points[n])
   v+=side*math.sin(math.pi*t)*(spread+.008*math.sin(t*math.pi*2+phase));values.append(v)
  ob=line(id+' filament '+str(j),values,route_mats[j%2],.0015 if j==count//2 else .0008);ob['route_id']=id
  strands.append([list(v) for v in values])
 if arrow:
  # Arrowhead sits just before the target's envelope; route itself reaches center.
  tip=Vector(strands[count//2][69]);tangent=(Vector(strands[count//2][70])-Vector(strands[count//2][67])).normalized()
  sideways=tangent.cross(Vector((0,1,0))).normalized();back=tip-tangent*.20
  ob=line(id+' arrowhead',[back+sideways*.11,tip,back-sideways*.11],arrowmat,.006);ob['route_id']=id;ob['route_arrow']=True
 start=next((key for key,ob in semantic.items() if (ob.location-a).length<.0001),'')
 end=next((key for key,ob in semantic.items() if (ob.location-d).length<.0001),'')
 routes.append(dict(id=id,title=id,reverse=bidir,points=strands[count//2],filaments=strands,arrow=arrow,startAnchor=start,endAnchor=end));routeStages[id]=stage

def loc(id):return semantic[id].location.copy()
for i,(key,*_) in enumerate(domains):
 route('input-'+key,loc('best-work-'+key),loc('operator-'+key),1,.12)
 route(key+'-distilled',loc('knowledge-'+str(i)),loc(key+'-brain'),2,.10)
 route(key+'-mcp',loc(key+'-brain'),loc('mcp'),3,.12)
for i in range(5):
 key=domains[i%4][0]
 route('distil-'+str(i),loc('operator-'+key),loc('knowledge-'+str(i)),1,.10)
 route('knowledge-'+str(i)+'-brain',loc('knowledge-'+str(i)),loc('enterprise-brain'),1,.10)
route('mcp-enterprise',loc('enterprise-brain'),loc('mcp'),3,0,count=5)
for group,*_ in human_groups:route('human-'+group+'-read',loc('mcp'),loc('human-'+group),3,.16)
for key in ['claude','chatgpt','copilot']:route('agent-'+key+'-read',loc('mcp'),loc('agent-'+key),3,.16)
for i,(key,title,angle) in enumerate(environments):
 nxt=environments[(i+1)%4];p=[position(3.60,angle+t/80*90,-4.50) for t in range(81)]
 route(key+'-to-'+nxt[0],loc(key+'-server'),loc(nxt[0]+'-server'),6,count=1,points=p,arrow=True)
for i,(key,title,angle) in enumerate(providers):
 route(key+'-mcp',loc(key+'-cloud'),loc('mcp'),7,.18)
 route(key+'-brain',loc(key+'-cloud'),loc('enterprise-brain'),7,.10)
 route(key+'-operator',loc(key+'-cloud'),loc('operator-'+domains[i][0]),7,.20,bidir=True)
labelmat=emit('V10 source labels',(.58,.82,.86),1.1)
for i,(text,id,stage,offset) in enumerate(labels):
 curve=bpy.data.curves.new('Label '+text,'FONT');curve.body=text;curve.size=.17;curve.align_x='CENTER';curve.resolution_u=2;curve.extrude=.0004
 o=bpy.data.objects.new('Label '+str(i)+' '+text,curve);labelcol.objects.link(o);curve.materials.append(labelmat)
 o.location=loc(id)+Vector(offset);o['anchor_object']=id;o['stage']=stage;o['label_offset']=list(offset)
 o.rotation_mode='QUATERNION';o.rotation_quaternion=Quaternion((1,0,0),-math.pi/4)

world=bpy.data.worlds.new('Quiet deep glass world');world.use_nodes=True;world.node_tree.nodes['Background'].inputs[0].default_value=(.001,.006,.008,1);world.node_tree.nodes['Background'].inputs[1].default_value=.10;s.world=world
for name,location,energy,color,size in [('Cool broad reflection',(-5,9,8),1000,(.50,.84,1),7),('White narrow rim',(4,5,-3),1100,(.86,.98,1),3),('Teal lower fill',(-3,-2,4),180,(.12,.60,.65),4)]:
 l=bpy.data.lights.new(name,'AREA');l.energy=energy;l.color=color;l.shape='DISK';l.size=size;o=bpy.data.objects.new(name,l);s.collection.objects.link(o);o.location=location;o.rotation_euler=(Vector((0,1,0))-o.location).to_track_quat('-Z','Y').to_euler()
# Preserve readable panel width/height while exposing the authored optical layers.
for id,o in semantic.items():
 if o.instance_collection and any(word in o.instance_collection.name for word in ['reader','agent code','operator','Knowledge glass']) and 'Seated' not in o.instance_collection.name:
  o.scale.z*=2.8
c=bpy.data.cameras.new('Layered orbital camera');cam=bpy.data.objects.new('Layered orbital camera',c);s.collection.objects.link(cam);s.camera=cam
cam.location=(5.8,5.4,22.8);target=Vector((0,1.1,0));back=(cam.location-target).normalized();right=Vector((0,1,0)).cross(back).normalized();up=back.cross(right);cam.rotation_mode='QUATERNION';cam.rotation_quaternion=Matrix((right,up,back)).transposed().to_quaternion();c.lens=47;c.sensor_width=36
s.render.engine='CYCLES';s.cycles.samples=12;s.cycles.use_denoising=True;s.render.resolution_x=1600;s.render.resolution_y=900;s.render.resolution_percentage=100
s.frame_start=1;s.frame_end=1;s.frame_set(1);s['Scope']='Enterprise demo only';s['AppearanceAccepted']=False;s['BrainCoverage']=1
bpy.context.view_layer.update()
focusStages={id:4 if id.startswith('human-') else 5 if id.startswith('agent-') else stage for id,stage in objectStages.items()}
orbitGroups=[]
for name,speed,ids in [
 ('environments',-.032,[id for id in semantic if any(id.startswith(k+'-') for k,_,_ in environments)]),
 ('readers',.032,[id for id in semantic if id.startswith(('human-','agent-'))]),
 ('owners',-.032,[id for id in semantic if id.startswith(('operator-','best-work-'))]),
 ('knowledge',.032,[id for id in semantic if id.startswith('knowledge-')]),
 ('domain-brains',-.032,[key+'-brain' for key,*_ in domains]),
 ('clouds',.032,[id for id in semantic if any(id.startswith(k+'-') for k,_,_ in providers)])]:orbitGroups.append({'id':name,'speed':speed,'ellipseX':1.45,'objects':ids})
layout={'source':DEST.name,'routes':routes,'objectStages':objectStages,'routeStages':routeStages,'labelStages':labelStages,'focusStages':focusStages,'orbitGroups':orbitGroups,'sceneFlow':{'owners':list(domains),'knowledgeBeforeOwners':True,'readersThenAgentsAtMcp':True,'bestWorkHighlighted':False},'constraints':{'domainBrains':4,'ownerOperators':4,'commonPanelScale':1.05,'environmentMcpSpokes':False,'mcpEndpoint':'center','brainFaces':'+Z','finalCameraRoll':0,'cloudBrainAngleOffset':45,'brainPyramid':True,'enterpriseY':4.05,'modularY':2.70,'smallInputScale':.52}}
(OUT/f'enterprise-orbits-{VERSION}-layout.json').write_text(json.dumps(layout,indent=2)+'\n',encoding='utf-8')
bpy.ops.wm.save_as_mainfile(filepath=str(DEST),compress=True);print('SAVED',DEST,flush=True)

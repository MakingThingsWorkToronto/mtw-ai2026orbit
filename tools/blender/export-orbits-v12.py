"""Export compact, reusable Blender assets and labels plus byte-preserved brain buffers.

Blender --background --threads 3 --python export-holograms-v3.py --
  --source enterprise-calibration-v3.blend --version v3 [--layout layout-v3.json]

Every curve is evaluated to a mesh: bevels, extrusion and modifiers survive.
Geometry is merged by material per module / semantic route. Existing outputs
are refused. The separately loaded, selected v5 brain buffer is never modified.
"""
from pathlib import Path
import argparse
import base64
import hashlib
import json
import math
import re
import sys
from collections import defaultdict

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.kdtree import KDTree

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


BINARY = bytearray()
def packed(values, dtype='<f4'):
    array=np.asarray(values,dtype=dtype)
    while len(BINARY)%4:BINARY.append(0)
    offset=len(BINARY);BINARY.extend(array.tobytes())
    return {'offset':offset,'length':array.size,'dtype':dtype}



def read_js(path):
    return json.loads(path.read_text(encoding='utf-8').split('=', 1)[1].rstrip(';\n '))


def bounds(values):
    a = np.asarray(values, dtype=np.float64).reshape((-1, 3))
    if not len(a):
        return None
    return {'min': a.min(axis=0).tolist(), 'max': a.max(axis=0).tolist()}


def value(socket, default=None):
    if socket is None:
        return default
    result = socket.default_value
    return float(result) if isinstance(result, (int, float)) else list(result)


def scalar(socket):
    """Evaluate constant shader arithmetic; retain optical dependencies separately."""
    if not socket.is_linked:
        result = value(socket)
        return result if isinstance(result, (int, float)) else None
    node = socket.links[0].from_node
    if node.bl_idname == 'ShaderNodeValue':
        return float(node.outputs[0].default_value)
    if node.bl_idname != 'ShaderNodeMath':
        return None
    operands = [scalar(s) for s in node.inputs[:3]]
    a, b, c = operands
    if a is None or b is None:
        return None
    functions = {'ADD': lambda: a+b, 'SUBTRACT': lambda: a-b,
                 'MULTIPLY': lambda: a*b, 'DIVIDE': lambda: a/b if b else 0,
                 'POWER': lambda: a**b, 'MAXIMUM': lambda: max(a, b),
                 'MINIMUM': lambda: min(a, b),
                 'MULTIPLY_ADD': lambda: a*b+c if c is not None else None}
    return functions[node.operation]() if node.operation in functions else None


def optical_expression(socket):
    """Compact source parameters for the view-dependent rim emission network."""
    result = {'base': scalar(socket), 'rimGain': 0.0, 'rimPower': 2.6}
    if not socket.is_linked:
        return result
    node = socket.links[0].from_node
    if node.bl_idname == 'ShaderNodeMath' and node.operation == 'MULTIPLY_ADD':
        result['base'] = scalar(node.inputs[2])
        result['rimGain'] = scalar(node.inputs[1])
    seen = set()
    def walk(n):
        if n in seen:
            return
        seen.add(n)
        if n.bl_idname == 'ShaderNodeMath' and n.operation == 'POWER':
            exponent = scalar(n.inputs[1])
            if exponent is not None:
                result['rimPower'] = exponent
        for s in n.inputs:
            for link in s.links:
                walk(link.from_node)
    walk(node)
    return result


def material_info(mat):
    if mat is None:
        return {'name': 'Unassigned', 'mode': 'surface', 'color': [.05, .45, .6],
                'emissionColor': [.05, .45, .6], 'emissionEnergy': 0,
                'coverage': 1, 'optical': {'base': 0, 'rimGain': 0, 'rimPower': 2.6}}
    info = {'name': mat.name, 'mode': mat.get('browser', 'surface'),
            'color': list(mat.diffuse_color)[:3], 'coverage': float(mat.get('coverage', mat.diffuse_color[3])),
            'emissionColor': list(mat.diffuse_color)[:3], 'emissionEnergy': 0.0,
            'optical': {'base': 0.0, 'rimGain': 0.0, 'rimPower': 2.6}}
    if not mat.use_nodes:
        return info
    nodes = list(mat.node_tree.nodes)
    emission = next((n for n in nodes if n.bl_idname == 'ShaderNodeEmission'), None)
    principled = next((n for n in nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled'), None)
    if emission:
        info['emissionColor'] = value(emission.inputs['Color'])[:3]
        info['emissionEnergy'] = scalar(emission.inputs['Strength'])
        info['optical'] = optical_expression(emission.inputs['Strength'])
        if 'browser' not in mat:
            info['mode'] = 'light'
    if principled:
        info['color'] = value(principled.inputs['Base Color'])[:3]
        info['emissionColor'] = value(principled.inputs['Emission Color'])[:3]
        info['emissionEnergy'] = scalar(principled.inputs['Emission Strength'])
        info['optical'] = optical_expression(principled.inputs['Emission Strength'])
        for key, socket in [('roughness', 'Roughness'), ('metallic', 'Metallic'),
                            ('transmission', 'Transmission Weight'), ('ior', 'IOR')]:
            info[key] = value(principled.inputs[socket])
    if info['emissionEnergy'] is None:
        # The runtime reconstructs this angular expression rather than replacing
        # dynamic rim emission with a clamped color or a zero-light surface.
        info['emissionEnergy'] = info['optical'].get('base') or 0.0
    info['optical']['backfaceFactor'] = .08 if any(n.bl_idname == 'ShaderNodeBsdfTransparent' for n in nodes) else 1
    if mat.name.startswith('V4 '):
        info['optical']['backfaceFactor']=.15
        info['optical']['rimAlpha']=.25
    elif mat.name.startswith('Infrastructure v4 '):
        info['optical']['backfaceFactor']=.24
        info['optical']['rimAlpha']=.24
    for key, prop in [('rimGain','rim_gain'),('rimPower','rim_power'),('rimAlpha','rim_alpha'),('backfaceFactor','backface_factor')]:
        if prop in mat:info['optical'][key]=float(mat[prop])
    if 'face_emission' in mat:info['emissionEnergy']=float(mat['face_emission'])
    info['sourceNodeTypes'] = sorted({n.bl_idname for n in nodes})
    return info


def spline_points(obj):
    result = []
    for spline in obj.data.splines:
        if spline.type == 'BEZIER':
            from mathutils.geometry import interpolate_bezier
            controls = list(spline.bezier_points)
            points = []
            pairs = list(zip(controls, controls[1:]))
            if spline.use_cyclic_u:
                pairs.append((controls[-1], controls[0]))
            for a, b in pairs:
                segment = interpolate_bezier(a.co, a.handle_right, b.handle_left, b.co, max(2, obj.data.resolution_u+1))
                points.extend(segment[:-1])
            if pairs:
                points.append(pairs[-1][1].co)
        else:
            points = [p.co.xyz for p in spline.points]
            if spline.use_cyclic_u and points:
                points.append(points[0])
        result.append([list(obj.matrix_world @ p) for p in points])
    return result


def path_parameter(points):
    pts = [Vector(p) for p in points]
    lengths = [0.0]
    for a, b in zip(pts, pts[1:]):
        lengths.append(lengths[-1] + (b-a).length)
    total = max(lengths[-1], 1e-9)
    tree = KDTree(len(pts))
    for i, p in enumerate(pts):
        tree.insert(p, i)
    tree.balance()
    def parameter(p):
        _, nearest, _ = tree.find(p)
        best = (float('inf'), 0.0)
        for i in range(max(0, nearest-2), min(len(pts)-1, nearest+2)):
            delta = pts[i+1]-pts[i]
            u = max(0.0, min(1.0, (p-pts[i]).dot(delta) / max(delta.length_squared, 1e-12)))
            distance = (p-(pts[i]+delta*u)).length_squared
            if distance < best[0]:
                best = (distance, (lengths[i]+delta.length*u)/total)
        return best[1]
    return parameter


def export_batches(objects, depsgraph, offset=None, route=False):
    batches = {}
    stats = {'objects': 0, 'curvesMeshed': 0, 'triangles': 0}
    for obj in sorted(objects, key=lambda o: o.name):
        if obj.type not in {'MESH', 'CURVE', 'SURFACE', 'FONT', 'META'}:
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        if mesh is None:
            continue
        try:
            mesh.calc_loop_triangles()
            if not len(mesh.loop_triangles):
                continue
            matrix = obj.matrix_world.copy()
            if offset is not None:
                matrix = Matrix.Translation(-offset) @ matrix
            normal_matrix = matrix.to_3x3().inverted_safe().transposed()
            positions = [matrix @ v.co for v in mesh.vertices]
            corner_normals = getattr(mesh, 'corner_normals', None)
            progress = None
            if route:
                points = spline_points(obj)
                if not points or len(points[0]) < 2:
                    raise RuntimeError('Route curve has no usable path: '+obj.name)
                parameter = path_parameter(points[0])
                progress = [parameter(p) for p in positions]
            local_maps = defaultdict(dict)
            for tri in mesh.loop_triangles:
                mat = mesh.materials[tri.material_index] if tri.material_index < len(mesh.materials) else None
                name = mat.name if mat else 'Unassigned'
                if name not in batches:
                    batches[name] = {'material': material_info(mat), 'positions': [], 'normals': [], 'indices': [], 'pathProgress': [], 'objects': []}
                batch = batches[name]
                if not batch['objects'] or batch['objects'][-1] != obj.name:
                    batch['objects'].append(obj.name)
                mapping = local_maps[name]
                triangle = []
                for vertex_index, loop_index in zip(tri.vertices, tri.loops):
                    normal = corner_normals[loop_index].vector if corner_normals and len(corner_normals) else (mesh.vertices[vertex_index].normal if mesh.polygons[tri.polygon_index].use_smooth else tri.normal)
                    transformed_normal = (normal_matrix @ normal).normalized()
                    key = (vertex_index, *(round(x, 7) for x in transformed_normal))
                    if key not in mapping:
                        mapping[key] = len(batch['positions'])
                        batch['positions'].append(list(positions[vertex_index]))
                        batch['normals'].append(list(transformed_normal))
                        if route:
                            batch['pathProgress'].append(progress[vertex_index])
                    triangle.append(mapping[key])
                if matrix.determinant() < 0:
                    triangle.reverse()
                batch['indices'].extend(triangle)
            stats['objects'] += 1
            stats['curvesMeshed'] += int(obj.type == 'CURVE')
            stats['triangles'] += len(mesh.loop_triangles)
        finally:
            evaluated.to_mesh_clear()
    parts, all_positions = [], []
    for name, b in batches.items():
        all_positions.extend(b['positions'])
        part = {'name': name, 'type': 'mesh', **b['material'], 'material': b['material'],
                'positions': packed(b['positions']), 'normals': packed(b['normals']),
                'indices': packed(b['indices'], '<u4'), 'bounds': bounds(b['positions']),
                'vertexCount': len(b['positions']), 'triangleCount': len(b['indices'])//3,
                'sourceObjects': b['objects']}
        if route:
            part['pathProgress'] = packed(b['pathProgress'])
        parts.append(part)
    return parts, bounds(all_positions), stats


def transform(obj):
    position, quaternion, scale = obj.matrix_world.decompose()
    return {'position': list(position), 'quaternion': [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
            'scale3': list(scale), 'scale': float(scale.x)}


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--layout')
    parser.add_argument('--output-dir', default=str(REPO/'assets/models'))
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    source = Path(args.source)
    if not source.is_absolute():
        source = HERE / source
    if not re.fullmatch(r'v[0-9]+[a-z]?(?:-[a-z0-9-]+)?', args.version):
        raise ValueError('Version must be explicit, for example v3 or v3-review-1')
    output_dir=Path(args.output_dir);output_dir.mkdir(parents=True,exist_ok=True)
    dest = output_dir / ('enterprise-orbits-'+args.version+'.json')
    inventory_path = output_dir / ('enterprise-orbits-'+args.version+'-export.json')
    for path in (dest, inventory_path):
        if path.exists():
            raise FileExistsError('Preserve existing output: '+str(path))
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    old = read_js(REPO/'assets/models/enterprise-calibration-v3.js')
    layout_path = Path(args.layout) if args.layout else source.with_name(source.stem+'-layout.json')
    if not layout_path.is_absolute():
        layout_path = HERE / layout_path
    layout = json.loads(layout_path.read_text(encoding='utf-8')) if layout_path.exists() else {}
    bpy.ops.wm.open_mainfile(filepath=str(source))
    scene = bpy.context.scene
    scene.frame_set(scene.frame_end)
    bpy.context.view_layer.update()
    placements = [o for o in scene.objects if o.instance_type == 'COLLECTION' and o.instance_collection and o.instance_collection.name.startswith('Asset ') and not o.get('exclude_export')]
    collections = [c for c in bpy.data.collections if c.name.startswith('Asset ') and not c.name.startswith('Asset Brain')]
    # Dependencies must be linked while evaluated_get is queried. Export their
    # geometry in collection coordinates, separate from each placed instance.
    temporary = []
    for collection in collections:
        if collection.name not in scene.collection.children:
            scene.collection.children.link(collection)
            temporary.append(collection)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    data = {'version': 4, 'exportVersion': args.version, 'source': source.name, 'source_sha256': digest,
            'source_brain_sha256': old.get('source_brain_sha256'), 'brainBuffer': 'brain-04-v5-browser-v1.js',
            'assets': {}, 'assetBounds': {}, 'brains': [], 'instances': [], 'routes': [], 'labels': [],
            'geometryContract': 'indexed material-batched meshes with evaluated curve bevels; world-unit route tubes with shared normalized pathProgress'}
    inventory = {'source': str(source), 'source_sha256': digest, 'export': str(dest),
                 'blender': bpy.app.version_string, 'assets': {}, 'routes': {}, 'browserRendered': False,
                 'limits': ['Blender node optics are represented by explicit browser shader parameters; not pixel-identical shader translation.', 'Selected v5 browser brain buffers are loaded separately and byte-preserved.', 'Exporter records geometry only; browser checks are saved separately.']}
    for collection in sorted(collections, key=lambda c: c.name):
        name = collection.name.removeprefix('Asset ')
        objects = [o for o in collection.all_objects if not (name == 'Quiet spatial field' and o.name.startswith('Distant connection'))]
        parts, box, stats = export_batches(objects, depsgraph, collection.instance_offset)
        data['assets'][name] = parts
        data['assetBounds'][name] = box
        inventory['assets'][name] = {**stats, 'batches': len(parts), 'bounds': box}
        print('EXPORTED_ASSET', name, stats, 'batches', len(parts), flush=True)
    brain_buffer_path = REPO/'assets/models/brain-04-v5-browser-v1.js'
    brain_buffer_digest = hashlib.sha256(brain_buffer_path.read_bytes()).hexdigest()
    brain_data = read_js(brain_buffer_path)
    brain_positions = np.frombuffer(base64.b64decode(brain_data['shell']['positions']), dtype='<f4').reshape((-1, 3))
    data['brainBounds'] = bounds(brain_positions)
    data['brainBuffers']={}
    for key in ['shell','fibers','nodes']:
        data['brainBuffers'][key]={}
        for attribute,encoded in brain_data[key].items():
            dtype='<u4' if attribute=='indices' else '<f4'
            data['brainBuffers'][key][attribute]=packed(np.frombuffer(base64.b64decode(encoded),dtype=dtype),dtype)

    data['brainBufferSha256'] = brain_buffer_digest
    for obj in sorted(placements, key=lambda o: o.name):
        asset = obj.instance_collection.name.removeprefix('Asset ')
        if asset.startswith('Brain'):
            identifier = obj.name.lower().replace(' ', '-')
            data['brains'].append({'id': obj.get('semantic_id', identifier), 'name': obj.name, 'surfaceOpacity':float(obj.get('surface_opacity',.9)), 'materialGain':float(obj.get('material_gain',1)), **transform(obj)})
        else:
            data['instances'].append({'id': obj.get('semantic_id', obj.name), 'asset': asset, **transform(obj)})
    route_metadata = {r['id'].replace('mcp-client', 'mcp-enterprise'): r for r in old['routes']}
    layout_routes = {r['id'].replace('mcp-client', 'mcp-enterprise'): r for r in layout.get('routes', [])}
    route_objects = defaultdict(list)
    paths = bpy.data.collections.get('Animated connection paths')
    if paths:
        for obj in paths.all_objects:
            if obj.type != 'CURVE':
                continue
            identifier = obj.get('route_id') or re.split(r' filament(?: |$)', obj.name, maxsplit=1)[0]
            identifier = identifier.replace('mcp-client', 'mcp-enterprise')
            route_objects[identifier].append(obj)
    for identifier, objects in sorted(route_objects.items()):
        prior = route_metadata.get(identifier, {})
        layout_route = layout_routes.get(identifier, {})
        filaments = [points for obj in sorted(objects, key=lambda o: o.name) if not obj.get('route_arrow') for points in spline_points(obj)]
        parts, box, stats = export_batches(objects, depsgraph, route=True)
        if layout_route.get('points'):
            centerline = layout_route['points']
        elif len({len(f) for f in filaments}) == 1:
            centerline = np.asarray(filaments).mean(axis=0).tolist()
        else:
            centerline = filaments[0]
        record = {'id': identifier, 'title': layout_route.get('title', prior.get('title', identifier)).replace('Client brain', 'Enterprise brain'),
                  'reverse': bool(layout_route.get('reverse', prior.get('reverse', False))), 'arrow':bool(layout_route.get('arrow',False)),
                  'startAnchor':layout_route.get('startAnchor',''),'endAnchor':layout_route.get('endAnchor',''),
                  'points': centerline, 'filaments': filaments, 'parts': parts, 'bounds': box,
                  'sourceCurves': [{'name': o.name, 'bevelDepth': o.data.bevel_depth, 'bevelResolution': o.data.bevel_resolution,
                                    'scale3': list(o.matrix_world.to_scale())} for o in objects]}
        data['routes'].append(record)
        inventory['routes'][identifier] = {**stats, 'batches': len(parts), 'filaments': len(filaments)}
    label_collection = bpy.data.collections.get('Scene labels')
    if label_collection:
        for obj in label_collection.all_objects:
            if obj.type == 'FONT':
                text = obj.data.body
                data['labels'].append({'id': text, 'text': text, 'anchor':obj.get('anchor_object',''), 'stage':int(obj.get('stage',0)), 'position': list(obj.matrix_world.translation), 'size': obj.data.size,
                                       'align': obj.data.align_x, 'quaternion': transform(obj)['quaternion']})
    if label_collection:
        data['labelGeometry']=[]
        label_triangles=0
        for ob in label_collection.all_objects:
            if ob.type!='FONT':continue
            # Local glyph geometry, with separate billboard anchor and semantic id.
            prior=ob.matrix_world.copy(); ob.matrix_world=Matrix.Identity(4)
            bpy.context.view_layer.update()
            parts,box,stats=export_batches([ob],bpy.context.evaluated_depsgraph_get())
            ob.matrix_world=prior
            for part in parts:part['label']=ob.data.body;part['anchor']=list(prior.translation)
            data['labelGeometry'].extend(parts);label_triangles+=stats['triangles']
        inventory['labelGeometry']={'triangles':label_triangles,'count':len(data['labels'])}

    camera = scene.camera
    position = camera.matrix_world.translation
    direction = camera.matrix_world.to_quaternion() @ Vector((0, 0, -1))
    target = position + direction * (-position.z/direction.z if abs(direction.z) > 1e-8 else 20)
    data['camera'] = {'lens_mm': camera.data.lens, 'sensor_width_mm': camera.data.sensor_width,
                      'render_width': scene.render.resolution_x, 'render_height': scene.render.resolution_y,
                      'position': list(position), 'target': list(target), 'quaternion': transform(camera)['quaternion'],
                      'up': list(camera.matrix_world.to_quaternion() @ Vector((0, 1, 0)))}
    for collection in temporary:
        scene.collection.children.unlink(collection)
    if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Source changed during export')
    if hashlib.sha256(brain_buffer_path.read_bytes()).hexdigest() != brain_buffer_digest:
        raise RuntimeError('Selected brain buffer changed during export')
    data['binary']=dest.with_suffix('.bin').name
    data['orbitLayout']=layout.get('orbitLayout',{})
    data['labelStages']=layout.get('labelStages',{})
    for key in ['focusStages','orbitGroups','sceneFlow']:data[key]=layout.get(key,{})
    data['objectStages']=layout.get('objectStages',{})
    data['routeStages']=layout.get('routeStages',{})
    data['constraints']=layout.get('constraints',{})
    payload=json.dumps(data,separators=(',',':'))+'\n'
    with dest.with_suffix('.bin').open('xb') as output:output.write(BINARY)

    # Exclusive writes guard even a concurrent attempt at the same version.
    with dest.open('x', encoding='utf-8') as output:
        output.write(payload)
    inventory.update({'bytes': dest.stat().st_size, 'binaryBytes':len(BINARY), 'totalBytes':dest.stat().st_size+len(BINARY), 'sourceUnchanged': True, 'brainBufferUnchanged': True,
                      'instances': len(data['instances']), 'brains': len(data['brains']), 'camera': data['camera']})
    with inventory_path.open('x', encoding='utf-8') as output:
        json.dump(inventory, output, indent=2)
        output.write('\n')
    print('EXPORT_COMPLETE', dest, flush=True)


if __name__ == '__main__':
    run()

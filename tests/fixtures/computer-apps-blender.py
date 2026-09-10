"""Independent state/event oracle for a newly spawned factory-startup Blender."""

import ctypes
import json
import os
import time
from pathlib import Path

import bpy
import gpu
from gpu_extras.batch import batch_for_shader


target = Path(os.environ['DSH_BLENDER_TEST_STATE'])
text_name = 'DSH Computer Fixture'
counts = {'left': 0, 'right': 0}
pointer_command = None
bpy.context.preferences.view.show_splash = False


class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]


cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
cg.CGEventCreate.argtypes = [ctypes.c_void_p]
cg.CGEventCreate.restype = ctypes.c_void_p
cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
cg.CGEventGetLocation.restype = CGPoint
cf.CFRelease.argtypes = [ctypes.c_void_p]


def physical_pointer():
    event = cg.CGEventCreate(None)
    if not event:
        raise RuntimeError('Could not read the physical cursor')
    try:
        point = cg.CGEventGetLocation(event)
        return {'x': point.x, 'y': point.y}
    finally:
        cf.CFRelease(event)


def targets(region):
    # Small, visible targets with an independent pixel geometry oracle.
    return {
        'left': (region.x + 24, region.y + 24, 64, 32),
        'right': (region.x + region.width - 88, region.y + 24, 64, 32),
    }


def draw_targets():
    region = bpy.context.region
    if not region or not bpy.context.space_data.text or bpy.context.space_data.text.name != text_name:
        return
    shader = gpu.shader.from_builtin('UNIFORM_COLOR')
    for name, (x, y, width, height) in targets(region).items():
        x -= region.x
        y -= region.y
        batch = batch_for_shader(shader, 'TRI_FAN', {'pos': [
            (x, y), (x + width, y), (x + width, y + height), (x, y + height),
        ]})
        shader.bind()
        shader.uniform_float('color', (0.1, 0.75, 0.3, 1) if counts[name] % 2 else (0.85, 0.3, 0.1, 1))
        batch.draw(shader)


class DSH_TEST_OT_events(bpy.types.Operator):
    bl_idname = 'wm.dsh_computer_test_events'
    bl_label = 'DSH Computer Test Events'

    def modal(self, context, event):
        if event.type not in {'TIMER', 'MOUSEMOVE', 'INBETWEEN_MOUSEMOVE'}:
            with target.with_name('blender-events.jsonl').open('a') as out:
                out.write(json.dumps({
                    'time': time.time(), 'type': event.type, 'value': event.value,
                    'unicode': event.unicode, 'shift': event.shift, 'ctrl': event.ctrl,
                    'alt': event.alt, 'oskey': event.oskey,
                    'mouse': [event.mouse_x, event.mouse_y],
                }, ensure_ascii=False) + '\n')
        if event.type == 'LEFTMOUSE' and event.value == 'PRESS':
            for area in context.window.screen.areas:
                if area.type != 'TEXT_EDITOR':
                    continue
                for region in area.regions:
                    if region.type != 'WINDOW':
                        continue
                    for name, (x, y, width, height) in targets(region).items():
                        if x <= event.mouse_x < x + width and y <= event.mouse_y < y + height:
                            counts[name] += 1
                            area.tag_redraw()
                            return {'RUNNING_MODAL'}
        return {'PASS_THROUGH'}

    def invoke(self, context, event):
        context.window_manager.modal_handler_add(self)
        return {'RUNNING_MODAL'}


def park_pointer(window):
    global pointer_command
    command_file = target.with_name('blender-pointer-command.json')
    if not command_file.exists():
        return
    command = json.loads(command_file.read_text(encoding='utf-8'))
    if pointer_command and pointer_command['id'] == command.get('id'):
        return
    pointer_command = {'id': command.get('id'), 'time': time.time()}
    try:
        if command.get('pid') != os.getpid() or command.get('action') != 'park_timeline':
            raise ValueError('Pointer setup only accepts this fixture process and park_timeline')
        area = next(area for area in window.screen.areas if area.type == 'DOPESHEET_EDITOR')
        region = next(region for region in area.regions if region.type == 'HEADER')
        x, y = int(region.x + region.width * 0.45), int(region.y + region.height * 0.5)
        pointer_command['physical_before'] = physical_pointer()
        window.cursor_warp(x, y)
        pointer_command['physical_after'] = physical_pointer()
        pointer_command['window_point'] = {'x': x, 'y': y}
    except Exception as error:
        pointer_command['error'] = str(error)


def snapshot():
    window = bpy.context.window_manager.windows[0]
    park_pointer(window)
    areas = []
    for area in window.screen.areas:
        regions = [{'type': region.type, 'x': region.x, 'y': region.y,
                    'width': region.width, 'height': region.height,
                    **({'targets': targets(region)} if area.type == 'TEXT_EDITOR' and region.type == 'WINDOW' else {})}
                   for region in area.regions]
        areas.append({'type': area.type, 'regions': regions})
    state = {
        'pid': os.getpid(), 'time': time.time(), 'window': {'width': window.width, 'height': window.height},
        'areas': areas, 'counts': counts, 'filepath': bpy.data.filepath, 'pointer_command': pointer_command,
        'objects': [obj.name for obj in bpy.data.objects],
        'texts': [{'name': text.name, 'content': text.as_string()} for text in bpy.data.texts],
    }
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
    temporary.replace(target)
    return 0.1


def prepare():
    # Fixture setup only. All tested text, keyboard and click operations come
    # from DSH's broker/driver; this observer never changes them afterwards.
    # The explicit pointer command only establishes a known physical cursor
    # position before the tested click, without changing text or selection.
    window = bpy.context.window_manager.windows[0]
    area = max(window.screen.areas, key=lambda item: item.width * item.height)
    area.type = 'TEXT_EDITOR'
    area.spaces.active.text = bpy.data.texts.new(text_name)
    area.spaces.active.show_line_numbers = True
    bpy.types.SpaceTextEditor.draw_handler_add(draw_targets, (), 'WINDOW', 'POST_PIXEL')
    bpy.utils.register_class(DSH_TEST_OT_events)
    bpy.ops.wm.dsh_computer_test_events('INVOKE_DEFAULT')
    bpy.app.timers.register(snapshot, first_interval=0.1)


bpy.app.timers.register(prepare, first_interval=0.5)

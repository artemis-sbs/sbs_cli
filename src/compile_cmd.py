import click
import json
import os

from cli_cmd import cli, zipapp_dir
from file_help import zipdir
from pathlib import Path

def sbs_lib_import(mission_dir, script_dir):
    import sys
    import os
    import json
    
    story_settings = os.path.join(script_dir,"story.json")
    lib_dir = os.path.join(mission_dir,"__lib__")
    with open(story_settings, 'r') as file:
        data = json.load(file)
        if data is None:
            raise Exception("Missing story.json needed to load libraries")
        sbslibs = data.get("sbslib", [])
        for file in sbslibs:
            f = os.path.join(lib_dir, file)
            if not os.path.isfile(f):
                raise Exception(f"Missing library: {f}")
            sys.path.insert(0, f) 


def compile_impl(folder, compile_only = True, is_sbs=True):
    missions = zipapp_dir
    
    try:
        data_path = os.path.join(missions, "..")
        exe_path = os.path.join(data_path, "..")
        py_addons = os.path.join(exe_path, "PyAddons")

        mission = os.path.join(missions, folder)
        story = os.path.join(mission, "story.mast")
        import sys
        
        sys.path.insert(0, py_addons) 
        sys.path.insert(0, mission) 
        if not is_sbs:        
            sbs_lib_import(missions, mission)

            from sbs_utils import fs
            fs.exe_dir = exe_path
            fs.script_dir = mission
            
            from sbs_utils.mast.mast_run import mast_run
            mast_run(story, compile_only)
            return

        
        import script
        from sbs_utils.mock import sbs
    
        import sbs_utils.mast_sbs.story_nodes

        ### is_sbs:
        if compile_only:
            import sbslibs
            from sbs_utils.mast.mast_run import mast_run
            mast_run(story, compile_only)
            return
        
        
        
        sim = sbs.create_new_sim()

        from sbs_utils.helpers import FrameContext, Context, FakeEvent
        from sbs_utils.agent import Agent
        from sbs_utils.handlerhooks import cosmos_event_handler

        Agent.SHARED.set_inventory_value("sim", sim)
        ctx = Context(sim, sbs, FakeEvent())
        #page = StoryPage()
        #FrameContext.page = page
        FrameContext.context = ctx
        
        event = FakeEvent(0, "mission_tick")

        import time
        while True:
            cosmos_event_handler(sim,event)
            sim._time_tick_counter += 1
            time.sleep(0.001)



    except Exception as e:
        print (e)



@cli.command(short_help="MAST Compile")
@click.argument("folder", default="LegendaryMissions")
@click.option('-t', '--terminal', is_flag=True)
@click.option('-r', '--run', is_flag=True)
def compile(folder, run, terminal):
    compile_impl(folder, not run, not terminal)
    

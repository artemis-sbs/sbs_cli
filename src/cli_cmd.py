import click
from pathlib import Path

zipapp_dir = Path(__file__).resolve().parent.parent
CONTEXT_SETTINGS = dict(help_option_names=['-h', '--help'])



@click.group(context_settings=CONTEXT_SETTINGS)
def cli():
    pass


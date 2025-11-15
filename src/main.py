import click 
from urllib.request import urlretrieve

@click.group()
def cli():
    pass

@cli.command()
@click.option('-u', '--user', default="artemis-sbs")
@click.option('-r', '--repo', default="LegendaryMissions")
@click.option('-b', '--branch', default="main")
def fetch(user, repo, branch):
    click.echo(f'Hello {user}!')
    url = f"https://github.com/{user}/{repo}/zipball/{branch}/"
    try:
        urlretrieve(url, "rel.zip")
    except Exception as e:
        print(f"BAD URL: {url}")



# if __name__ == '__main__':
#     greet(auto_envvar_prefix='GREETER')
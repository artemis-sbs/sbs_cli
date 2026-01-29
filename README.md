# NOTE: This is a beta release

This has the functionality desired for the first release. It needs testing and cleanup.

New Feature Ideas
- add support for a -latest to allow for better handling of hot fixes
e.g. v1.3.0 ships library and missions can have v.1.3.0-fix1, v.1.3.0-fix2, v.1.3.0-fix3 v.1.3.0-latest should point to v1.3.0-fix3
When generating it should add -latest if it is not on the version. story.json should point to -latest in the future.
A version file should be placed into library/addons
sbs tool could grab the actual version out of latest




Commands:

- fetch - retrieve missions from github
- run - run multiple copies of Artemis Cosmos
- version - tells the version of the tool
- update - updates the tool to the latest released version
- lib - this will build any sbslib, mastlib zip, etc. specified in a `__lib__.json` file
- watch - this will watch for changes in a mission and automatically rebuild libraries and addons
- release - Used by development, it triggers the update or creation of a release on github
- production - This will fetch all the missions that ship with Artemis Cosmos
- compile - Compile the MAST 

## Running

The code will create a file sbs.pyz. This file is a python zip app, that can be run from the command line. The file will be placed in the missions directory. Also use the sbs.bat file to bootstrap the zip app. The batch file will use the version of python that ships with Artemis Cosmos.

- type `sbs --help` 
- type `sbs.pyz --help` If you have python install and in your path you can run the pyz directly


## Fetch 

This is a re-write of the fetch command for Artemis Cosmos using python for more control. The old system used batch files and was very limited in features.

- type `sbs fetch --help` for help with fetch

Usage: sbs.pyz fetch [OPTIONS] [REPO]

  Fetch command

Options:

```
   -u, --user TEXT       Specify The github user/organization.  [default: >rtemis-sbs]
  -b, --branch TEXT     Specify The github branch/tag.  [default: main]
  -f, --folder TEXT     Specify the local folder for mission. Defaults to >he same as the repository name.
  -o, --overwrite_libs  Force getting libraries from github if they exist  >ocal i.e. overwrite the local copy.
  -sl, --skip_libs      This will skip the building of libraries/addons.
  -sc, --skip_clean     This will skip the clearing the target folder.
  -q, --quiet           Suppress the confirm for cleaning directories.
```

- type `sbs fetch SecretMeeting` to fetch the Secret Meeting mission
- type `sbs fetch SomeMission --user a_github_user` to fetch the a mission from a user other tan artemis-sbs

### Fetch and downloading dependencies

Fetch will automatically download dependent libs from github if they do not exist local. sbslib files are always downloaded. mastlib and zip will not be downloaded 

To force the download of dependencies (mastlib and zip)

- type `sbs fetch SecretMeeting -o` to fetch the Secret Meeting mission and redownload dependencies
- type `sbs fetch SecretMeeting --overwrite_libs` to fetch the Secret Meeting mission and redownload dependencies

### Fetch building addons etc.

Fetch will automatically build the libraries and addons specified in the `__lib__.json` file in the mission

To skip building addons (mastlib and zip). This seems like it is not something that will be used much.

- type `sbs fetch LegendaryMissions -sl` to fetch the Secret Meeting mission and not build addons
- type `sbs fetch LegendaryMissions -sl` to fetch the Secret Meeting mission and not build addons

## run

The run command is useful to run multiple copies of Artemis Cosmos for whatever reason.

Usage: sbs run [OPTIONS] [CONSOLES]

- type `sbs run helm,comms` to run two copies of cosmos one as helm and the other as comms
- type `sbs run server,helm,comms` 
- type `sbs run` to run six copies of cosmos. This is used by development in testing.


## update

The sbs tool is capable of updating itself to the latest version.

- type `sbs update` to update the sbs.pyz and sbs.bat to the latest on github

Since this updates the running files, this occasionally fail.


## lib 

This will build any sbslib, mastlib zip, etc. specified in a `__lib__.json` file

Usage: sbs lib [OPTIONS] [FOLDER]

Options:

```
  -u, --user TEXT  Specify The github user/organization.  [default: artemis-sbs]
```

- type `sbs watch LegendaryMissions` to build 
- type `sbs watch LegendaryMissions -u my_user` to build specifying a user other than artemis-sbs
- type `sbs watch sbs_utils,LegendaryMissions` to build multiple folders
- type `sbs watch sbs_utils,my_user:LegendaryMissions` to build multiple folders with mixed users ids


## watch 

This will watch for any changes in a folder and build any addons or libraries when changes occur.


```
Usage: sbs watch \[OPTIONS] FOLDER

  Watch Watch for changes in things in __lib__.json and build libs on change

Options:
  -i, --interval INTEGER
```

You can specify multiple folders. If your have your own fork or addon and need to specify the the user.
The folder option can take the user:
The folder argument an also be a list of these

- type `sbs watch LegendaryMissions` to watch and build 
- type `sbs watch my_user:LegendaryMissions` to watch and build specifying a user other than artemis-sbs
- type `sbs watch sbs_utils,LegendaryMissions` to watch and build multiple folders
- type `sbs watch LegendaryMissions --interval 2` to set the interval the default is 5 seconds


## release
Used by development, it triggers the update or creation of a release on github

This will add or remove tags on github. This will trigger a github action to create a new release

The version is determined by the value in version.py unless specified with --version

This can only be used by maintainer of the github repository

```
Options:
  -v, --version TEXT
  -u, --unrelease
```

- type `sbs release [FOLDER] [MESSAGE]` to create a new release
- type `sbs release [FOLDER]--unrelease [MESSAGE]` to create a update release
- type `sbs release [FOLDER] -u [MESSAGE]` to create a update release
- type `sbs release [FOLDER] -u [MESSAGE] --version 1.1` to create specific version update release


## production 

This will fetch all the missions that ship with Artemis Cosmos
This command will fetch the missions that ship with artemis cosmos.
The existing missions folders will be removed and fresh copies will be retrieved.

```
Options:
  -b, --branch TEXT  Specify The github branch/tag.  [default: main]
  -q, --quiet        Suppress the confirm for cleaning directories.
```  

## Compile
This will compile the MAST project and output errors.
This can be done on a Artemis Cosmos project by default additionally it can compile a MAST project that is just core nodes (for commandline terminal)

It can also run the project Artemis Cosmos is not used, but a small subset of the sbs API is supported, just to general test mission startup.


Usage: sbs compile [OPTIONS] [FOLDER]

Options:
  -t, --terminal
  -r, --run
  -h, --help      Show this message and exit.



## Developer tool

The github repository for this tool has tools to help with developing the sbs tool.

Commands:
-  build
-  install
-  release
-  version

## help

- type `dev.pyz --help` for help

## install

The install command will call pip install for working with the tool and gathering the tools dependencies
```
Options:
  -d, --dev
```

- type `dev.pyz install --dev` to install the needed libraries for development
- type `dev.pyz install` to install the needed libraries for the app
- type `dev.pyz install --dev` to install the needed libraries for development

### build

```
Options:
  -i, --install
```

- type `dev.pyz build` to build sbs.pyz the app
- type `dev.pyz build --install` to do an install then build sbs.pyz the app

### release

This will add or remove tags on github. This will trigger a github action to create a new release

The version is determined by the value in version.py unless specified with --version

```
Options:
  -v, --version TEXT
  -u, --unrelease
```

- type `dev.pyz release [MESSAGE]` to create a new release
- type `dev.pyz release --unrelease [MESSAGE]` to create a update release
- type `dev.pyz release -u [MESSAGE]` to create a update release
- type `dev.pyz release -u [MESSAGE] --version 1.1` to create specific version update release

### version 
Will display the version. The value is in version.py
This version is what the release command uses by default

- type `dev.pyz version` to see the version that the tool is for





## Scenarios

> I am an operator who likes to be on the edge and always wants to have the latest. How do I update?

`sbs fetch LegendaryMissions,SecretMeeting,WalkTheLine`

> I am messed around with LegendaryMissions script, but now I just want the version that shipped with my version of Artemis Cosmos. I use v1.3.0

`sbs fetch LegendaryMissions --version v1.3.0`

> But what if it has some bug fixes?

`sbs fetch LegendaryMissions --version v1.3.0-latest`

NOTE: Some older version may not have the -latest version. It is a new concept not yet tried.


> I'm the guy creating the install for ArtemisCosmos, what do I do

Well you can delete or move everything out of missions except sbs.bat and sbs.pyz and then type. (Also, if you change dmx,py put update here https://github.com/artemis-sbs/sbs_common)

It is good idea to update sbs, then run production.

`sbs update`
`sbs production -q`


> I'm someone who wants to run a mainscreen and a station

`sbs run mainscreen,helm`

> I'm the kind of person that works on my own scripts, but changes Legendary Missions and use its addons and I want to stay up to date while I do that

get the latest, and then start a watcher to rebuild add on when anything changes

You should git clone LegendaryMissions

`sbs watch LegendaryMissions`

> But I also change sbs_utils

You should git clone LegendaryMissions and sbs_utils

sbs watch LegendaryMissions,sbs_utils

> But I but I have my own fork (user named western_back) and even use that in story.json

You should git clone LegendaryMissions and sbs_utils

`sbs watch western_back:LegendaryMissions,western_back:sbs_utils`

This will build libraries with that user name.


> I'm someone who wants to burnin test cosmos using autoplay

set up the mission settings.yaml for autoplay and auto start

`sbs run`

Start the server and the clients, let it run forever





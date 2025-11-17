# NOTE: This is a work in progress not fully functional

Current functionality fetch does work and will install all dependencies from story.json
So it CAN replace the existing fetch batch files.

## Fetch for Artemis Cosmos

This is a re-write of the fetch command for Artemis Cosmos using python for more control

### Running

The result of this will create a file sbs.pyz. This file is a python zip app, that can be run from the command line. The file will be placed in the missions directory. Also user the sbs.bat file to bootstrap the zip app.

> [!NOTE]
> If you do not have the sbs.bat file you can created with the following code. place it in the missions folder.
> ``` batch
> @echo off
> ..\..\PythonRuntime\python sbs.pyz %*
> ```



- type `sbs --help` for help
- type `sbs fetch --help` for help with fetch

- type `sbs fetch SecretMeeting` to fetch the Secret Meeting mission
- type `sbs fetch SomeMission --user a_github_user` to fetch the a mission from a user other tan artemis-sbs

### Fetch and downloading dependencies

Fetch will automatically download dependent libs from github if they do not exist local. sbslib files are always downloaded. mastlib and zip will not be downloaded 

To force the download of dependencies (mastlib and zip)

- type `sbs fetch SecretMeeting -o` to fetch the Secret Meeting mission and redownload dependencies
- type `sbs fetch SecretMeeting --overwrite_libs` to fetch the Secret Meeting mission and redownload dependencies

### Fetch building addons etc.

Fetch will automatically build the libraries and addons specified in the \__lib__.json file in the mission

To skip building addons (mastlib and zip). This seems like it is not something that will be used much.

- type `sbs fetch LegendaryMissions -sl` to fetch the Secret Meeting mission and not build addons
- type `sbs fetch LegendaryMissions -sl` to fetch the Secret Meeting mission and not build addons


## Updating
The sbs tool is capable of updating itself to the latest version.

- type `sbs update` to update the sbs.pyz and sbs.bat to the latest on github

Since this updates the running files, this occasionally fail.

## Developer

To use development mode

## retrieve the repository

- type `dev.pyz --help` for help
- type `dev.pyz install --dev` to install the needed libraries for development
- type `dev.pyz install` to install the needed libraries for the app
- type `dev.pyz install --dev` to install the needed libraries for development
- type `dev.pyz build` to build sbs.pyz the app
- type `dev.pyz build --install` to do an install then build sbs.pyz the app

### To build releases on github
- type `dev.pyz build [MESSAGE]` to create a new release
- type `dev.pyz build --unrelease [MESSAGE]` to create a update release
- type `dev.pyz build -u [MESSAGE]` to create a update release
- type `dev.pyz build -u [MESSAGE]` --version 1.1 to create specific version update release











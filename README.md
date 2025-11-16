# NOTE: This is a work in progress not fully functional

Current functionality fetch does work and will install all dependencies from story.json
So it CAN replace the existing fetch batch files.

# Fetch for Artemis Cosmos

This is a re-write of the fetch command for Artemis Cosmos using python for more control

## Running

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


## Developer

To use development mode

- retrieve the repository
- type `dev.pyz --help` for help
- type `dev.pyz install --dev` to install the needed libraries for development
- type `dev.pyz install` to install the needed libraries for the app
- type `dev.pyz install --dev` to install the needed libraries for development
- type `dev.pyz build` to build sbs.pyz the app
- type `dev.pyz build --install` to do an install then build sbs.pyz the app











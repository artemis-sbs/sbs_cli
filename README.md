# NOTE: This is a work in progress noy fully functional


# Fetch for Artemis Cosmos

This is a re-write of the fetch command for Artemis Cosmos using python for more control

## Running

The result of this will crete a file sbs_cli.pyz. This file is a python zip app, that can be run from the command line. The file will be placed in the missions directory.

- type `sbs_cli.pyz --help` for help
- type `sbs_cli.pyz fetch --help` for help with fetch

## Running using python in directory for cosmos
If python is installed on the machine windows should recognize .pyz file as python and run them.

Without python installed you can use the sbs_cli.bat file to run using the python in Artemis Cosmos.

``` batch
..\..\PythonRuntime\python sbs_cli.pyz %*
```

## Developer

To use development mode

- retrieve the repository
- type `dev.pyz --help` for help
- type `dev.pyz install --dev` to install the needed libraries for development
- type `dev.pyz install` to install the needed libraries for the app
- type `dev.pyz install --dev` to install the needed libraries for development
- type `dev.pyz build` to build sbs_cli.pyz the app











@echo off
goto run                       
exit /b %errorlevel%
:run
"%~dp0..\..\PyRuntime\python" "%~dp0sbs.pyz" %*

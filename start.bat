@echo off
setlocal
cd /d "%~dp0"
title Rextro Port Client

rem Use Node from PATH if present, otherwise a portable copy that is downloaded once into runtime\node.
set "NODE_VER=22.12.0"
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "NODE=%~dp0runtime\node\node.exe"
  if not exist "%~dp0runtime\node\node.exe" (
    echo Node.js not found, downloading portable copy ^(about 30 MB, one time only^)...
    if not exist runtime mkdir runtime
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest 'https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip' -OutFile 'runtime\node.zip'; Expand-Archive 'runtime\node.zip' -DestinationPath runtime -Force; Move-Item 'runtime\node-v%NODE_VER%-win-x64' 'runtime\node' -Force; Remove-Item 'runtime\node.zip'"
    if not exist "%~dp0runtime\node\node.exe" (
      echo Download failed. Check your internet connection or install Node.js from https://nodejs.org
      pause
      exit /b 1
    )
  )
)

rem Find a free port starting at 3917.
if "%PORT%"=="" set PORT=3917
:findport
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  set /a PORT+=1
  goto findport
)

echo Rextro Port Client: http://localhost:%PORT%
start "" "http://localhost:%PORT%"
"%NODE%" server.js
pause

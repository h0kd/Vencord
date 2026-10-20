@echo off
setlocal EnableExtensions
title Vencord h0kd - Instalador

rem Instala Vencord (build de h0kd/Vencord, con el plugin SevenTVEmotes) en Discord.
rem Uso:  Instalar.bat            -> detecta Discord automaticamente (stable, luego canary, luego ptb)
rem       Instalar.bat canary     -> instala en Discord Canary (tambien: stable, ptb)

set "REPO=h0kd/Vencord"
set "BASE_URL=https://github.com/%REPO%/releases/latest/download"
set "INSTALLER_URL=https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe"
set "VENCORD_USER_DATA_DIR=%APPDATA%\Vencord"
set "DIST=%VENCORD_USER_DATA_DIR%\dist"
set "TMPDIR=%TEMP%\vencord-h0kd"
set "BRANCH=%~1"
if "%BRANCH%"=="" set "BRANCH=auto"

rem Con esta variable el instalador oficial NO descarga el Vencord oficial:
rem usa los archivos que dejamos en %DIST%.
set "VENCORD_DEV_INSTALL=1"

echo.
echo  ==========================================
echo   Vencord h0kd  (con emotes de 7TV)
echo  ==========================================
echo.
echo  Repo:     https://github.com/%REPO%
echo  Archivos: %DIST%
echo  Discord:  %BRANCH%
echo.
echo  Discord se va a cerrar durante la instalacion.
echo.

where curl.exe >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] No se encontro curl.exe. Necesitas Windows 10 1803 o superior.
    goto :fail
)

if not exist "%DIST%" mkdir "%DIST%"
if not exist "%DIST%" goto :fail
if not exist "%TMPDIR%" mkdir "%TMPDIR%"
if not exist "%TMPDIR%" goto :fail

for %%F in (patcher.js preload.js renderer.js renderer.css) do (
    echo  Descargando %%F ...
    curl.exe -fsSL --retry 3 -o "%DIST%\%%F" "%BASE_URL%/%%F"
    if errorlevel 1 (
        echo  [ERROR] No se pudo descargar %%F
        goto :fail
    )
)
rem Evita que Node busque un package.json en carpetas superiores
> "%DIST%\package.json" echo {}

echo  Descargando el instalador oficial de Vencord ...
curl.exe -fsSL --retry 3 -o "%TMPDIR%\VencordInstallerCli.exe" "%INSTALLER_URL%"
if errorlevel 1 (
    echo  [ERROR] No se pudo descargar VencordInstallerCli.exe
    goto :fail
)

echo.
echo  Parcheando Discord ...
"%TMPDIR%\VencordInstallerCli.exe" -install -branch %BRANCH%
if errorlevel 1 goto :fail

echo.
echo  ==========================================
echo   Listo. Abre Discord: los emotes de 7TV
echo   ya deberian verse. Las actualizaciones
echo   se instalan solas desde %REPO%.
echo  ==========================================
echo.
pause
exit /b 0

:fail
echo.
echo  La instalacion fallo. Revisa los mensajes de arriba.
echo.
pause
exit /b 1

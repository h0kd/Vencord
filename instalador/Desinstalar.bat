@echo off
setlocal EnableExtensions
title Vencord h0kd - Desinstalador

rem Quita Vencord de Discord.
rem Uso:  Desinstalar.bat            -> detecta Discord automaticamente
rem       Desinstalar.bat canary     -> Discord Canary (tambien: stable, ptb)

set "INSTALLER_URL=https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe"
set "VENCORD_USER_DATA_DIR=%APPDATA%\Vencord"
set "TMPDIR=%TEMP%\vencord-h0kd"
set "BRANCH=%~1"
if "%BRANCH%"=="" set "BRANCH=auto"
set "VENCORD_DEV_INSTALL=1"

echo.
echo  ==========================================
echo   Vencord h0kd - Desinstalar
echo  ==========================================
echo.
echo  Discord se va a cerrar durante el proceso.
echo.

where curl.exe >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] No se encontro curl.exe.
    goto :fail
)
if not exist "%TMPDIR%" mkdir "%TMPDIR%"
if not exist "%TMPDIR%" goto :fail

echo  Descargando el instalador oficial de Vencord ...
curl.exe -fsSL --retry 3 -o "%TMPDIR%\VencordInstallerCli.exe" "%INSTALLER_URL%"
if errorlevel 1 (
    echo  [ERROR] No se pudo descargar VencordInstallerCli.exe
    goto :fail
)

echo.
echo  Quitando Vencord de Discord ...
"%TMPDIR%\VencordInstallerCli.exe" -uninstall -branch %BRANCH%
if errorlevel 1 goto :fail

echo.
echo  Listo. Vencord fue desinstalado. Tus ajustes quedan en:
echo  %VENCORD_USER_DATA_DIR%
echo  (borra esa carpeta si quieres eliminarlos)
echo.
pause
exit /b 0

:fail
echo.
echo  La desinstalacion fallo. Revisa los mensajes de arriba.
echo.
pause
exit /b 1

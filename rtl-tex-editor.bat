@echo off
rem =========================================================================
rem  RTL TeX Editor launcher  (Windows)
rem
rem    rtl-tex-editor.bat [folder] [port]
rem
rem      folder   workspace root to open (default: parent folder of this file)
rem      port     HTTP port (default 5199; or set RWE_PORT)
rem
rem    env:  RWE_PORT    RWE_ENGINE  (xelatex | pdflatex | lualatex)
rem    tip:  drag a folder onto this .bat to open the editor rooted there
rem =========================================================================
setlocal EnableExtensions

set "HERE=%~dp0"
set "ROOT=%~1"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=%RWE_PORT%"
if "%PORT%"=="" set "PORT=5199"
if "%RWE_ENGINE%"=="" set "RWE_ENGINE=xelatex"

if /I "%ROOT%"=="/?"     goto usage
if /I "%ROOT%"=="-h"     goto usage
if /I "%ROOT%"=="--help" goto usage

if "%ROOT%"=="" set "ROOT=%HERE%.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

if not exist "%ROOT%\" (
  echo [rtl-tex-editor] folder not found:  "%ROOT%"
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul || (
  echo [rtl-tex-editor] Node.js 18+ was not found on PATH.
  echo.
  pause
  exit /b 1
)

set "URL=http://127.0.0.1:%PORT%/"
echo [rtl-tex-editor] root : %ROOT%
echo [rtl-tex-editor] url  : %URL%
echo [rtl-tex-editor] starting server window^; close it or press Ctrl+C to stop.

start "RTL TeX Editor  (port %PORT%)" cmd /k node "%HERE%server.js" --root "%ROOT%" --port %PORT% --engine %RWE_ENGINE%
timeout /t 2 /nobreak >nul
start "" "%URL%"

endlocal
exit /b 0

:usage
echo.
echo   rtl-tex-editor.bat [folder] [port]
echo.
echo     folder   workspace root (default: parent folder of this script)
echo     port     HTTP port (default 5199; or set RWE_PORT)
echo.
echo   env:  RWE_PORT   RWE_ENGINE (xelatex ^| pdflatex ^| lualatex)
echo   tip:  drag a folder onto this file to open the editor there
echo.
pause
exit /b 0

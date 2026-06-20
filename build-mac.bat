@echo off
setlocal EnableDelayedExpansion

REM ===================================================================
REM  build-mac.bat — cross-build a macOS distributable from Windows.
REM
REM  Output: dist\AMMViewer-mac-<arch>.tar.gz
REM    Contains: AMMViewer.app/ (full bundle with launcher and helper
REM              binaries / .dylibs at mode 0755)
REM
REM  Pipeline:
REM    1. Bundle the renderer (esbuild).
REM    2. @electron/packager assembles the .app bundle. We use
REM       @electron/packager instead of electron-builder because
REM       electron-builder 25.x refuses to build for macOS from
REM       non-macOS hosts. @electron/packager has no such restriction.
REM    3. pack-app-bundle.js walks the .app, sniffs Mach-O magic on
REM       every file, and writes the tar.gz with 0755 on every binary.
REM
REM  After download, the user must bypass Gatekeeper on first launch
REM  since the build is unsigned (right-click -> Open, or
REM  `xattr -dr com.apple.quarantine AMMViewer.app`).
REM
REM  Defaults to x64. Pass arm64 for an Apple Silicon native build:
REM    build-mac.bat arm64
REM ===================================================================

set "ARCH=%~1"
if "%ARCH%"=="" set "ARCH=x64"
if not "%ARCH%"=="x64" if not "%ARCH%"=="arm64" (
    echo Unknown arch: %ARCH%   ^(use x64 or arm64^)
    set ERRORLEVEL=1
    goto :end
)

echo ============================================================
echo  Building AMMViewer for macOS-%ARCH% (cross-build from Windows)
echo ============================================================
echo.

cd /d "%~dp0"

echo [1/3] Bundling renderer...
call node build.js
if errorlevel 1 (
    echo Renderer build FAILED.
    goto :end
)

echo [2/3] Assembling .app with @electron/packager...
call node build-mac-app.js --arch %ARCH%
if errorlevel 1 (
    echo .app assembly FAILED.
    goto :end
)

echo [3/3] Packing .app into tar.gz with exec bits...
set "APPDIR=dist\AMMViewer-darwin-%ARCH%\AMMViewer.app"
if not exist "%APPDIR%" (
    echo Expected .app not found: %APPDIR%
    set ERRORLEVEL=1
    goto :end
)

set "OUT_TGZ=dist\AMMViewer-mac-%ARCH%.tar.gz"
call node pack-app-bundle.js --root "%APPDIR%" --out "%OUT_TGZ%"
if errorlevel 1 (
    echo Tar packing FAILED.
    goto :end
)

echo.
echo ============================================================
echo  Build SUCCEEDED.
echo    .app:          %APPDIR%
echo    Distributable: %OUT_TGZ%
echo.
echo  User instructions:
echo    tar -xzf AMMViewer-mac-%ARCH%.tar.gz
echo    xattr -dr com.apple.quarantine AMMViewer.app
echo    open AMMViewer.app
echo ============================================================

:end
echo.
pause
endlocal

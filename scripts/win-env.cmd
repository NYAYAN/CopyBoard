@echo off
REM Verilen komutu Visual Studio C++ derleme ortaminda calistirir (herhangi bir surum/edisyon).
REM
REM   scripts\win-env.cmd cargo run
REM   scripts\win-env.cmd cargo test
REM   scripts\win-env.cmd npx tauri dev
REM
REM Neden gerekli:
REM
REM 1. tesseract-rs (build-tesseract) ve aws-lc-sys (guncelleyicinin TLS'i) cmake + MSVC
REM    ister. cmake cogu makinede PATH'te degil; PATH'te yoksa VS'nin kendi kopyasi eklenir.
REM 2. Birden fazla VS kuruluysa find-msvc-tools en yenisini seciyor; o kurulum eksikse
REM    (lib\x64\msvcrt.lib yok) linker "LNK1104: cannot open file 'msvcrt.lib'" veriyor.
REM    Bu yuzden vswhere'in verdigi her kurulum msvcrt.lib ile dogrulanip ilk TAM olan
REM    seciliyor. Elle secmek icin:  set COPYBOARD_VS=C:\Program Files\Microsoft Visual Studio\2022\Community
REM 3. cargo, Cargo.toml'un bulundugu src-tauri icinde calismali; npm ve digerleri repo kokunde.
REM
REM Sogukta ilk derleme ~10 dakika (Tesseract + Leptonica kaynaktan derleniyor).
REM Ayrintilar: docs\BUILD_WINDOWS.md
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VS="

if defined COPYBOARD_VS (
  call :try "%COPYBOARD_VS%"
  if not defined VS (
    echo HATA: COPYBOARD_VS eksik ya da tamamlanmamis bir kurulum: %COPYBOARD_VS%
    exit /b 1
  )
) else (
  if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%P in (`"%VSWHERE%" -all -products * -sort -property installationPath`) do (
      if not defined VS call :try "%%P"
    )
  )
  for %%E in (Enterprise Professional Community BuildTools) do (
    if not defined VS call :try "%ProgramFiles%\Microsoft Visual Studio\2022\%%E"
    if not defined VS call :try "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\%%E"
  )
)

if not defined VS (
  echo HATA: MSVC C++ araclari olan bir Visual Studio ya da Build Tools kurulumu bulunamadi.
  echo   Visual Studio Installer ^> "Desktop development with C++" is yukunu kurun
  echo   ^(Windows 10/11 SDK ve "C++ CMake tools for Windows" bilesenleri dahil^).
  echo   Bkz. docs\BUILD_WINDOWS.md
  exit /b 1
)

set "PATH=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer;%PATH%"
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1

where cmake >nul 2>nul
if errorlevel 1 (
  if exist "%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" (
    set "PATH=%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%PATH%"
  ) else (
    >&2 echo UYARI: cmake bulunamadi; tesseract-rs derlenemez. VS Installer'da "C++ CMake tools for Windows"
    >&2 echo        bilesenini ekleyin ya da cmake.org kurulumunu PATH'e alin.
  )
)

if "%~1"=="" (
  echo Kullanim: scripts\win-env.cmd ^<komut^> [argumanlar...]
  exit /b 1
)
if /i "%~1"=="cargo" (
  cd /d "%~dp0..\src-tauri" || exit /b 1
) else (
  cd /d "%~dp0.." || exit /b 1
)
>&2 echo [win-env] %VS%
%*
exit /b %errorlevel%

:try
REM Aday kurulum: vcvars64 ve en az bir MSVC surumunde lib\x64\msvcrt.lib olmali.
set "CAND=%~1"
if not exist "%CAND%\VC\Auxiliary\Build\vcvars64.bat" exit /b 0
for /d %%M in ("%CAND%\VC\Tools\MSVC\*") do (
  if exist "%%~M\lib\x64\msvcrt.lib" (
    set "VS=%CAND%"
    exit /b 0
  )
)
exit /b 0

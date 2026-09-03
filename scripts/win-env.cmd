@echo off
REM Verilen komutu, bu makinede derleme yapabilen Visual Studio ortaminda calistirir.
REM
REM   scripts\win-env.cmd cargo check --all-targets
REM   scripts\win-env.cmd cargo test
REM   scripts\win-env.cmd npm run dev
REM
REM Neden gerekli:
REM
REM 1. Iki Visual Studio kurulu. find-msvc-tools daha yeni olan "18" surumunu
REM    seciyor ama o kurulumun lib\x64 dizini eksik: msvcrt.lib yok ve linker
REM    "LNK1104: cannot open file 'msvcrt.lib'" veriyor. Ortam bu yuzden VS 2022
REM    Professional'a SABITLENIYOR.
REM 2. cmake, tesseract-rs'in build-tesseract ozelligi icin zorunlu ve PATH'te
REM    degil; VS'nin kendi kopyasi kullaniliyor.
REM 3. vcvars64 kurulumu vswhere ile buluyor ve onu PATH'te ariyor; cagiran ortam
REM    bir sekilde ProgramFiles(x86)'yi tasimazsa "vswhere.exe is not recognized"
REM    ile dusuyor. Yol bu yuzden acikca ekleniyor.
REM
REM Sogukta ilk derleme ~10 dakika (Tesseract + Leptonica kaynaktan derleniyor).
setlocal
set "VS=C:\Program Files\Microsoft Visual Studio\2022\Professional"
if not exist "%VS%\VC\Auxiliary\Build\vcvars64.bat" (
  echo HATA: VS 2022 Professional bulunamadi: %VS%
  exit /b 1
)
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\Installer;%PATH%"
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
set "PATH=%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%PATH%"
if "%~1"=="" (
  echo Kullanim: scripts\win-env.cmd ^<komut^> [argumanlar...]
  exit /b 1
)
REM cargo, Cargo.toml'un bulundugu dizinde calismali; npm ve digerleri repo kokunde.
if /i "%~1"=="cargo" (
  cd /d "%~dp0..\src-tauri" || exit /b 1
) else (
  cd /d "%~dp0.." || exit /b 1
)
%*

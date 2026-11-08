@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === c2vocab: publicar en GitHub Pages ===
echo 0) 마지막 배포 이후 바뀐 파일이 있는지 확인합니다...
git status --porcelain | findstr /r "." >nul
if errorlevel 1 (
  rem Nothing changed since the last commit. Still publish when the stamp is stale (release.py
  rem --check fails) or when there are commits GitHub has not received yet (for example a step
  rem committed by Claude Code); otherwise stop: a new version of identical files would only make
  rem every phone download the same app again.
  python tools\release.py --check >nul 2>&1
  if not errorlevel 1 (
    git rev-parse --verify --quiet origin/main >nul 2>&1
    if not errorlevel 1 (
      git rev-list --count origin/main..main 2>nul | findstr /x "0" >nul
      if not errorlevel 1 (
        echo Nada que publicar
        echo 바뀐 파일도, 아직 올리지 않은 커밋도 없어서 새 버전을 만들지 않았습니다. 이 창을 닫아도 됩니다.
        pause
        exit /b 0
      )
    )
  )
)
echo 1) 새 버전 번호를 찍고 서비스 워커의 파일 목록을 갱신합니다...
python tools\release.py
if errorlevel 1 (
  echo.
  echo [ERROR] release.py가 실패했습니다. 위의 메시지를 확인하세요.
  pause
  exit /b 1
)
set VERSION=
for /f "usebackq tokens=*" %%v in (`python tools\release.py --print-version`) do set VERSION=%%v
echo 2) 변경된 파일을 git에 올립니다 (버전 %VERSION%)...
git remote get-url origin >nul 2>&1
if errorlevel 1 git remote add origin https://github.com/MHLEE99/c2vocab.git
git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo Nada que publicar
  echo 바뀐 파일이 없습니다. 이 창을 닫아도 됩니다.
  pause
  exit /b 0
)
git commit -m "Deploy %VERSION%"
if errorlevel 1 (
  echo.
  echo [ERROR] git commit이 실패했습니다. 위의 메시지를 확인하세요.
  pause
  exit /b 1
)
echo 3) GitHub에 보냅니다 (첫 배포라면 GitHub 로그인 창이 뜹니다)...
git push -u origin main
if errorlevel 1 (
  echo.
  echo [ERROR] git push가 실패했습니다. 인터넷 연결과 GitHub 로그인을 확인하고 다시 실행하세요.
  pause
  exit /b 1
)
echo.
echo Publicado: https://mhlee99.github.io/c2vocab/
echo 1~2분 뒤에 반영됩니다. 이미 설치한 아이폰 앱에서는 'Nueva version disponible' 배너가 뜨면 'Actualizar'를 누르세요.
echo cierra esta ventana / 이 창을 닫아도 됩니다.
pause

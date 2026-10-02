@echo off
cd /d %~dp0
start "" http://localhost:8080
python tools\serve.py 8080

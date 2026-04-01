@echo off
REM Worktree ops: siempre ejecutar desde platform.ops (main)
set PIPELINE_STATE_DIR=C:\Workspaces\Intrale\platform\.pipeline
set NODE_PATH=C:WorkspacesIntraleplatform
ode_modules
set PIPELINE_MAIN_ROOT=C:\Workspaces\Intrale\platform
if exist C:\Workspaces\Intrale\platform.ops\.pipeline\pulpo.js (
    cd /d C:\Workspaces\Intrale\platform.ops
    node .pipeline\pulpo.js
) else (
    cd /d C:\Workspaces\Intrale\platform
    node .pipeline\pulpo.js
)

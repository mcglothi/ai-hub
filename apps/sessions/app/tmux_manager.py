import subprocess
import os
import time

def ensure_workspace_tmux_session(workspace_id: str, tmux_socket: str):
    print(f'Ensuring tmux session {workspace_id} on socket {tmux_socket}')
    check = subprocess.run(
        ['tmux', '-S', tmux_socket, 'has-session', '-t', workspace_id],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    if check.returncode != 0:
        print(f'Creating new tmux session {workspace_id}')
        subprocess.check_call([
            'tmux', '-S', tmux_socket, 'new-session', '-d', '-s', workspace_id
        ])
        # Give it a tiny bit of time to initialize the socket
        time.sleep(0.1)

def get_launch_args(provider_config, working_dir, session_id, tmux_socket, workspace_id):
    base = [
        'tmux', '-S', tmux_socket, 'new-window',
        '-t', f'{workspace_id}:', '-n', session_id,
        '-c', working_dir
    ]
    for k, v in provider_config.get('env', {}).items():
        base.extend(['-e', f'{k}={v}'])
    
    cmd = provider_config.get('launch_cmd', [])
    if cmd:
        return base + cmd
    return base

def launch_session(workspace_id: str, tmux_socket: str, session_id: str, working_dir: str, provider_config: dict):
    ensure_workspace_tmux_session(workspace_id, tmux_socket)
    
    check_win = subprocess.run(["tmux", "-S", tmux_socket, "has-session", "-t", f"{workspace_id}:{session_id}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if check_win.returncode == 0:
        print(f'Window {session_id} already exists in {workspace_id}')
        return

    args = get_launch_args(provider_config, working_dir, session_id, tmux_socket, workspace_id)
    print(f'Launching session window with args: {args}')
    try:
        subprocess.check_call(args)
        print(f'Successfully launched window {session_id}')
    except subprocess.CalledProcessError as e:
        print(f'Tmux launch error for {session_id}: {e}')

def terminate_session(tmux_socket: str, workspace_id: str, session_id: str):
    subprocess.run(
        ['tmux', '-S', tmux_socket, 'kill-window', '-t', f'{workspace_id}:{session_id}'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

def cleanup_workspace(tmux_socket: str, workspace_id: str):
    subprocess.run(
        ['tmux', '-S', tmux_socket, 'kill-session', '-t', workspace_id],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

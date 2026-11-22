#!/usr/bin/env python3
"""Execute the supplied WorkBuddy script with per-task parameters from stdin."""
import json
import os
from pathlib import Path
import sys
import threading
import time


def main():
    os.umask(0o077)
    raw = sys.stdin.buffer.read(131073)
    if len(raw) > 131072:
        raise ValueError('configuration too large')
    data = json.loads(raw)
    parent = data['parentPid']
    if parent != os.getppid():
        return 1

    def watch_parent():
        while True:
            time.sleep(1)
            if os.getppid() != parent:
                os._exit(1)

    threading.Thread(target=watch_parent, daemon=True).start()
    template = Path(__file__).with_name('workbuddy.py')
    scope = {'__name__': 'workbuddy_job', '__file__': str(template)}
    # Import initializes helpers but skips the sample's __main__ block. No network is opened here.
    exec(compile(template.read_text(encoding='utf-8'), str(template), 'exec'), scope)
    scope.update(data['params'])
    scope.update(data['credentials'])
    scope['STATE_FILE'] = data['stateFile']
    scope['LOG_FILE'] = data['logFile']
    scope['HEARTBEAT_CHECK'] = max(1, scope['HEARTBEAT_TIMEOUT'] // 5)
    try:
        scope['main']()
    except KeyboardInterrupt:
        scope['log']('已退出')
    return 0



if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        # Avoid returning request bodies or credentials in exception details.
        print('脚本运行失败：' + type(error).__name__, flush=True)
        raise SystemExit(1)


"""Private IPC helper for a current-user DPAPI Gateway binding, never BC credentials."""
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from gateway.native.storage import EncryptedConnectionStore
from gateway.native.settings import normalize_origin


def validate(value):
    if (type(value) is not dict or set(value) != {'gatewayOrigin', 'connectionId', 'gatewayToken'}
            or normalize_origin(value['gatewayOrigin']) != value['gatewayOrigin']
            or not isinstance(value['connectionId'], str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value['connectionId'])
            or not isinstance(value['gatewayToken'], str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', value['gatewayToken'])):
        raise ValueError('Invalid binding')
    return value


def main():
    mode, path = sys.argv[1:]
    store = EncryptedConnectionStore(path)
    if mode == 'save':
        store.save(validate(json.loads(sys.stdin.read(16385))))
        print('{"saved":true}')
    elif mode == 'load':
        # This pipe is consumed privately by run.mjs, never a user-facing command.
        print(json.dumps(validate(store.load())))
    else:
        raise ValueError('Unsupported binding mode')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"error":"GATEWAY_BINDING_FAILED"}')
        sys.exit(1)

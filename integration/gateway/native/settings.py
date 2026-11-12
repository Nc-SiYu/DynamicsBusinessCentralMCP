"""Non-secret Gateway address settings, shared by the UI and launchers."""
import json
import os
from pathlib import Path
import re
import sys
import tempfile

DEFAULT_ORIGIN = 'http://127.0.0.1:8765'
DEFAULT_PATH = Path(__file__).resolve().parents[3] / '.runtime' / 'native-gateway' / 'settings.json'


class SettingsError(ValueError):
    pass


def normalize_origin(value):
    match = re.fullmatch(r'http://127\.0\.0\.1(?::([0-9]{1,5}))?/?', value.strip()) if isinstance(value, str) else None
    port = int(match[1] or 80) if match else 0
    if not 1 <= port <= 65535:
        raise SettingsError('INVALID_GATEWAY_ADDRESS')
    return 'http://127.0.0.1' if port == 80 else f'http://127.0.0.1:{port}'


def origin_port(value):
    origin = normalize_origin(value)
    return 80 if origin == 'http://127.0.0.1' else int(origin.rsplit(':', 1)[1])


def validate(value):
    if type(value) is not dict or set(value) != {'gatewayOrigin'}:
        raise SettingsError('INVALID_GATEWAY_ADDRESS')
    return {'gatewayOrigin': normalize_origin(value['gatewayOrigin'])}


class GatewaySettings:
    def __init__(self, path=None):
        self.path = Path(path) if path is not None else DEFAULT_PATH

    def load(self):
        try:
            return validate(json.loads(self.path.read_text(encoding='utf-8')))
        except FileNotFoundError:
            return {'gatewayOrigin': DEFAULT_ORIGIN}
        except (OSError, ValueError, TypeError):
            raise SettingsError('GATEWAY_SETTINGS_LOAD_FAILED') from None

    def save(self, value):
        value = validate(value)
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                             prefix='settings-', suffix='.tmp', delete=False) as file:
                temporary = file.name
                file.write(json.dumps(value) + '\n')
            os.replace(temporary, self.path)
        except OSError:
            raise SettingsError('GATEWAY_SETTINGS_WRITE_FAILED') from None
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
        return value

    def public(self, current_origin):
        saved = self.load()
        return {**saved, 'currentOrigin': current_origin,
                'restartRequired': saved['gatewayOrigin'] != current_origin}


if __name__ == '__main__':
    try:
        if len(sys.argv) > 2:
            raise SettingsError('GATEWAY_SETTINGS_LOAD_FAILED')
        settings = GatewaySettings(sys.argv[1] if len(sys.argv) == 2 else None)
        value = settings.load()
        print(json.dumps({**value, 'port': origin_port(value['gatewayOrigin']), 'addressSaved': settings.path.exists()}))
    except SettingsError as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)

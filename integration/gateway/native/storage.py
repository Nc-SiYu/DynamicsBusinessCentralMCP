"""Current-user Windows DPAPI storage; no plaintext files or import-time I/O."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile


DEFAULT_PATH = Path(__file__).resolve().parents[3] / '.runtime' / 'native-gateway' / 'connection.dpapi'
MAX_FILE_SIZE = 65536


class StorageError(Exception):
    def __init__(self):
        super().__init__('Encrypted connection storage failed.')


class _Blob(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]


def _dpapi(data, *, decrypt=False):
    if os.name != 'nt' or not isinstance(data, bytes) or not 0 < len(data) <= MAX_FILE_SIZE:
        raise StorageError()
    buffer = ctypes.create_string_buffer(data)
    incoming = _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = _Blob()
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    operation = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    operation.argtypes = [ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.POINTER(_Blob),
                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob)]
    operation.restype = wintypes.BOOL
    try:
        # UI_FORBIDDEN only: never enable LOCAL_MACHINE (all local users).
        if not operation(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
            raise StorageError()
        if not outgoing.pbData or not 0 < outgoing.cbData <= MAX_FILE_SIZE:
            raise StorageError()
        return ctypes.string_at(outgoing.pbData, outgoing.cbData)
    finally:
        ctypes.memset(buffer, 0, len(buffer))
        if outgoing.pbData:
            ctypes.memset(outgoing.pbData, 0, outgoing.cbData)
            kernel.LocalFree(outgoing.pbData)


class EncryptedConnectionStore:
    def __init__(self, path=DEFAULT_PATH):
        self.path = Path(path)

    def load(self):
        try:
            try:
                with self.path.open('rb') as stream:
                    encrypted = stream.read(MAX_FILE_SIZE + 1)
            except FileNotFoundError:
                return None
            payload = json.loads(_dpapi(encrypted, decrypt=True).decode('utf-8'))
            if (type(payload) is not dict or set(payload) != {'version', 'configuration'}
                    or type(payload['version']) is not int or payload['version'] != 1
                    or type(payload['configuration']) is not dict):
                raise StorageError()
            return payload['configuration']
        except Exception:
            raise StorageError() from None

    def save(self, configuration):
        temporary = None
        try:
            payload = json.dumps({'version': 1, 'configuration': configuration},
                                 ensure_ascii=False).encode('utf-8')
            encrypted = _dpapi(payload)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # Only ciphertext reaches the temporary file; replace preserves the old save on failure.
            with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix='.connection-',
                                             suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(encrypted)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        except Exception:
            raise StorageError() from None
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    raise StorageError() from None

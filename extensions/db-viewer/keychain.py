"""Passwords in the macOS login Keychain, through the Security framework (ctypes).

The password never goes through a command line (where `ps` would show it) nor a file: it's written and read by
this process only. Items are generic passwords, service "<SERVICE>", account = the connection's id; they show up
in Keychain Access, where the user can inspect or delete them.
"""
import ctypes
import ctypes.util

_sec = ctypes.cdll.LoadLibrary(ctypes.util.find_library("Security"))
_cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))

ERR_NOT_FOUND = -25300
_u32 = ctypes.c_uint32
_vp = ctypes.c_void_p

_sec.SecKeychainFindGenericPassword.argtypes = [_vp, _u32, ctypes.c_char_p, _u32, ctypes.c_char_p,
                                                ctypes.POINTER(_u32), ctypes.POINTER(_vp), ctypes.POINTER(_vp)]
_sec.SecKeychainAddGenericPassword.argtypes = [_vp, _u32, ctypes.c_char_p, _u32, ctypes.c_char_p,
                                               _u32, ctypes.c_char_p, ctypes.POINTER(_vp)]
_sec.SecKeychainItemModifyAttributesAndData.argtypes = [_vp, _vp, _u32, ctypes.c_char_p]
_sec.SecKeychainItemDelete.argtypes = [_vp]
_sec.SecKeychainItemFreeContent.argtypes = [_vp, _vp]
_cf.CFRelease.argtypes = [_vp]
for f in ("SecKeychainFindGenericPassword", "SecKeychainAddGenericPassword",
          "SecKeychainItemModifyAttributesAndData", "SecKeychainItemDelete", "SecKeychainItemFreeContent"):
    getattr(_sec, f).restype = ctypes.c_int32


class KeychainError(Exception):
    pass


def _find(service, account, want_data):
    s, a = service.encode(), account.encode()
    length, data, item = _u32(0), _vp(), _vp()
    st = _sec.SecKeychainFindGenericPassword(None, len(s), s, len(a), a,
                                             ctypes.byref(length) if want_data else None,
                                             ctypes.byref(data) if want_data else None, ctypes.byref(item))
    if st == ERR_NOT_FOUND:
        return None, None
    if st != 0:
        raise KeychainError(f"Keychain read failed (OSStatus {st})")
    value = None
    if want_data:
        value = ctypes.string_at(data, length.value).decode("utf-8")
        _sec.SecKeychainItemFreeContent(None, data)
    return item, value


def get(service, account):
    item, value = _find(service, account, True)
    if item:
        _cf.CFRelease(item)
    return value


def has(service, account):
    item, _ = _find(service, account, False)
    if item:
        _cf.CFRelease(item)
        return True
    return False


def set(service, account, password):
    p = password.encode("utf-8")
    item, _ = _find(service, account, False)
    if item:
        try:
            st = _sec.SecKeychainItemModifyAttributesAndData(item, None, len(p), p)
        finally:
            _cf.CFRelease(item)
    else:
        s, a, new = service.encode(), account.encode(), _vp()
        st = _sec.SecKeychainAddGenericPassword(None, len(s), s, len(a), a, len(p), p, ctypes.byref(new))
        if new:
            _cf.CFRelease(new)
    if st != 0:
        raise KeychainError(f"Keychain write failed (OSStatus {st})")


def delete(service, account):
    item, _ = _find(service, account, False)
    if not item:
        return False
    try:
        st = _sec.SecKeychainItemDelete(item)
    finally:
        _cf.CFRelease(item)
    if st != 0:
        raise KeychainError(f"Keychain delete failed (OSStatus {st})")
    return True

#!/usr/bin/env python3
"""Modify APK versionCode by patching AndroidManifest.xml binary and re-signing.

Usage:
  python3 patch-apk-version.py <input.apk> <output.apk> <new_version_code> [new_version_name]

Binary manifest format for typed-int attributes:
  attribute_size (2 bytes LE) + type_byte (1 byte) + [1 byte] + value (4 bytes LE)
For versionCode: size=0x0008, type=0x10 (TYPE_INT_DEC), value=<uint32>

We locate the versionCode by:
1. Querying aapt2 for the authoritative current versionCode
2. Searching binary manifest for the exact prefix: 0x0008 0x10 [pad] <old_version>
3. Replacing the value bytes only
"""

import sys, struct, zipfile, os, shutil, subprocess

ANDROID_HOME = os.environ.get("ANDROID_HOME", "/Users/fanzhang/Library/Android/sdk")
BUILD_TOOLS = os.path.join(ANDROID_HOME, "build-tools/36.0.0")
AAPT2 = os.path.join(BUILD_TOOLS, "aapt2")
APKSIGNER = os.path.join(BUILD_TOOLS, "apksigner")
ZIPALIGN = os.path.join(BUILD_TOOLS, "zipalign")
JAVA_HOME = "/Applications/Android Studio.app/Contents/jbr/Contents/Home"

DEBUG_KEYSTORE = os.path.join(os.path.expanduser("~"), ".android/debug.keystore")
KEYSTORE_PASS = "android"
KEY_ALIAS = "androiddebugkey"


def find_keystore():
    candidates = [DEBUG_KEYSTORE, "/Users/fanzhang/.android/debug.keystore"]
    for p in candidates:
        if os.path.exists(p): return p
    raise FileNotFoundError("debug.keystore not found")


def get_current_version_info(apk_path):
    """Use aapt2 to get authoritative current versionCode."""
    env = {**os.environ, "JAVA_HOME": JAVA_HOME, "PATH": f"{JAVA_HOME}/bin:" + os.environ.get("PATH", "")}
    r = subprocess.run([AAPT2, "dump", "badging", apk_path],
                       capture_output=True, text=True, env=env)
    for line in r.stdout.split('\n'):
        if 'versionCode' in line:
            return int(line.split("versionCode='")[1].split("'")[0])
    raise RuntimeError("Could not determine current versionCode from APK")


def patch_manifest(data: bytearray, old_version: int, new_version: int) -> int:
    """Find the versionCode typed-int in binary manifest and replace value bytes.
    
    Binary XML attribute format for TYPE_INT_DEC (0x10):
      [2b attr_size LE][1b type=0x10][1b reserved][4b value LE]
    versionCode uses attr_size=0x0008.
    """
    old_bytes = struct.pack('<I', old_version)
    new_bytes = struct.pack('<I', new_version)
    
    # Pattern: size=0x0008, type=0x10, [1b], <old_version>
    prefix = bytes([0x08, 0x00, 0x00, 0x10])  # size=0x0008 LE, type=0x10, pad=0x00  # 0x0008 (LE) + 0x10 + pad
    replacements = 0
    pos = 0
    while True:
        idx = data.find(prefix, pos)
        if idx == -1:
            break
        # Check value at idx + 4
        if idx + 8 > len(data):
            pos = idx + 1
            continue
        if data[idx + 4:idx + 8] == old_bytes:
            data[idx + 4:idx + 8] = new_bytes
            print(f"  Patched versionCode at offset {idx}: {old_version} -> {new_version}")
            replacements += 1
            pos = idx + 8
        else:
            pos = idx + 1
    return replacements


def patch_and_sign(input_apk, output_apk, new_version_code, new_version_name):
    work_dir = f"/tmp/apk-work-{os.getpid()}-{os.urandom(4).hex()}"
    os.makedirs(work_dir, exist_ok=True)
    env = {**os.environ, "JAVA_HOME": JAVA_HOME, "PATH": f"{JAVA_HOME}/bin:" + os.environ.get("PATH", "")}

    try:
        # 1. Extract APK
        with zipfile.ZipFile(input_apk, 'r') as zf:
            zf.extractall(work_dir)

        # 2. Get authoritative version from aapt2
        old_version = get_current_version_info(input_apk)
        print(f"Current versionCode: {old_version}")

        # 3. Patch AndroidManifest.xml
        manifest_path = os.path.join(work_dir, "AndroidManifest.xml")
        with open(manifest_path, 'rb') as f:
            data = bytearray(f.read())

        replacements = patch_manifest(data, old_version, new_version_code)
        if replacements == 0:
            print("ERROR: versionCode attribute not found in manifest")
            return False
        print(f"Total replacements: {replacements}")

        with open(manifest_path, 'wb') as f:
            f.write(data)

        # 4. Re-pack (no compression)
        unsigned_apk = os.path.join(work_dir, "unsigned.apk")
        with zipfile.ZipFile(unsigned_apk, 'w', zipfile.ZIP_STORED) as zf:
            for root, dirs, files in os.walk(work_dir):
                dirs[:] = [d for d in dirs if d not in ('unsigned.apk', 'aligned.apk')]
                for file in files:
                    if file in ('unsigned.apk', 'aligned.apk'):
                        continue
                    fp = os.path.join(root, file)
                    zf.write(fp, os.path.relpath(fp, work_dir))

        # 5. Zipalign
        aligned_apk = os.path.join(work_dir, "aligned.apk")
        r = subprocess.run([ZIPALIGN, "-p", "4", unsigned_apk, aligned_apk],
                          capture_output=True, text=True, env=env)
        if r.returncode != 0:
            print(f"zipalign failed: {r.stderr}")
            return False
        print("zipalign OK")

        # 6. Re-sign
        r = subprocess.run(
            [APKSIGNER, "sign",
             "--ks", find_keystore(),
             "--ks-pass", f"pass:{KEYSTORE_PASS}",
             "--key-pass", f"pass:{KEYSTORE_PASS}",
             "--ks-key-alias", KEY_ALIAS,
             "--min-sdk-version", "24",
             "--out", output_apk,
             aligned_apk],
            capture_output=True, text=True, env=env
        )
        if r.returncode != 0:
            print(f"apksigner failed: {r.stderr}")
            return False
        print("apksigner OK")

        # 7. Verify
        r = subprocess.run([AAPT2, "dump", "badging", output_apk],
                          capture_output=True, text=True, env=env)
        if r.returncode != 0:
            print(f"Verification failed: {r.stderr}")
            return False
        for line in r.stdout.split('\n'):
            if 'versionCode' in line or line.startswith("package:"):
                print(f"VERIFIED: {line.strip()}")
        return True
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: patch-apk-version.py <input.apk> <output.apk> <new_version_code> [version_name]")
        sys.exit(1)
    ok = patch_and_sign(sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] if len(sys.argv) > 4 else "")
    sys.exit(0 if ok else 1)

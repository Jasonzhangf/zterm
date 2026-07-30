#!/usr/bin/env python3
"""Patch APK versionCode by replacing the specific versionCode value in binary AndroidManifest.xml."""

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
        if os.path.exists(p):
            return p
    raise FileNotFoundError("debug.keystore not found")


def get_current_version_code(apk_path):
    env = {**os.environ, "JAVA_HOME": JAVA_HOME, "PATH": f"{JAVA_HOME}/bin:" + os.environ.get("PATH", "")}
    r = subprocess.run([AAPT2, "dump", "badging", apk_path], capture_output=True, text=True, env=env)
    for line in r.stdout.split('\n'):
        if 'versionCode' in line:
            return int(line.split("versionCode='")[1].split("'")[0])
    raise RuntimeError("Could not determine versionCode")


def patch_manifest_value(data, old_val, new_val):
    """Replace all occurrences of [0x08][0x00][0x00][0x10][old_val_LE] in binary manifest."""
    old_bytes = struct.pack('<I', old_val)
    new_bytes = struct.pack('<I', new_val)
    # TYPE_INT_HEX(0x08) + reserved(0x00) + reserved(0x00) + size(0x10) + value(4)
    pattern = bytes([0x08, 0x00, 0x00, 0x10])
    count = 0
    pos = 0
    while True:
        idx = data.find(pattern, pos)
        if idx == -1:
            break
        if idx + 8 > len(data):
            pos = idx + 1
            continue
        if data[idx+4:idx+8] == old_bytes:
            data[idx+4:idx+8] = new_bytes
            count += 1
            print(f"  Patched at offset {idx}: {old_val} -> {new_val}")
            pos = idx + 8
        else:
            pos = idx + 1
    return count


def patch_and_sign(input_apk, output_apk, new_version_code):
    work_dir = f"/tmp/apk-work-{os.getpid()}-{os.urandom(4).hex()}"
    os.makedirs(work_dir, exist_ok=True)
    env = {**os.environ, "JAVA_HOME": JAVA_HOME, "PATH": f"{JAVA_HOME}/bin:" + os.environ.get("PATH", "")}
    try:
        with zipfile.ZipFile(input_apk, 'r') as zf:
            zf.extractall(work_dir)
        old_vc = get_current_version_code(input_apk)
        print(f"Current versionCode: {old_vc} (0x{old_vc:08x})")
        manifest_path = os.path.join(work_dir, "AndroidManifest.xml")
        with open(manifest_path, 'rb') as f:
            data = bytearray(f.read())
        cnt = patch_manifest_value(data, old_vc, new_version_code)
        if cnt == 0:
            print("ERROR: Could not locate versionCode pattern in manifest"); return False
        print(f"Replacements: {cnt}")
        with open(manifest_path, 'wb') as f:
            f.write(data)
        unsigned_apk = os.path.join(work_dir, "unsigned.apk")
        with zipfile.ZipFile(unsigned_apk, 'w', zipfile.ZIP_STORED) as zf:
            for root, dirs, files in os.walk(work_dir):
                dirs[:] = [d for d in dirs if d not in ('unsigned.apk', 'aligned.apk')]
                for file in files:
                    if file in ('unsigned.apk', 'aligned.apk'): continue
                    fp = os.path.join(root, file)
                    zf.write(fp, os.path.relpath(fp, work_dir))
        aligned_apk = os.path.join(work_dir, "aligned.apk")
        r = subprocess.run([ZIPALIGN, "-p", "4", unsigned_apk, aligned_apk], capture_output=True, text=True, env=env)
        if r.returncode != 0: print(f"zipalign failed: {r.stderr}"); return False
        print("zipalign OK")
        r = subprocess.run([APKSIGNER, "sign", "--ks", find_keystore(),
             "--ks-pass", f"pass:{KEYSTORE_PASS}", "--key-pass", f"pass:{KEYSTORE_PASS}",
             "--ks-key-alias", KEY_ALIAS, "--min-sdk-version", "24",
             "--out", output_apk, aligned_apk], capture_output=True, text=True, env=env)
        if r.returncode != 0: print(f"apksigner failed: {r.stderr}"); return False
        print("apksigner OK")
        r = subprocess.run([AAPT2, "dump", "badging", output_apk], capture_output=True, text=True, env=env)
        if r.returncode != 0: print(f"aapt2 verify failed: {r.stderr}"); return False
        for line in r.stdout.split('\n'):
            if 'versionCode' in line or line.startswith("package:"):
                print(f"  VERIFIED: {line.strip()}")
        return True
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: patch-apk-version.py <input.apk> <output.apk> <new_version_code> [version_name]")
        sys.exit(1)
    input_apk = sys.argv[1]
    output_apk = sys.argv[2]
    new_version_code = int(sys.argv[3])
    print(f"Input:  {input_apk}")
    print(f"Output: {output_apk}")
    print(f"New versionCode: {new_version_code} (0x{new_version_code:08x})")
    ok = patch_and_sign(input_apk, output_apk, new_version_code)
    sys.exit(0 if ok else 1)

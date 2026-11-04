#!/usr/bin/env bash
# Signed Android release builds run on Linux (including WSL), never the Windows
# native toolchain. No existing directory is overlaid or deleted.
# Usage: bash scripts/build-android.sh [source-dir] [build-root] [artifact-dir]
# Defaults: script's repository root, artifacts/android-build, artifacts/android.
# Every invocation keeps its own build-root/run-*/source; npm/Gradle caches live
# in build-root/cache. The final APK is copied to artifact-dir only after all gates.
# Requires Node/npm from package.json, Python 3, Git, JDK 17 (JAVA_HOME), Android
# SDK (ANDROID_HOME), and the EXPO_ANDROID_* / EXPECTED_RELEASE_CERT_SHA256 /
# EXPO_PUBLIC_RELAY_URL settings below. The signing key must be outside all three
# directories. ANDROID_ARCHES defaults to arm64-v8a,x86_64.

# Even `bash -x` must not trace signing credentials.
set +x
set -euo pipefail

if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  echo 'Usage: bash scripts/build-android.sh [source-dir] [build-root] [artifact-dir]'
  echo 'Linux/WSL only; defaults: repository root, artifacts/android-build, artifacts/android.'
  exit 0
fi
fail() { echo "$1" >&2; exit 1; }
[[ $# -le 3 ]] || fail 'Expected at most source-dir, build-root, and artifact-dir; see --help.'
[[ "$(uname -s)" == Linux ]] || fail 'Android release builds require Linux or WSL; invoke npm in that environment.'
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE_DIR="${1:-$REPO_ROOT}"
BUILD_ROOT="${2:-$REPO_ROOT/artifacts/android-build}"
ARTIFACT_DIR="${3:-$REPO_ROOT/artifacts/android}"
ANDROID_ARCHES="${ANDROID_ARCHES:-arm64-v8a,x86_64}"

: "${EXPO_ANDROID_KEYSTORE_PATH:?Set EXPO_ANDROID_KEYSTORE_PATH to a release key outside the source/build directories.}"
: "${EXPO_ANDROID_KEYSTORE_PASSWORD:?Set EXPO_ANDROID_KEYSTORE_PASSWORD.}"
: "${EXPO_ANDROID_KEY_ALIAS:?Set EXPO_ANDROID_KEY_ALIAS.}"
: "${EXPO_ANDROID_KEY_PASSWORD:?Set EXPO_ANDROID_KEY_PASSWORD.}"
: "${EXPECTED_RELEASE_CERT_SHA256:?Set EXPECTED_RELEASE_CERT_SHA256.}"
: "${EXPO_PUBLIC_RELAY_URL:?Set EXPO_PUBLIC_RELAY_URL to the HTTPS relay this release names.}"
: "${JAVA_HOME:?Set JAVA_HOME to JDK 17.}"
: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK.}"

# Keep signing credentials out of npm, Expo and Gradle environments and logs.
KEYSTORE="$EXPO_ANDROID_KEYSTORE_PATH"
KEY_ALIAS="$EXPO_ANDROID_KEY_ALIAS"
STORE_PASSWORD="$EXPO_ANDROID_KEYSTORE_PASSWORD"
KEY_PASSWORD="$EXPO_ANDROID_KEY_PASSWORD"
export -n KEYSTORE KEY_ALIAS STORE_PASSWORD KEY_PASSWORD
unset EXPO_ANDROID_KEYSTORE_PATH EXPO_ANDROID_KEYSTORE_PASSWORD EXPO_ANDROID_KEY_ALIAS EXPO_ANDROID_KEY_PASSWORD
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export ANDROID_SDK_ROOT="$ANDROID_HOME" EXPO_NO_TELEMETRY=1 EXPO_PUBLIC_RELAY_URL
for tool in node npm python3 git java; do command -v "$tool" >/dev/null || fail "Required tool not found: $tool"; done
[[ -x "$JAVA_HOME/bin/java" ]] || fail 'JAVA_HOME does not contain an executable JDK.'
JAVA_VERSION="$("$JAVA_HOME/bin/java" -version 2>&1)"
[[ "$JAVA_VERSION" == *'version "17.'* || "$JAVA_VERSION" == *'version "17"'* ]] \
  || fail 'JAVA_HOME must select JDK 17.'
[[ -d "$ANDROID_HOME/build-tools" ]] || fail 'ANDROID_HOME/build-tools is missing.'
APKSIGNER="$(find "$ANDROID_HOME/build-tools" -name apksigner -type f | sort -V | tail -1)"
[[ -n "$APKSIGNER" && -x "$APKSIGNER" ]] || fail 'An executable apksigner was not found in ANDROID_HOME/build-tools.'
[[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/package-lock.json" ]] || fail 'source-dir must contain package.json and package-lock.json.'
[[ "$(npm --version)" == 12.2.1 ]] || fail 'Use the project package manager npm 12.2.1; do not build with a different npm.'
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if (!(a===22&&(b>22||b===22&&c>=2)||a===24&&b>=15||a>=26)) process.exit(1)' \
  || fail 'Unsupported Node version; use the package.json Node range.'
EXPECTED_CERT="$(printf '%s' "$EXPECTED_RELEASE_CERT_SHA256" | tr 'A-F' 'a-f' | tr -d ' :')"
[[ "$EXPECTED_CERT" =~ ^[a-f0-9]{64}$ ]] || fail 'EXPECTED_RELEASE_CERT_SHA256 must be a SHA-256 certificate digest.'
node -e 'try { const u=new URL(process.env.EXPO_PUBLIC_RELAY_URL); if(u.protocol!=="https:"||!u.hostname||u.username||u.password||u.search||u.hash) process.exit(1) } catch { process.exit(1) }' \
  || fail 'EXPO_PUBLIC_RELAY_URL must be an HTTPS URL without credentials, query or fragment.'

# Resolve symlinks before checking key containment, including not-yet-created roots.
python3 - "$SOURCE_DIR" "$BUILD_ROOT" "$ARTIFACT_DIR" "$KEYSTORE" <<'PY'
import pathlib, sys
source, build, artifacts, key = map(lambda p: pathlib.Path(p).resolve(), sys.argv[1:])
if not key.is_file():
    sys.exit('The release keystore is not a readable file.')
if any(key == root or root in key.parents for root in (source, build, artifacts)):
    sys.exit('The signing key must stay outside the source, build-root and artifact directories.')
if build == source or build in source.parents or artifacts == source or artifacts in source.parents:
    sys.exit('Build/artifact directories must not contain the source directory.')
PY
KEYSTORE="$(python3 -c 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).resolve())' "$KEYSTORE")"
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd -P)"
mkdir -p "$BUILD_ROOT" "$ARTIFACT_DIR"
BUILD_ROOT="$(cd "$BUILD_ROOT" && pwd -P)"
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd -P)"
RUN_DIR="$(mktemp -d "$BUILD_ROOT/run-XXXXXXXX")"
BUILD_DIR="$RUN_DIR/source"
mkdir "$BUILD_DIR"
export npm_config_cache="$BUILD_ROOT/cache/npm"
export GRADLE_USER_HOME="$BUILD_ROOT/cache/gradle"
echo "=== fresh build: $RUN_DIR ==="

# A separate empty Git index applies .gitignore even to an exported source tree
# with no .git directory. It also excludes ignored files that happen to be tracked.
# Never copy local credentials, private worktrees, generated output, or symlinks.
git init --bare --quiet "$RUN_DIR/copy-policy.git"
python3 - "$SOURCE_DIR" "$BUILD_DIR" "$RUN_DIR/copy-policy.git" "$BUILD_ROOT" "$ARTIFACT_DIR" <<'PY'
import fnmatch, os, pathlib, shutil, subprocess, sys
source, target, policy, build, artifacts = map(pathlib.Path, sys.argv[1:])
cmd = ['git', '--git-dir=' + str(policy), '--work-tree=' + str(source), 'ls-files', '--others', '--exclude-standard', '-z']
local_excludes = source / '.git/info/exclude'
if local_excludes.is_file():
    cmd += ['--exclude-from=' + str(local_excludes)]
paths = subprocess.check_output(cmd, cwd=source).split(b'\0')
blocked = {'.git', 'node_modules', '.expo', '.expo-shared', 'dist', 'build', 'coverage', 'web-build', 'android', 'ios', 'artifacts', 'miniapps', '.wrangler', 'upstream', 'public-ready'}
patterns = ('.env*', '.dev.vars*', 'bridge-token*', 'bridge-config.json*', 'ledger.json*', '*.keystore', '*.jks', '*.p12', '*.pfx', '*.pem', '*.key', '*.apk', '*.aab', '*.log', '*.tsbuildinfo')
for raw in paths:
    if not raw:
        continue
    rel = pathlib.Path(os.fsdecode(raw))
    if any(part in blocked or part.startswith(('.audit', '.upstream', '.public-ready')) for part in rel.parts):
        continue
    if any(fnmatch.fnmatch(rel.name.lower(), pattern) for pattern in patterns):
        continue
    original = source / rel
    resolved = original.resolve()
    if any(resolved == root or root in resolved.parents for root in (build, artifacts)):
        continue
    if original.is_symlink() or any(parent.is_symlink() for parent in original.parents if parent != source and source in parent.parents):
        sys.exit('Source symlinks are not supported by the isolated Android build.')
    if not original.is_file():
        continue
    if rel.name.lower() == '.npmrc':
        if rel != pathlib.Path('.npmrc'):
            continue
        lines = [s.strip() for s in original.read_text().splitlines() if s.strip() and not s.lstrip().startswith('#')]
        if set(lines) != {'strict-allow-scripts=true', 'engine-strict=true'}:
            sys.exit('Only the credential-free project policy .npmrc may enter the build.')
    destination = target / rel
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(original, destination)
PY
cd "$BUILD_DIR"
[[ -f .npmrc ]] || fail 'The credential-free strict project .npmrc must be present in the staged source.'
echo '=== locked dependency restore ==='
npm ci

echo '=== shared protocol and fresh native prebuild ==='
npm run build -w @minimax-bot/protocol
(cd apps/app && npm exec --offline -- expo prebuild --platform android --no-install)

NETCONF="$BUILD_DIR/apps/app/android/app/src/main/res/xml/network_security_config.xml"
DEBUG_NETCONF="$BUILD_DIR/apps/app/android/app/src/debug/res/xml/network_security_config.xml"
DEBUG_OPTIMIZED_NETCONF="$BUILD_DIR/apps/app/android/app/src/debugOptimized/res/xml/network_security_config.xml"
MANIFEST="$BUILD_DIR/apps/app/android/app/src/main/AndroidManifest.xml"
node "$BUILD_DIR/scripts/check-network-security-config.mjs" \
  "$NETCONF" "$MANIFEST" "$DEBUG_NETCONF" "$DEBUG_OPTIMIZED_NETCONF"
CONFIGS_EXPECTED="$(printf '%s\n' \
  'src/debug/res/xml/network_security_config.xml' \
  'src/debugOptimized/res/xml/network_security_config.xml' \
  'src/main/res/xml/network_security_config.xml')"
CONFIGS_FOUND="$(cd "$BUILD_DIR/apps/app/android/app" && find src -name 'network_security_config.xml' | LC_ALL=C sort)"
[[ "$CONFIGS_FOUND" == "$CONFIGS_EXPECTED" ]] || fail 'Unexpected generated Android network security configs.'

echo '=== assembleRelease ==='
cd "$BUILD_DIR/apps/app/android"
./gradlew assembleRelease -PreactNativeArchitectures="$ANDROID_ARCHES" --no-daemon --console=plain

# Only the exact universal assembleRelease variant from this fresh run is eligible.
# Debug/old outputs elsewhere are irrelevant; split/renamed release outputs fail.
RELEASE_DIR="$BUILD_DIR/apps/app/android/app/build/outputs/apk/release"
APK="$RELEASE_DIR/app-release.apk"
[[ -f "$APK" && ! -L "$APK" ]] || fail 'The current assembleRelease did not produce apk/release/app-release.apk.'
RELEASE_APKS="$(find "$RELEASE_DIR" -name '*.apk')"
[[ "$RELEASE_APKS" == "$APK" ]] || fail 'Unexpected release APK outputs; refusing to choose an arbitrary variant.'

echo '=== sign and verify the current release ==='
SIGNED_APK="$RUN_DIR/minimax-bot-mobile-release.apk"
# Passwords reach apksigner through its supported environment providers, not argv.
RELEASE_STORE_PASSWORD="$STORE_PASSWORD" RELEASE_KEY_PASSWORD="$KEY_PASSWORD" \
  "$APKSIGNER" sign --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass env:RELEASE_STORE_PASSWORD --key-pass env:RELEASE_KEY_PASSWORD \
  --out "$SIGNED_APK" "$APK"
unset STORE_PASSWORD KEY_PASSWORD
# Matching certificate diagnostics never substitute for successful verification.
if ! VERIFY_OUTPUT="$("$APKSIGNER" verify --print-certs "$SIGNED_APK")"; then
  fail 'APK signature verification failed.'
fi
ACTUAL_CERT="$(printf '%s\n' "$VERIFY_OUTPUT" \
  | sed -n 's/.*certificate SHA-256 digest: *//p' | head -1 \
  | tr 'A-F' 'a-f' | tr -d ' :')"
[[ -n "$ACTUAL_CERT" && "$ACTUAL_CERT" == "$EXPECTED_CERT" ]] \
  || fail 'The APK is not signed with the expected release certificate.'

# Validate the artifact itself, not just the bundler's environment. No live calls.
python3 - "$SIGNED_APK" <<'PY'
import os, sys, zipfile
try:
    with zipfile.ZipFile(sys.argv[1]) as z:
        data = z.read('assets/index.android.bundle')
except (KeyError, zipfile.BadZipFile):
    sys.exit('The APK has no readable Android bundle.')
if not any(os.environ['EXPO_PUBLIC_RELAY_URL'].encode(enc) in data for enc in ('utf-8', 'utf-16-le')):
    sys.exit('The APK does not name its configured relay.')
PY
# Only a successfully verified build can replace the named output artifact.
FINAL_APK="$ARTIFACT_DIR/minimax-bot-mobile-release.apk"
[[ ! -L "$FINAL_APK" && ( ! -e "$FINAL_APK" || -f "$FINAL_APK" ) ]] \
  || fail 'The final APK path must not be a symlink or directory.'
cp "$SIGNED_APK" "$FINAL_APK"
echo "=== verified release APK: $FINAL_APK ==="

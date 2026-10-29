#!/usr/bin/env bash
#
# Builds the Android release APK on Linux.
#
# React Native cannot be built on Windows: the Gradle native build runs `ninja`, which
# does not honour the long-path prefix that `LongPathsEnabled` sets, so the generated
# object paths run past the 260-character limit no matter where the repository lives.
# The build therefore runs in a Linux environment — a WSL2 distribution on Windows, a
# container or a CI runner elsewhere.
#
# The whole workspace is copied, not just `apps/app`. The client bundles
# `@minimax-bot/protocol`, so a change in `packages/protocol` that never reaches the
# build host produces an APK built against a stale contract — the app then ships a
# bundle that is missing an export and crashes on launch, with nothing in the build
# log to say why.
#
# Usage:
#   scripts/build-android.sh [source-dir] [build-dir]
#
#   source-dir  the repository to build              (default: the repository root)
#   build-dir   where the sources are copied to      (default: /root/src)
#
# Environment:
#   JAVA_HOME         JDK 17 (the version React Native 0.88 pins)
#   ANDROID_HOME      the Android SDK
#   ANDROID_ARCHES    the ABIs to build              (default: arm64-v8a,x86_64)
#
#   EXPO_ANDROID_KEYSTORE_PATH      the release keystore        (required)
#   EXPO_ANDROID_KEYSTORE_PASSWORD  its password                (required)
#   EXPO_ANDROID_KEY_ALIAS         the key alias               (required)
#   EXPO_ANDROID_KEY_PASSWORD      the key password             (required)
#   EXPECTED_RELEASE_CERT_SHA256   the release certificate      (required)
#
# The release key is required, not optional. A release signed with the Expo
# template's debug keystore can be replaced by anyone who has that keystore —
# it is a well-known value — so the operating system would accept an attacker's
# build as an update to this one. The build stops rather than producing an
# artefact with that identity.

set -euo pipefail

SOURCE_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BUILD_DIR="${2:-/root/src}"
ANDROID_ARCHES="${ANDROID_ARCHES:-arm64-v8a,x86_64}"

export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export EXPO_NO_TELEMETRY=1

: "${EXPO_ANDROID_KEYSTORE_PATH:?The release keystore is required: set EXPO_ANDROID_KEYSTORE_PATH. The build will not produce a debug-signed release.}"
: "${EXPO_ANDROID_KEYSTORE_PASSWORD:?The release keystore password is required: set EXPO_ANDROID_KEYSTORE_PASSWORD.}"
: "${EXPO_ANDROID_KEY_ALIAS:?The release key alias is required: set EXPO_ANDROID_KEY_ALIAS.}"
: "${EXPO_ANDROID_KEY_PASSWORD:?The release key password is required: set EXPO_ANDROID_KEY_PASSWORD.}"
: "${EXPECTED_RELEASE_CERT_SHA256:?The expected release certificate is required: set EXPECTED_RELEASE_CERT_SHA256 to the SHA-256 digest of the release certificate.}"

echo "=== source: $SOURCE_DIR"
echo "=== build:  $BUILD_DIR"
echo "=== key:    $EXPO_ANDROID_KEYSTORE_PATH ($EXPO_ANDROID_KEY_ALIAS)"

echo "=== copy the workspace ==="
mkdir -p "$BUILD_DIR"
# The dependency tree and the generated native project are left alone: the first is
# restored with `npm install`, the second is a build artefact that must survive.
tar -C "$SOURCE_DIR" \
    --exclude=node_modules \
    --exclude=.git \
    --exclude=.expo \
    --exclude=dist \
    --exclude=android \
    --exclude=ios \
    --exclude=artifacts \
    --exclude=miniapps \
    --exclude=.wrangler \
    -cf - . | tar -C "$BUILD_DIR" -xf -

cd "$BUILD_DIR"

echo "=== restore the dependency tree ==="
npm install 2>&1 | tail -5

echo "=== build the shared protocol ==="
npm run build -w @minimax-bot/protocol

echo "=== prebuild the native project ==="
# The native project is generated, and the config plugins write into it. It is
# therefore regenerated on every build: skipping it would leave a change to a config
# plugin out of the APK, which is how a stale bundle once shipped.
(cd "$BUILD_DIR/apps/app" && npx expo prebuild --platform android --no-install)

echo "=== the relay needs cleartext on the loopback interface only ==="
NETCONF="$BUILD_DIR/apps/app/android/app/src/main/res/xml/network_security_config.xml"
MANIFEST="$BUILD_DIR/apps/app/android/app/src/main/AndroidManifest.xml"
cat "$NETCONF"
grep -o 'android:networkSecurityConfig="[^"]*"' "$MANIFEST"

# Assert the invariant rather than print it. A gate that only prints is not a
# gate: the build has to fail when the generated config lets cleartext out to
# anywhere other than the loopback interface.
node "$SOURCE_DIR/scripts/check-network-security-config.mjs" "$NETCONF" "$MANIFEST"

echo "=== assembleRelease ==="
cd "$BUILD_DIR/apps/app/android"
./gradlew assembleRelease \
  -PreactNativeArchitectures="$ANDROID_ARCHES" \
  --no-daemon \
  --console=plain 2>&1 | tail -60

echo "=== the APK ==="
find "$BUILD_DIR/apps/app/android/app/build/outputs" -name '*.apk' -exec ls -la {} \;

echo "=== the release certificate ==="
APK="$(find "$BUILD_DIR/apps/app/android/app/build/outputs" -name '*.apk' -print -quit)"
if [ -z "$APK" ]; then
  echo "no APK was produced, so there is nothing to sign or to publish" >&2
  exit 1
fi

APKSIGNER="$(find "$ANDROID_HOME/build-tools" -name apksigner -type f 2>/dev/null | sort -V | tail -1)"
if [ -z "$APKSIGNER" ]; then
  echo "apksigner was not found under $ANDROID_HOME/build-tools" >&2
  exit 1
fi

# The digest is read with `|| true` so that an unreadable certificate produces the
# message below rather than an exit from `set -e` in the middle of the pipeline.
ACTUAL_CERT="$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null \
  | grep -i 'certificate SHA-256 digest' \
  | head -1 \
  | sed 's/.*digest: *//' \
  | tr 'A-F' 'a-f' | tr -d ' :' || true)"
EXPECTED_CERT="$(printf '%s' "$EXPECTED_RELEASE_CERT_SHA256" | tr 'A-F' 'a-f' | tr -d ' :')"

if [ -z "$ACTUAL_CERT" ]; then
  echo "the certificate of $APK could not be read" >&2
  exit 1
fi
if [ "$ACTUAL_CERT" != "$EXPECTED_CERT" ]; then
  echo "the APK is not signed with the release certificate" >&2
  echo "  expected: $EXPECTED_CERT" >&2
  echo "  actual:   $ACTUAL_CERT" >&2
  exit 1
fi
echo "signed with the release certificate: $ACTUAL_CERT"

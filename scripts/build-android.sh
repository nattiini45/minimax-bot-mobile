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

set -euo pipefail

SOURCE_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BUILD_DIR="${2:-/root/src}"
ANDROID_ARCHES="${ANDROID_ARCHES:-arm64-v8a,x86_64}"

export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export EXPO_NO_TELEMETRY=1

echo "=== source: $SOURCE_DIR"
echo "=== build:  $BUILD_DIR"

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
cat "$BUILD_DIR/apps/app/android/app/src/main/res/xml/network_security_config.xml"
grep -o 'android:networkSecurityConfig="[^"]*"' \
  "$BUILD_DIR/apps/app/android/app/src/main/AndroidManifest.xml"

echo "=== assembleRelease ==="
cd "$BUILD_DIR/apps/app/android"
./gradlew assembleRelease \
  -PreactNativeArchitectures="$ANDROID_ARCHES" \
  --no-daemon \
  --console=plain 2>&1 | tail -60

echo "=== the APK ==="
find "$BUILD_DIR/apps/app/android/app/build/outputs" -name '*.apk' -exec ls -la {} \;

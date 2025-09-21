#!/bin/bash

# Instalando Android SDK...
echo "📦 Instalando Android SDK..."

ANDROID_SDK_ROOT="/workspace/android-sdk"
mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"

cd "$ANDROID_SDK_ROOT/cmdline-tools"
curl -o commandlinetools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q commandlinetools.zip
rm commandlinetools.zip
mv cmdline-tools latest

export ANDROID_HOME="$ANDROID_SDK_ROOT"
export ANDROID_SDK_ROOT="$ANDROID_SDK_ROOT"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

yes | sdkmanager --licenses
yes | sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

echo "✅ Android SDK instalado correctamente."

#echo "🎨 Sincronizando íconos oficiales..."
#SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#cd "$SCRIPT_DIR"
#./gradlew :app:composeApp:syncBrandingIcons

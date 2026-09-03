# Fable Cities Native Android

This module is the native Android implementation. It is intentionally separate from the legacy browser client while the simulation systems are ported incrementally.

## Build

Open this `android/` directory in Android Studio, allow Gradle to sync, and run the `app` configuration on an Android emulator or physical device. The project targets SDK 35, supports Android API 26+, and locks the activity to landscape. The app uses a 1920×1080 logical surface and preserves that 16:9 ratio with bounded letterboxing.

From a machine with the Android SDK and Gradle available, the equivalent commands are:

```bash
gradle :app:assembleDebug
gradle :app:installDebug
```

The current sandbox does not include the Android SDK, Gradle, or ADB, so compilation and installation must be performed in Android Studio or a configured Android build environment.

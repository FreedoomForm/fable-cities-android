plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.fablecities.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.fablecities.android"
        minSdk = 26
        targetSdk = 35
        // 40 >> every earlier native-experiment build (last was 2): installs straight
        // over any previous release with the shared committed debug keystore.
        versionCode = 40
        versionName = "2.0.0-web"
    }

    // One committed debug keystore so EVERY CI release APK shares the same signature:
    // a new android-build-* release installs straight over the previous one
    // (no uninstall, no lost progress).
    signingConfigs {
        getByName("debug") {
            storeFile = file("../debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.0")
    testImplementation("junit:junit:4.13.2")
}

kotlin { jvmToolchain(17) }

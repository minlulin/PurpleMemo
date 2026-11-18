import java.io.FileInputStream
import java.util.Properties
import org.gradle.api.GradleException
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

/*
 * Version metadata — fail closed (docs/ANDROID_DISTRIBUTION.md §5).
 *
 * The Tauri CLI regenerates `app/tauri.properties` from the manifests before
 * every Android build, and the file is gitignored. Its absence therefore means
 * this Gradle run is NOT the release pipeline — and the `?: "1"` fallback this
 * replaced would then declare `versionCode 1`, producing an APK that no later
 * release can be installed over, with nothing in the build output saying so.
 */
fun noVersion(detail: String): Nothing = throw GradleException(
    "app/tauri.properties $detail, so this build has no version to declare. " +
        "The Tauri CLI writes that file from the manifests before Gradle runs: build with " +
        "`npx tauri android build --apk --target aarch64` (or `npx tauri android dev`) " +
        "instead of invoking Gradle directly. There is deliberately no fallback: " +
        "versionCode 1 would produce an APK that no later release can install over."
)

val androidVersionCode = tauriProperties.getProperty("tauri.android.versionCode")
    ?.trim()
    ?.toIntOrNull()
    ?.takeIf { it > 0 }
    ?: noVersion("carries no usable tauri.android.versionCode")

val androidVersionName = tauriProperties.getProperty("tauri.android.versionName")
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?: noVersion("carries no usable tauri.android.versionName")

/*
 * ABI policy — docs/ANDROID_DESIGN.md decision 11.
 *
 * `npx tauri android build --target <t>` reaches Gradle as -PabiList/-PtargetList,
 * and the rust plugin (buildSrc) builds the Rust library for that target only.
 * Release ships arm64-v8a and nothing else; x86_64 exists so the app can run on
 * the `purple_memo_test` emulator and is debug-only.
 *
 * Two guards, because one command line is not a guarantee:
 *
 * 1. The request check below refuses a release-capable task unless -PabiList is
 *    exactly `arm64-v8a`.
 * 2. The release variant excludes every other ABI directory from packaging (see
 *    `androidComponents.onVariants` after the `android` block). That is the
 *    structural half: whatever reached Gradle, a release APK cannot carry a
 *    foreign `lib/<abi>/`.
 *
 * The previous check tested task names for the substring "Release", which is
 * false for `assemble` and `build` — Gradle's aggregates over every variant,
 * release included — so either of those built the release variant with the
 * template's default four ABIs.
 */
val releaseAbis = listOf("arm64-v8a")
val requestedAbis = (findProperty("abiList") as? String)
    ?.split(',')
    ?.map { it.trim() }
    ?.filter { it.isNotEmpty() }

// A requested task that can package a release variant: its own name carries the
// build type (`assembleUniversalRelease`, `bundleRelease`, `packageRelease`), or
// it is an aggregate that spans every variant (`assemble`, `build`). Task paths
// arrive as `:app:assembleUniversalRelease`, hence the substringAfterLast.
fun packagesRelease(requested: String): Boolean {
    val name = requested.substringAfterLast(':')
    if (name.isEmpty()) return false
    return name.contains("release", ignoreCase = true) ||
        name == "assemble" ||
        name == "build"
}

val releaseTasks = gradle.startParameter.taskNames.filter { packagesRelease(it) }

if (releaseTasks.isNotEmpty() && requestedAbis != releaseAbis) {
    throw GradleException(
        "Release builds are arm64-v8a only (docs/ANDROID_DESIGN.md decision 11), but " +
            "${releaseTasks.joinToString(" ")} was asked for with abiList=" +
            "${requestedAbis?.joinToString(",") ?: "<the template default: all four ABIs>"}. " +
            "Build release with `npx tauri android build --apk --target aarch64`, or pass " +
            "-PabiList=arm64-v8a. `assemble` and `build` are refused here too: they package " +
            "the release variant, so a bare `./gradlew build` used to ship four ABIs."
    )
}

// Release signing (docs/ANDROID_DISTRIBUTION.md §1): the Tauri CLI does NOT
// read key.properties — this block is the whole wiring. The file is gitignored
// and lives in the generated project's root (gen/android/key.properties).
// Without it a release build stays unsigned, which the distribution doc
// treats as a build failure, never as a shippable APK.
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    FileInputStream(keystorePropertiesFile).use { keystoreProperties.load(it) }
}

android {
    compileSdk = 37
    namespace = "com.minlulin.purplememo"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.minlulin.purplememo"
        minSdk = 26
        targetSdk = 37
        versionCode = androidVersionCode
        versionName = androidVersionName
    }
    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // Applied only when key.properties exists, so a release build on a
            // machine without the keystore still configures (it just stays
            // unsigned and must not be shipped — see the distribution doc).
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

/*
 * Structural half of the ABI policy, release only.
 *
 * It is done here, on the variant, rather than inside
 * `buildTypes.getByName("release") { packaging { … } }`, because a build type
 * has no `packaging` member (verified: the DSL type has no `getPackaging`). A
 * `packaging { }` block written in there resolves through the enclosing
 * `android { }` receiver instead — it applies to EVERY variant, silently, and
 * would strip x86_64 from the emulator's debug build. The `universal` flavour
 * packages whatever -PabiList names (all four ABIs by default), so this is what
 * makes "a release APK is arm64-only" a property of the artefact rather than of
 * the command line that produced it: an invocation the request check cannot
 * name — a Gradle abbreviation such as `./gradlew assemb` — still cannot
 * package another ABI.
 */
androidComponents {
    onVariants { variant ->
        if (variant.buildType == "release") {
            variant.packaging.jniLibs.excludes.addAll(
                listOf("lib/armeabi-v7a/**", "lib/x86/**", "lib/x86_64/**")
            )
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))

// Foojay resolver auto-downloads JDK 17 if the host doesn't have one,
// so users don't need to install Java separately.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "forge-intellij"

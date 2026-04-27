plugins {
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.15.0"
}

group = "com.aion0.forge"
version = "0.1.17"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.1")
        // Bundled terminal plugin — needed for TerminalView (smith terminal attach).
        bundledPlugin("org.jetbrains.plugins.terminal")
    }
}

kotlin {
    jvmToolchain(17)
}

// Force every Kotlin compile task (and its worker JVM) to run on JDK 17
// instead of the host JDK (25 on this machine, which crashes Kotlin's
// internal version parser).
val jdk17Launcher = javaToolchains.launcherFor {
    languageVersion = JavaLanguageVersion.of(17)
}
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    kotlinJavaToolchain.toolchain.use(jdk17Launcher)
}

intellijPlatform {
    buildSearchableOptions = false

    pluginConfiguration {
        version = "0.1.17"
        ideaVersion {
            sinceBuild = "241"
            // Don't pin untilBuild — keeps the plugin compatible with newer
            // IDEs until the platform actually breaks something.
            untilBuild = provider { null }
        }
    }
}

# DSH Mobile ProGuard rules (release build).
# Minification is disabled for v1; rules here are ready for when it is enabled.

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class com.labteto.dshmobile.core.wire.dto.** {
    *** Companion;
}
-keepclasseswithmembers class com.labteto.dshmobile.core.wire.dto.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**

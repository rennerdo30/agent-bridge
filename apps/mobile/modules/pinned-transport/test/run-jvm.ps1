$ErrorActionPreference = 'Stop'
$moduleRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $moduleRoot '.native-tests'
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
# Standalone JVM security tests compile the production pin policy/client factory.
# No Android SDK, Gradle project generation, phone, or source/cache links needed.
$artifacts = @(
  'org/jetbrains/kotlin/kotlin-compiler-embeddable/1.9.25/kotlin-compiler-embeddable-1.9.25.jar',
  'org/jetbrains/kotlin/kotlin-stdlib/1.9.25/kotlin-stdlib-1.9.25.jar',
  'org/jetbrains/kotlin/kotlin-script-runtime/1.9.25/kotlin-script-runtime-1.9.25.jar',
  'org/jetbrains/kotlin/kotlin-reflect/1.6.10/kotlin-reflect-1.6.10.jar',
  'org/jetbrains/intellij/deps/trove4j/1.0.20200330/trove4j-1.0.20200330.jar',
  'org/jetbrains/annotations/13.0/annotations-13.0.jar',
  'com/squareup/okhttp3/okhttp/4.12.0/okhttp-4.12.0.jar',
  'com/squareup/okhttp3/okhttp-tls/4.12.0/okhttp-tls-4.12.0.jar',
  'com/squareup/okhttp3/mockwebserver/4.12.0/mockwebserver-4.12.0.jar',
  'com/squareup/okio/okio-jvm/3.6.0/okio-jvm-3.6.0.jar',
  'junit/junit/4.13.2/junit-4.13.2.jar',
  'org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar'
)
$jars = foreach ($artifact in $artifacts) {
  $target = Join-Path $cacheRoot ($artifact.Split('/')[-1])
  if (!(Test-Path -LiteralPath $target)) {
    Invoke-WebRequest -Uri ('https://repo.maven.apache.org/maven2/' + $artifact) -OutFile $target
  }
  # Verify HTTPS downloads against Maven Central's published artifact checksum.
  $expected = (Invoke-WebRequest -Uri ('https://repo.maven.apache.org/maven2/' + $artifact + '.sha1')).Content.Trim()
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA1).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()) { throw 'JVM artifact digest mismatch' }
  $target
}
$classPath = $jars -join [IO.Path]::PathSeparator
$output = Join-Path $cacheRoot 'pin-policy-tests.jar'
$production = Join-Path $moduleRoot 'android/src/main/java/dev/agentbridge/pinnedtransport/PinPolicy.kt'
$tests = Join-Path $moduleRoot 'android/src/test/java/dev/agentbridge/pinnedtransport/PinPolicyTest.kt'
& java -cp $classPath org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -jvm-target 1.8 -classpath $classPath -d $output $production $tests
if ($LASTEXITCODE -ne 0) { throw 'Kotlin security test compilation failed' }
& java -cp ($output + [IO.Path]::PathSeparator + $classPath) org.junit.runner.JUnitCore dev.agentbridge.pinnedtransport.PinPolicyTest
if ($LASTEXITCODE -ne 0) { throw 'JVM security tests failed' }

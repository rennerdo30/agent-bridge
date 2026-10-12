Pod::Spec.new do |s|
  s.name = 'PinnedTransport'
  s.version = '0.1.0'
  s.summary = 'Private gateway transport authenticated by an enrolled SPKI pin.'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'rennerdo30'
  s.homepage = 'https://github.com/rennerdo30/agent-bridge'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => s.homepage }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end

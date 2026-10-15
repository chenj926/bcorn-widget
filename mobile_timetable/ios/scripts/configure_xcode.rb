#!/usr/bin/env ruby
# Add the supplied native sources and extension to a generated Flutter iOS host.
# Requires the reputable xcodeproj gem, used by CocoaPods. No signing credentials.
require 'xcodeproj'
require 'fileutils'

ios = File.expand_path('..', __dir__)
path = File.join(ios, 'Runner.xcodeproj')
abort 'Generate the Flutter iOS host first; see ios/README.md.' unless File.directory?(path)
project = Xcodeproj::Project.open(path)
runner = project.targets.find { |target| target.name == 'Runner' }
abort 'Runner target was not found. Use the manual integration instructions.' unless runner

backup = File.join(path, 'project.pbxproj.before-timetable')
FileUtils.cp(File.join(path, 'project.pbxproj'), backup) unless File.exist?(backup)

def group_for(project, name)
  project.main_group.groups.find { |group| group.path == name || group.name == name } ||
    project.main_group.new_group(name, name)
end

def reference(group, name)
  group.files.find { |file| file.path == name } || group.new_file(name)
end

def add_source(target, file)
  target.source_build_phase.add_file_reference(file, true)
end

def add_resource(target, file)
  target.resources_build_phase.add_file_reference(file, true)
end

runner_group = group_for(project, 'Runner')
shared_group = group_for(project, 'Shared')
widget_group = group_for(project, 'TimetableWidgets')
%w[AppDelegate.swift BcornSceneDelegate.swift TimetableBridge.swift].each do |name|
  add_source(runner, reference(runner_group, name))
end
shared = reference(shared_group, 'TimetableData.swift')
add_source(runner, shared)
reference(runner_group, 'Runner.entitlements')
add_resource(runner, reference(runner_group, 'PrivacyInfo.xcprivacy'))

widget = project.targets.find { |target| target.name == 'TimetableWidgets' }
widget ||= project.new_target(:app_extension, 'TimetableWidgets', :ios, '14.0')
unless widget.build_configurations.any? { |config| config.name == 'Profile' }
  widget.add_build_configuration('Profile', :release)
end
add_source(widget, shared)
add_source(widget, reference(widget_group, 'TimetableWidgets.swift'))
add_resource(widget, reference(widget_group, 'PrivacyInfo.xcprivacy'))
reference(widget_group, 'Info.plist')
reference(widget_group, 'TimetableWidgets.entitlements')

pubspec_path = File.join(ios, '..', 'pubspec.yaml')
version_line = File.exist?(pubspec_path) ? File.read(pubspec_path)[/^version:\s*['"]?([^'"\s]+)/, 1] : nil
version, build = (version_line || '1.0.0+1').split('+', 2)

runner.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '14.0'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = ENV.fetch('BCORN_BUNDLE_ID', 'io.bcorn.mobile')
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'Runner/Runner.entitlements'
  config.build_settings['INFOPLIST_FILE'] = 'Runner/Info.plist'
end

widget.build_configurations.each do |config|
  config.build_settings.merge!({
    'APPLICATION_EXTENSION_API_ONLY' => 'YES',
    'CODE_SIGN_STYLE' => 'Automatic',
    'CODE_SIGN_ENTITLEMENTS' => 'TimetableWidgets/TimetableWidgets.entitlements',
    'GENERATE_INFOPLIST_FILE' => 'NO',
    'INFOPLIST_FILE' => 'TimetableWidgets/Info.plist',
    'IPHONEOS_DEPLOYMENT_TARGET' => '14.0',
    'PRODUCT_BUNDLE_IDENTIFIER' => ENV.fetch('BCORN_BUNDLE_ID', 'io.bcorn.mobile') + '.TimetableWidgets',
    'SWIFT_VERSION' => '5.0',
    'SKIP_INSTALL' => 'YES',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'MARKETING_VERSION' => version,
    'CURRENT_PROJECT_VERSION' => build || '1',
    'ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES' => 'NO',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  })
end

unless runner.dependencies.any? { |dependency| dependency.target == widget }
  runner.add_dependency(widget)
end
embed = runner.copy_files_build_phases.find { |phase| phase.name == 'Embed App Extensions' }
embed ||= runner.new_copy_files_build_phase('Embed App Extensions')
embed.dst_subfolder_spec = '13'
embedded = embed.add_file_reference(widget.product_reference, true)
embedded.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

attributes = project.root_object.attributes['TargetAttributes'] ||= {}
[runner, widget].each do |target|
  target_attributes = attributes[target.uuid] ||= {}
  capabilities = target_attributes['SystemCapabilities'] ||= {}
  capabilities['com.apple.ApplicationGroups.iOS'] = { 'enabled' => 1 }
end

# Flutter's "Thin Binary" phase must run after extension embedding. New Xcode
# versions can otherwise report a dependency cycle during bundle assembly.
thin = runner.shell_script_build_phases.find { |phase| phase.name == 'Thin Binary' }
if thin
  runner.build_phases.delete(embed)
  runner.build_phases.insert(runner.build_phases.index(thin), embed)
end

project.save
puts "Configured Runner + TimetableWidgets. Original pbxproj backup: #{backup}"
puts 'Set both signing teams and register the shared App Group in Xcode before device builds.'

/**
 * Makes the release bundle follow the workspace packages the client imports.
 *
 * The client bundles `@minimax-bot/protocol`, which lives outside the app's own source
 * root. Metro watches the whole workspace, so a development build follows the
 * protocol — but the Gradle task that runs Metro decides whether to rebuild the
 * bundle from the app's sources alone. It does not see the protocol package, so a
 * change there leaves the *previous* bundle in the APK.
 *
 * The result is an app built against a contract it was not built with: the release
 * bundle referenced an export the protocol did not have yet, and the app crashed on
 * launch with nothing in the build log to say why.
 *
 * Declaring the protocol package's build output as an input of the bundle task makes
 * the APK follow the workspace.
 */

const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = 'minimax-bot:workspace-bundle-inputs';

const GRADLE = `
// ${MARKER}
// The client bundles workspace packages that live outside the app's source root.
// The bundle task does not track them on its own, so a change in the protocol
// package would otherwise leave the previous bundle in the APK.
def minimaxProtocolDist = rootProject.file("../../../packages/protocol/dist")
tasks.matching { it.name.startsWith("createBundle") && it.name.endsWith("JsAndAssets") }.configureEach {
    if (minimaxProtocolDist.exists()) {
        inputs.dir(minimaxProtocolDist).withPathSensitivity(
            org.gradle.api.tasks.PathSensitivity.RELATIVE
        )
    }
}
`;

module.exports = function withWorkspaceBundleInputs(config) {
  return withAppBuildGradle(config, (gradleConfig) => {
    if (gradleConfig.modResults.language !== 'groovy') {
      return gradleConfig;
    }
    if (gradleConfig.modResults.contents.includes(MARKER)) {
      return gradleConfig;
    }
    gradleConfig.modResults.contents += GRADLE;
    return gradleConfig;
  });
};

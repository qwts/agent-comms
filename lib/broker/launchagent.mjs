// Compatibility exports for the service startup and account isolation seams.
export { LABEL, renderPlist, parseLaunchctlPrint, printPlist, systemLaunchctl, jobOptions, installOptions, install, uninstall, status } from '../platform/service-startup.mjs';
export { assertGroupName, systemGroupId } from '../platform/account-isolation.mjs';

/**
 * Server-level instructions sent to the MCP client on connect. Short — the
 * detailed orientation lives in skills/synology/SKILL.md.
 */

export const SERVER_INSTRUCTIONS = `
Synology DSM NAS management. Read tools (status, packages list / check_updates / info,
security advisor scan, users, firewall, dsm settings, shares, storage health) are safe
to invoke freely. Write tools (nas_package_install / nas_package_uninstall /
nas_package_update) MUST be confirmed with the user explicitly ('yes', literal) before
calling — one package per turn.

Hard refusals (server-side, will reject 4xx-style): updating DSM itself, updating kernel
packages, anything else not in the registered tool list. For findings that suggest
firewall / 2FA / SMB protocol changes, surface them with the DSM UI path; do not call.

Time Machine backup *state* (last success, in-progress, errors) lives on the Mac being
backed up — query via 'tmutil destinationinfo', 'tmutil status', 'tmutil latestbackup'
through your Bash tool. This MCP only reports the NAS-side share configuration.
`;

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

// electron-builder afterPack hook — macOS ad-hoc re-sign.
//
// Why this exists: `mac.identity` is null, so electron-builder skips signing
// entirely ("skipped macOS code signing"). What ships is then the stock Electron
// binary carrying Electron's OWN ad-hoc signature, which means the app's code
// identity is literally `Identifier=Electron` with a CDHash shared by every
// unsigned Electron app on the machine — our application code (app.asar) isn't
// covered by the signature at all.
//
// That matters beyond tidiness: macOS keys TCC grants (Accessibility, Automation —
// both of which quick-paste needs to send Cmd+V) to the requesting app's code
// identity. With no identity of our own, the Privacy panes fill up with
// indistinguishable "CopyBoard" rows and grants attach to the wrong thing.
//
// Re-signing ad-hoc with the real bundle id is free — no certificate, no Apple
// account — and gives the app a stable identity of its own. It is NOT a substitute
// for Developer ID + notarization: an ad-hoc signature still carries no team, so
// Gatekeeper keeps treating the app as unidentified and the CDHash still changes
// whenever the code changes (i.e. every release re-prompts for permissions).
//
// Nested code is signed first (inside-out, as codesign requires), then the outer
// bundle is re-signed on its own so the top-level identifier is the app's and not
// inherited by every helper.
exports.default = async function macAdhocSign(context) {
    if (context.electronPlatformName !== 'darwin') return;

    const appId = context.packager.appInfo.id;
    const appPath = path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`
    );

    const codesign = (args) =>
        execFileSync('/usr/bin/codesign', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    try {
        // 1. Everything, inside-out. --deep is the pragmatic choice for ad-hoc:
        //    it gives helpers and frameworks a valid signature covering our payload.
        codesign(['--force', '--deep', '--sign', '-', appPath]);

        // 2. The outer bundle again, alone, so ONLY it takes the app's identifier
        //    (step 1 would otherwise leave the top level named after the binary).
        codesign(['--force', '--sign', '-', '--identifier', appId, appPath]);

        // `codesign -d` reports on stderr, not stdout — read both.
        const probe = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', appPath], { encoding: 'utf8' });
        const info = `${probe.stdout || ''}${probe.stderr || ''}`;
        const ident = (info.match(/^Identifier=(.*)$/m) || [])[1];
        if (ident !== appId) {
            throw new Error(`expected Identifier=${appId}, got Identifier=${ident}`);
        }
        console.log(`  • ad-hoc signed macOS app  identifier=${appId}`);
    } catch (e) {
        // Fail the build rather than shipping the "Identifier=Electron" bundle again —
        // that regression is invisible in the artifact and only shows up as broken
        // permissions on users' machines.
        const detail = e.stderr ? String(e.stderr).trim() : e.message;
        throw new Error(`macOS ad-hoc signing failed for ${appPath}: ${detail}`);
    }
};
